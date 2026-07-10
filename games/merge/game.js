// Merge — a bundled VibeSense game (2048-style slide puzzle). Runs while the
// Claude agent executes; freezes the instant it needs you. Input arrives over
// SSE from the vibesense host: the left stick is a flick control — push it past
// a threshold and every tile slides that way; equal tiles merge and double.
// One flick = one move (the stick must return near center to re-arm). R2/L2
// restart after a game over. When nobody touches the controller, a corner-
// strategy autopilot keeps merging so the demo climbs to big glowing tiles.
// Keyboard fallback (arrows/WASD → flick, Space → R2, Shift → L2) for dev.
// `?play` forces the playing state so the game is testable without a host.

;(() => {
  'use strict'

  // ── Pure board logic (unit-testable, no I/O) ──────────────────────────
  const N = 4
  const VEC = {
    up: [-1, 0],
    down: [1, 0],
    left: [0, -1],
    right: [0, 1],
  }
  const inB = (r, c) => r >= 0 && r < N && c >= 0 && c < N
  const empty = () => Array.from({ length: N }, () => new Array(N).fill(0))

  // Slide every tile toward `dir`, merging equal neighbours (once each). Returns
  // the new board plus per-tile slide records for animation: each surviving tile
  // gets one {from,to} (with pop:true if it just doubled) and each absorbed tile
  // gets a {from,to,ghost:true} that fades into the merge cell.
  function applyMove(board, dir) {
    const [dr, dc] = VEC[dir]
    const rows = [0, 1, 2, 3]
    const cols = [0, 1, 2, 3]
    if (dr === 1) rows.reverse() // process the leading edge first
    if (dc === 1) cols.reverse()

    const g = board.map((row, r) =>
      row.map((v, c) => (v ? { value: v, orig: v, from: { r, c }, merged: false } : null)),
    )
    const slides = []
    let gained = 0
    let moved = false

    for (const r of rows) {
      for (const c of cols) {
        const tok = g[r][c]
        if (!tok) continue
        // Walk as far as the empty run allows; `nr,nc` lands on the blocker.
        let pr = r
        let pc = c
        let nr = r + dr
        let nc = c + dc
        while (inB(nr, nc) && !g[nr][nc]) {
          pr = nr
          pc = nc
          nr += dr
          nc += dc
        }
        const tgt = inB(nr, nc) ? g[nr][nc] : null
        if (tgt && tgt.value === tok.value && !tgt.merged) {
          g[r][c] = null
          tgt.value *= 2
          tgt.merged = true
          gained += tgt.value
          moved = true
          slides.push({ orig: tok.orig, from: tok.from, to: { r: nr, c: nc }, ghost: true })
        } else if (pr !== r || pc !== c) {
          g[r][c] = null
          g[pr][pc] = tok
          moved = true
        }
      }
    }

    const nb = empty()
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const tok = g[r][c]
        if (tok) {
          nb[r][c] = tok.value
          slides.push({ orig: tok.orig, from: tok.from, to: { r, c }, pop: tok.merged })
        }
      }
    }
    return { board: nb, moved, gained, slides }
  }

  function emptyCells(board) {
    const out = []
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (!board[r][c]) out.push({ r, c })
    return out
  }

  function isGameOver(board) {
    if (emptyCells(board).length) return false
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const v = board[r][c]
        if ((inB(r + 1, c) && board[r + 1][c] === v) || (inB(r, c + 1) && board[r][c + 1] === v)) {
          return false
        }
      }
    }
    return true
  }

  // ── Autopilot: one-ply best move under a corner-gradient heuristic ────
  // A snake-shaped weight matrix pins the big tile to a corner; extra credit for
  // empty cells keeps room to manoeuvre. Simple, but it reliably climbs to
  // 256/512 in a demo — upgrade to expectimax only if that stops impressing.
  const WEIGHTS = [
    [15, 14, 13, 12],
    [8, 9, 10, 11],
    [7, 6, 5, 4],
    [0, 1, 2, 3],
  ]

  function heuristic(board) {
    let score = 0
    let empties = 0
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const v = board[r][c]
        if (!v) empties++
        else score += WEIGHTS[r][c] * Math.log2(v)
      }
    }
    return score + empties * 2.7
  }

  function bestMove(board) {
    let best = null
    let bestScore = -Infinity
    for (const dir of ['down', 'left', 'right', 'up']) {
      const res = applyMove(board, dir)
      if (!res.moved) continue
      // Small nudge for the gain so ties break toward actually merging.
      const s = heuristic(res.board) + res.gained * 0.05
      if (s > bestScore) {
        bestScore = s
        best = dir
      }
    }
    return best
  }

  if (location.search.includes('selftest')) return selftest()

  // ── Setup ─────────────────────────────────────────────────────────────
  const canvas = document.getElementById('game')
  const ctx = canvas.getContext('2d')
  const statusEl = document.getElementById('status')

  const W = 800
  const H = 600
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = W * dpr
  canvas.height = H * dpr
  ctx.scale(dpr, dpr)

  const PAD = 12
  const TILE = 95
  const BOARD = PAD * (N + 1) + TILE * N // 440
  const BX = (W - BOARD) / 2 // 180
  const BY = 118
  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

  const SLIDE_S = 0.12
  const POP_S = 0.16
  const SPAWN_S = 0.14
  const AUTO_S = 0.32 // one autopilot move every ~320ms
  const AUTOPILOT_IDLE_MS = 2500 // hand back to the AI this long after a human touch
  const RESTART_MS = 2000

  let playing = false
  let board = empty()
  let score = 0
  let best = 0
  let anim = null // { slideT, popT, spawnT, slides, spawn, popSet }
  let gameOver = false
  let gameOverAt = 0
  let lastHumanInput = -1e9 // start in autopilot so ?play demos are lively at once
  let autoAcc = 0
  let armX = true
  let armY = true

  function spawnRandom() {
    const cells = emptyCells(board)
    if (!cells.length) return null
    const cell = cells[(Math.random() * cells.length) | 0]
    const value = Math.random() < 0.9 ? 2 : 4
    board[cell.r][cell.c] = value
    return { r: cell.r, c: cell.c, value }
  }

  function reset() {
    board = empty()
    score = 0
    gameOver = false
    anim = null
    autoAcc = 0
    spawnRandom()
    spawnRandom()
  }
  reset()

  const busy = () => anim !== null && anim.slideT < 1

  function doMove(dir) {
    if (gameOver || busy()) return false
    const res = applyMove(board, dir)
    if (!res.moved) return false
    board = res.board
    score += res.gained
    if (score > best) best = score
    const popSet = new Set(res.slides.filter((s) => s.pop).map((s) => s.to.r * N + s.to.c))
    const spawn = spawnRandom()
    anim = { slideT: 0, popT: 0, spawnT: 0, slides: res.slides, spawn, popSet }
    if (isGameOver(board)) {
      gameOver = true
      gameOverAt = performance.now()
    }
    return true
  }

  // ── Input: SSE from the vibesense host ────────────────────────────────
  function humanMove(dir) {
    lastHumanInput = performance.now()
    doMove(dir)
  }

  // Left stick as a flick: fire once past the threshold, re-arm near center.
  function onAxis(axis, value) {
    const a = Math.abs(value)
    if (axis === 'left_x') {
      if (a < 0.3) armX = true
      else if (armX && a > 0.6) {
        armX = false
        humanMove(value > 0 ? 'right' : 'left')
      }
    } else if (axis === 'left_y') {
      if (a < 0.3) armY = true
      else if (armY && a > 0.6) {
        armY = false
        humanMove(value > 0 ? 'down' : 'up')
      }
    }
  }

  function onButton() {
    lastHumanInput = performance.now()
    if (gameOver) reset()
  }

  const events = new EventSource('/events')
  events.onmessage = (e) => {
    let msg
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }
    if (msg.type === 'state') {
      setPlaying(msg.state === 'playing')
    } else if (msg.type === 'input') {
      if (msg.kind === 'axis') onAxis(msg.axis, msg.value)
      else if (msg.kind === 'button' && (msg.button === 'r2' || msg.button === 'l2') && msg.pressed) {
        onButton()
      }
    } else if (msg.type === 'reload') {
      location.href = msg.url // controller swapped games — load the new one
    }
  }
  events.onerror = () => setStatus('host disconnected — is vibesense running?', false)

  // Keyboard fallback for development.
  addEventListener('keydown', (e) => {
    const map = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      w: 'up',
      s: 'down',
      a: 'left',
      d: 'right',
    }
    if (map[e.key] && !e.repeat) humanMove(map[e.key])
    if (e.key === ' ' || e.key === 'Shift') onButton()
  })

  function setPlaying(next) {
    playing = next
    setStatus(
      playing
        ? 'agent executing — flick to merge!'
        : 'claude needs you — controller is on the terminal',
      playing,
    )
  }

  function setStatus(text, isPlaying) {
    statusEl.textContent = text
    statusEl.className = isPlaying ? 'playing' : ''
  }

  // Dev affordance: `?play` runs the game without a host.
  if (location.search.includes('play')) setPlaying(true)

  // ── Colours: escalating neon + glow per tile tier ─────────────────────
  const TIER = {
    2: '#3a2f63',
    4: '#4a3a86',
    8: '#5e3fb0',
    16: '#7b4fe0',
    32: '#9560ff',
    64: '#b48cff',
    128: '#c77dff',
    256: '#d65cff',
    512: '#ff5ce0',
    1024: '#ff5c9a',
    2048: '#ff7a5c',
    4096: '#ffd166',
    8192: '#7dffce',
  }
  const tierColor = (v) => TIER[v] || '#7dffce'
  const tierBlur = (v) => Math.min(34, 2 + (Math.log2(v) - 1) * 3)
  const tierText = (v) => (v >= 256 ? '#26123f' : '#efe6ff')
  const fontFor = (v) => {
    const len = String(v).length
    return len <= 1 ? 46 : len === 2 ? 42 : len === 3 ? 34 : 27
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  const easeOut = (t) => 1 - (1 - t) * (1 - t)
  const cellXY = (r, c) => ({
    x: BX + PAD + c * (TILE + PAD) + TILE / 2,
    y: BY + PAD + r * (TILE + PAD) + TILE / 2,
  })
  const lerp = (a, b, t) => a + (b - a) * t

  function roundRectPath(x, y, w, h, rad) {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, rad)
  }

  function drawBackboard(now) {
    const glow = 0.5 + 0.5 * Math.sin(now / 900)
    ctx.save()
    ctx.shadowColor = 'rgba(180, 140, 255, 0.5)'
    ctx.shadowBlur = 24 + glow * 10
    ctx.fillStyle = 'rgba(24, 17, 46, 0.9)'
    roundRectPath(BX, BY, BOARD, BOARD, 16)
    ctx.fill()
    ctx.restore()
    ctx.strokeStyle = 'rgba(180, 140, 255, 0.18)'
    roundRectPath(BX, BY, BOARD, BOARD, 16)
    ctx.stroke()

    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const { x, y } = cellXY(r, c)
        ctx.fillStyle = 'rgba(180, 140, 255, 0.06)'
        roundRectPath(x - TILE / 2, y - TILE / 2, TILE, TILE, 10)
        ctx.fill()
      }
    }
  }

  function drawTile(cx, cy, value, scale, alpha) {
    const s = TILE * scale
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.shadowColor = tierColor(value)
    ctx.shadowBlur = tierBlur(value)
    const grad = ctx.createLinearGradient(0, cy - s / 2, 0, cy + s / 2)
    const base = tierColor(value)
    grad.addColorStop(0, base)
    grad.addColorStop(1, base)
    ctx.fillStyle = grad
    roundRectPath(cx - s / 2, cy - s / 2, s, s, 10)
    ctx.fill()
    // soft top highlight for a bit of depth
    ctx.shadowBlur = 0
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
    roundRectPath(cx - s / 2, cy - s / 2, s, s * 0.42, 10)
    ctx.fill()
    ctx.restore()

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = tierText(value)
    ctx.font = `700 ${fontFor(value) * scale}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(value), cx, cy + 1)
    ctx.restore()
    ctx.textBaseline = 'alphabetic'
  }

  function drawTiles() {
    if (anim && anim.slideT < 1) {
      // Slide phase: draw every tile en route at its pre-merge value; the
      // absorbed ghosts fade out as they reach the merge cell.
      const t = easeOut(anim.slideT)
      for (const s of anim.slides) {
        const a = cellXY(s.from.r, s.from.c)
        const b = cellXY(s.to.r, s.to.c)
        const alpha = s.ghost ? 1 - easeOut(Math.max(0, anim.slideT - 0.6) / 0.4) : 1
        drawTile(lerp(a.x, b.x, t), lerp(a.y, b.y, t), s.orig, 1, alpha)
      }
      return
    }
    // Settled: draw the board, with pop bumps and the fresh spawn scaling in.
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const v = board[r][c]
        if (!v) continue
        const { x, y } = cellXY(r, c)
        let scale = 1
        if (anim) {
          if (anim.popSet.has(r * N + c) && anim.popT < 1) {
            scale = 1 + 0.16 * Math.sin(anim.popT * Math.PI)
          }
          if (anim.spawn && anim.spawn.r === r && anim.spawn.c === c && anim.spawnT < 1) {
            scale = 0.3 + 0.7 * easeOut(anim.spawnT)
          }
        }
        drawTile(x, y, v, scale, 1)
      }
    }
  }

  function panel(x, y, w, label, val) {
    ctx.fillStyle = 'rgba(24, 17, 46, 0.7)'
    ctx.strokeStyle = 'rgba(180, 140, 255, 0.18)'
    roundRectPath(x, y, w, 54, 10)
    ctx.fill()
    ctx.stroke()
    ctx.textAlign = 'center'
    ctx.fillStyle = '#a99cc9'
    ctx.font = `600 11px ${FONT}`
    ctx.fillText(label, x + w / 2, y + 20)
    ctx.fillStyle = '#f3ecff'
    ctx.font = `700 22px ${FONT}`
    ctx.fillText(String(val), x + w / 2, y + 44)
  }

  function drawHud() {
    panel(BX, 44, 200, 'SCORE', score)
    panel(BX + BOARD - 200, 44, 200, 'BEST', best)
  }

  function overlay(title, sub, color) {
    ctx.fillStyle = 'rgba(6, 4, 14, 0.78)'
    ctx.fillRect(0, 0, W, H)
    const cw = 460
    const ch = 170
    const cx = (W - cw) / 2
    const cy = (H - ch) / 2
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 30
    ctx.fillStyle = 'rgba(16, 11, 30, 0.96)'
    roundRectPath(cx, cy, cw, ch, 14)
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.5
    ctx.stroke()
    ctx.restore()

    ctx.textAlign = 'center'
    ctx.fillStyle = color
    ctx.font = `700 34px ${FONT}`
    ctx.fillText(title, W / 2, cy + 78)
    ctx.fillStyle = '#a99cc9'
    ctx.font = `500 14px ${FONT}`
    ctx.fillText(sub, W / 2, cy + ch - 34)
  }

  function render(now) {
    ctx.clearRect(0, 0, W, H)
    drawBackboard(now)
    drawTiles()
    drawHud()
    if (gameOver) overlay('GAME OVER', `score ${score} · restarting…`, '#ff5c9a')
    else if (!playing) overlay('PAUSED', 'claude needs you — answer in the terminal', '#b48cff')
  }

  // ── Main loop ─────────────────────────────────────────────────────────
  let last = performance.now()
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now

    if (gameOver && now - gameOverAt > RESTART_MS) reset()

    if (playing) {
      if (anim) {
        if (anim.slideT < 1) anim.slideT = Math.min(1, anim.slideT + dt / SLIDE_S)
        else {
          anim.popT = Math.min(1, anim.popT + dt / POP_S)
          anim.spawnT = Math.min(1, anim.spawnT + dt / SPAWN_S)
        }
        if (anim.slideT >= 1 && anim.popT >= 1 && anim.spawnT >= 1) anim = null
      }
      if (!gameOver && !busy()) {
        autoAcc += dt
        const idle = now - lastHumanInput > AUTOPILOT_IDLE_MS
        if (idle && autoAcc >= AUTO_S) {
          autoAcc = 0
          const dir = bestMove(board)
          if (dir) doMove(dir)
        }
      }
    }

    render(now)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // ── Self-test: `?selftest` runs the pure logic and asserts. ────────────
  function selftest() {
    const ok = (cond, msg) => {
      if (!cond) throw new Error('selftest failed: ' + msg)
    }
    const fromRow = (row) => [row.slice(), [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
    const rowAfter = (row, dir) => applyMove(fromRow(row), dir).board[0]
    const eq = (a, b) => a.every((v, i) => v === b[i])

    ok(eq(rowAfter([2, 2, 0, 0], 'left'), [4, 0, 0, 0]), '2+2 merges left')
    ok(eq(rowAfter([2, 0, 2, 4], 'left'), [4, 4, 0, 0]), 'gap collapses then merges')
    ok(eq(rowAfter([2, 2, 2, 2], 'left'), [4, 4, 0, 0]), 'four merge into two pairs')
    ok(eq(rowAfter([2, 2, 4, 0], 'right'), [0, 0, 4, 4]), 'merges toward the right edge')
    ok(applyMove(fromRow([2, 4, 8, 16]), 'left').gained === 0, 'no gain when nothing merges')
    ok(!applyMove(fromRow([2, 4, 8, 16]), 'left').moved, 'no move when nothing slides')
    ok(applyMove(fromRow([2, 2, 0, 0]), 'left').gained === 4, 'gain equals the merged value')

    const full = [
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]
    ok(isGameOver(full), 'checkerboard full board is game over')
    full[0][0] = 4 // now (0,0)==(1,0)
    ok(!isGameOver(full), 'a mergeable neighbour means not over')

    // Autopilot always returns a legal, board-changing move when one exists.
    const dir = bestMove([
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ])
    ok(
      dir &&
        applyMove(
          [
            [2, 2, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
          ],
          dir,
        ).moved,
      'autopilot picks a real move',
    )

    console.log('[merge] selftest passed')
    document.getElementById('status').textContent = 'selftest passed ✓'
  }
})()
