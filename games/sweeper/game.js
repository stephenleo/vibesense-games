// Sweeper — neon minesweeper, a bundled VibeSense game. Runs while the Claude
// agent executes; freezes the instant it needs you. Input over SSE from the
// vibesense host: left stick glides a cursor cell-by-cell (hold to repeat), R2
// reveals, L2 toggles a flag. The first reveal is always safe — mines land
// after it. Untouched controller hands the board to a constraint-solving
// autopilot (single-cell + subset rules, probabilistic guess when forced) so
// the demo plays itself; the cursor visibly glides between deductions.
// Keyboard fallback (arrows/WASD + space + shift) for development. `?play`
// forces the playing state so the game is testable without a host.

;(() => {
  'use strict'

  // ── Pure grid logic (unit-testable, no I/O) ───────────────────────────
  const COLS = 18
  const ROWS = 12
  const MINES = 36
  const N = COLS * ROWS
  const idx = (x, y) => y * COLS + x

  // Eight-neighbour indices of a cell, clipped to the board.
  function neighbors(x, y) {
    const out = []
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) out.push(idx(nx, ny))
      }
    }
    return out
  }
  // Precompute once — the board never changes shape.
  const NB = Array.from({ length: N }, (_, i) => neighbors(i % COLS, (i / COLS) | 0))

  // Fresh board: N cells, no mines yet (placed on first reveal so it's safe).
  function makeCells() {
    return Array.from({ length: N }, () => ({
      mine: false,
      revealed: false,
      flagged: false,
      boom: false, // a mine that has detonated (loss reveal)
      adj: 0,
      revealAt: 0, // when this cell visually opens (ripple stagger)
    }))
  }

  // Scatter MINES mines, never on the first-clicked cell or its neighbours so
  // the opening reveal floods a region. Then tally each cell's adjacency count.
  function placeMines(cells, safeX, safeY, rng = Math.random) {
    const forbidden = new Set([idx(safeX, safeY), ...NB[idx(safeX, safeY)]])
    let placed = 0
    while (placed < MINES) {
      const i = (rng() * N) | 0
      if (cells[i].mine || forbidden.has(i)) continue
      cells[i].mine = true
      placed++
    }
    for (let i = 0; i < N; i++) {
      cells[i].adj = NB[i].reduce((n, j) => n + (cells[j].mine ? 1 : 0), 0)
    }
  }

  const count = (cells, pred) => cells.reduce((n, c) => n + (pred(c) ? 1 : 0), 0)
  const isWin = (cells) => count(cells, (c) => c.revealed) === N - MINES

  // Constraints for the solver: every revealed number cell that still borders
  // unknown (unrevealed, unflagged) cells → how many mines hide among them.
  function constraints(cells) {
    const cons = []
    for (let i = 0; i < N; i++) {
      const c = cells[i]
      if (!c.revealed || c.adj === 0) continue
      const unknown = []
      let flagged = 0
      for (const j of NB[i]) {
        if (cells[j].flagged) flagged++
        else if (!cells[j].revealed) unknown.push(j)
      }
      if (unknown.length) cons.push({ cells: unknown, mines: c.adj - flagged })
    }
    return cons
  }

  const subset = (a, setB) => a.every((x) => setB.has(x))

  // Deduce certainly-safe and certainly-mine cells. Single-cell rules (a
  // constraint with 0 mines → all safe; with mines == cells → all mines) plus
  // the classic subset rule (A ⊆ B ⇒ B∖A holds B.mines−A.mines mines).
  function deduce(cons) {
    const safe = new Set()
    const mine = new Set()
    for (const con of cons) {
      if (con.mines <= 0) con.cells.forEach((c) => safe.add(c))
      else if (con.mines === con.cells.length) con.cells.forEach((c) => mine.add(c))
    }
    for (let i = 0; i < cons.length; i++) {
      const a = cons[i]
      const setA = new Set(a.cells)
      for (let j = 0; j < cons.length; j++) {
        if (i === j) continue
        const b = cons[j]
        if (b.cells.length <= a.cells.length) continue
        if (!subset(a.cells, new Set(b.cells))) continue
        const diff = b.cells.filter((c) => !setA.has(c))
        const dm = b.mines - a.mines
        if (dm === 0) diff.forEach((c) => safe.add(c))
        else if (dm === diff.length) diff.forEach((c) => mine.add(c))
      }
    }
    return { safe: [...safe].filter((c) => !mine.has(c)), mine: [...mine] }
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

  const ACCENT = '#4dffd2'
  const CELL = 44
  const OFFX = (W - COLS * CELL) / 2 // 4
  const OFFY = 52 // leaves the top strip for the HUD
  const POP_MS = 170 // ripple pop-in duration per cell
  const RIPPLE_STEP = 26 // ms of stagger per flood-fill ring
  const MOVE_REPEAT_MS = 130 // hold-to-repeat cursor step
  const AUTOPILOT_IDLE_MS = 2500
  const AI_STEP_MS = 220 // solver acts about this often
  const RESTART_MS = 2200

  // Neon number tiers, 1..8.
  const NUM_COLORS = ['', '#59d0ff', '#4dffa6', '#ffd24d', '#c77dff', '#ff8a5c', '#5cf5ff', '#ff6ec7', '#ff5c7a']

  let playing = false
  let cells = makeCells()
  let started = false // mines placed yet?
  let startTime = 0
  let gameOver = false
  let win = false
  let gameOverAt = 0
  let particles = [] // {x, y, vx, vy, life, max, color, size}
  let scheduled = [] // deferred bursts {at, px, py, color, n, cell}

  // Cursor: an integer cell for logic, plus a smoothed pixel position that
  // glides toward it (what makes the autopilot mesmerising to watch).
  let cx = COLS >> 1
  let cy = ROWS >> 1
  let dispX = OFFX + cx * CELL + CELL / 2
  let dispY = OFFY + cy * CELL + CELL / 2

  let lastHumanInput = -1e9 // autopilot drives immediately on load
  let axisX = 0
  let axisY = 0
  let moveTimer = 0

  // Autopilot working state.
  let aiTarget = null // {x, y, action:'reveal'|'flag'}
  let aiCooldown = 0

  const cellCenter = (x, y) => ({ x: OFFX + x * CELL + CELL / 2, y: OFFY + y * CELL + CELL / 2 })

  function reset() {
    cells = makeCells()
    started = false
    startTime = 0
    gameOver = false
    win = false
    particles = []
    scheduled = []
    cx = COLS >> 1
    cy = ROWS >> 1
    aiTarget = null
    aiCooldown = 0
  }
  reset()

  // ── Effects ───────────────────────────────────────────────────────────
  function burst(px, py, color, n = 12) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const v = 60 + Math.random() * 180
      const max = 0.35 + Math.random() * 0.4
      particles.push({
        x: px,
        y: py,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: max,
        max,
        color,
        size: 2 + Math.random() * 2.5,
      })
    }
  }

  // ── Board actions ─────────────────────────────────────────────────────
  function reveal(x, y, now) {
    const c = cells[idx(x, y)]
    if (c.revealed || c.flagged) return
    if (!started) {
      placeMines(cells, x, y)
      started = true
      startTime = now
    }
    if (c.mine) return detonate(x, y, now)

    // Flood-fill from the click, staggering each ring's revealAt for a ripple.
    const queue = [{ i: idx(x, y), d: 0 }]
    const seen = new Set([idx(x, y)])
    while (queue.length) {
      const { i, d } = queue.shift()
      const cell = cells[i]
      cell.revealed = true
      cell.revealAt = now + d * RIPPLE_STEP
      if (cell.adj === 0) {
        for (const j of NB[i]) {
          if (seen.has(j)) continue
          const nb = cells[j]
          if (nb.revealed || nb.flagged || nb.mine) continue
          seen.add(j)
          queue.push({ i: j, d: d + 1 })
        }
      }
    }
    if (isWin(cells)) triggerWin(now)
  }

  function toggleFlag(x, y) {
    const c = cells[idx(x, y)]
    if (c.revealed) return
    c.flagged = !c.flagged
  }

  // Loss: mines detonate in a chain, nearest to the trigger first.
  function detonate(hx, hy, now) {
    gameOver = true
    win = false
    gameOverAt = now
    const mines = []
    for (let i = 0; i < N; i++) if (cells[i].mine) mines.push(i)
    mines.sort((a, b) => {
      const da = Math.hypot((a % COLS) - hx, ((a / COLS) | 0) - hy)
      const db = Math.hypot((b % COLS) - hx, ((b / COLS) | 0) - hy)
      return da - db
    })
    mines.forEach((i, k) => {
      const p = cellCenter(i % COLS, (i / COLS) | 0)
      scheduled.push({ at: now + k * 70, px: p.x, py: p.y, color: '#ff4d6d', n: 16, cell: i })
    })
  }

  // Win: a sparkle sweep rolls across the board.
  function triggerWin(now) {
    gameOver = true
    win = true
    gameOverAt = now
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const p = cellCenter(x, y)
        scheduled.push({ at: now + (x + y) * 32, px: p.x, py: p.y, color: ACCENT, n: 5, cell: -1 })
      }
    }
  }

  // ── Input: SSE from the vibesense host ────────────────────────────────
  function moveCursor(dx, dy) {
    cx = Math.max(0, Math.min(COLS - 1, cx + dx))
    cy = Math.max(0, Math.min(ROWS - 1, cy + dy))
    lastHumanInput = performance.now()
    aiTarget = null
  }

  function humanReveal(now) {
    lastHumanInput = now
    aiTarget = null
    if (gameOver) return reset()
    reveal(cx, cy, now)
  }

  function humanFlag(now) {
    lastHumanInput = now
    aiTarget = null
    if (gameOver) return reset()
    toggleFlag(cx, cy)
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
      if (msg.kind === 'axis') {
        // Discrete stick: past the deadzone steps once, and hold repeats.
        if (msg.axis === 'left_x') {
          const v = Math.abs(msg.value) > 0.45 ? Math.sign(msg.value) : 0
          if (v !== axisX) {
            axisX = v
            if (v) {
              moveCursor(v, 0)
              moveTimer = MOVE_REPEAT_MS / 1000
            }
          }
        } else if (msg.axis === 'left_y') {
          const v = Math.abs(msg.value) > 0.45 ? Math.sign(msg.value) : 0
          if (v !== axisY) {
            axisY = v
            if (v) {
              moveCursor(0, v)
              moveTimer = MOVE_REPEAT_MS / 1000
            }
          }
        }
      } else if (msg.kind === 'button' && msg.pressed) {
        if (msg.button === 'r2') humanReveal(performance.now())
        else if (msg.button === 'l2') humanFlag(performance.now())
      }
    } else if (msg.type === 'reload') {
      location.href = msg.url // controller swapped games — load the new one
    }
  }
  events.onerror = () => setStatus('host disconnected — is vibesense running?', false)

  // Keyboard fallback for development (arrows/WASD → stick, Space → R2, Shift → L2).
  addEventListener('keydown', (e) => {
    const now = performance.now()
    const k = e.key
    if (k === 'ArrowUp' || k === 'w' || k === 'W') moveCursor(0, -1)
    else if (k === 'ArrowDown' || k === 's' || k === 'S') moveCursor(0, 1)
    else if (k === 'ArrowLeft' || k === 'a' || k === 'A') moveCursor(-1, 0)
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') moveCursor(1, 0)
    else if (k === ' ') humanReveal(now)
    else if (k === 'Shift') humanFlag(now)
    else return
    e.preventDefault()
  })

  function setPlaying(next) {
    playing = next
    setStatus(
      playing ? 'agent executing — sweep the field!' : 'claude needs you — controller is on the terminal',
      playing,
    )
  }

  function setStatus(text, isPlaying) {
    statusEl.textContent = text
    statusEl.className = isPlaying ? 'playing' : ''
  }

  // Dev affordance: `?play` runs the game without a host.
  if (location.search.includes('play')) setPlaying(true)

  // ── Autopilot ─────────────────────────────────────────────────────────
  // Pick the next action: a certain flag or reveal nearest the cursor, else a
  // lowest-probability guess. ponytail: naive per-constraint probability with a
  // global-density fallback — plenty to look expert; a full CSP would be
  // overkill for a demo that just needs to keep sweeping.
  function chooseAction() {
    const { safe, mine } = deduce(constraints(cells))
    const cands = []
    for (const i of mine) if (!cells[i].flagged) cands.push({ i, action: 'flag' })
    for (const i of safe) if (!cells[i].revealed && !cells[i].flagged) cands.push({ i, action: 'reveal' })
    if (cands.length) {
      cands.sort((a, b) => dist(a.i) - dist(b.i))
      return toTarget(cands[0])
    }
    return guess()
  }

  const dist = (i) => Math.abs((i % COLS) - cx) + Math.abs(((i / COLS) | 0) - cy)
  const toTarget = (a) => ({ x: a.i % COLS, y: (a.i / COLS) | 0, action: a.action })

  function guess() {
    const unknown = []
    for (let i = 0; i < N; i++) if (!cells[i].revealed && !cells[i].flagged) unknown.push(i)
    if (!unknown.length) return null
    const flags = count(cells, (c) => c.flagged)
    const density = (MINES - flags) / unknown.length
    const prob = new Map()
    for (const con of constraints(cells)) {
      const p = con.mines / con.cells.length
      for (const c of con.cells) prob.set(c, Math.min(prob.has(c) ? prob.get(c) : 1, p))
    }
    let best = null
    let bestP = Infinity
    for (const i of unknown) {
      const p = prob.has(i) ? prob.get(i) : density
      if (p < bestP - 1e-9 || (Math.abs(p - bestP) < 1e-9 && best !== null && dist(i) < dist(best))) {
        bestP = p
        best = i
      }
    }
    return toTarget({ i: best, action: 'reveal' })
  }

  function aiStep(now, dt) {
    if (!aiTarget && aiCooldown <= 0) aiTarget = chooseAction()
    if (aiTarget) {
      cx = aiTarget.x
      cy = aiTarget.y
      const c = cellCenter(aiTarget.x, aiTarget.y)
      const arrived = Math.hypot(dispX - c.x, dispY - c.y) < 3
      if (arrived && aiCooldown <= 0) {
        if (aiTarget.action === 'flag') toggleFlag(aiTarget.x, aiTarget.y)
        else reveal(aiTarget.x, aiTarget.y, now)
        aiTarget = null
        aiCooldown = AI_STEP_MS / 1000
      }
    }
    aiCooldown -= dt
  }

  // ── Simulation ────────────────────────────────────────────────────────
  function tick(now, dt) {
    // Fire any due scheduled bursts (loss chain / win sparkle sweep).
    scheduled = scheduled.filter((s) => {
      if (now < s.at) return true
      burst(s.px, s.py, s.color, s.n)
      if (s.cell >= 0) {
        cells[s.cell].revealed = true
        cells[s.cell].boom = true
        cells[s.cell].revealAt = now
      }
      return false
    })

    for (const p of particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vx *= 0.94
      p.vy *= 0.94
      p.life -= dt
    }
    particles = particles.filter((p) => p.life > 0)

    if (!gameOver) {
      const idle = now - lastHumanInput > AUTOPILOT_IDLE_MS
      if (idle) {
        aiStep(now, dt)
      } else {
        // Human hold-to-repeat while the stick stays deflected.
        if (axisX || axisY) {
          moveTimer -= dt
          if (moveTimer <= 0) {
            moveCursor(axisX, axisY)
            moveTimer = MOVE_REPEAT_MS / 1000
          }
        }
      }
    }

    // Cursor always eases toward its target cell.
    const c = cellCenter(cx, cy)
    const k = Math.min(1, dt * 14)
    dispX += (c.x - dispX) * k
    dispY += (c.y - dispY) * k
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

  function drawCovered(x, y, cell) {
    const px = OFFX + x * CELL
    const py = OFFY + y * CELL
    const g = ctx.createLinearGradient(px, py, px, py + CELL)
    g.addColorStop(0, 'rgba(48, 92, 96, 0.55)')
    g.addColorStop(1, 'rgba(16, 34, 40, 0.55)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.roundRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3, 6)
    ctx.fill()
    // Top highlight for a raised feel.
    ctx.strokeStyle = 'rgba(120, 230, 210, 0.14)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(px + 5, py + 4)
    ctx.lineTo(px + CELL - 5, py + 4)
    ctx.stroke()
    if (cell.flagged) drawFlag(px + CELL / 2, py + CELL / 2)
  }

  function drawFlag(x, y) {
    ctx.save()
    ctx.shadowColor = '#ffcf4d'
    ctx.shadowBlur = 10
    ctx.strokeStyle = 'rgba(220, 235, 255, 0.6)'
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.moveTo(x - 5, y + 9)
    ctx.lineTo(x - 5, y - 9)
    ctx.stroke()
    ctx.fillStyle = '#ffcf4d'
    ctx.beginPath()
    ctx.moveTo(x - 5, y - 9)
    ctx.lineTo(x + 7, y - 4)
    ctx.lineTo(x - 5, y + 1)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  function drawMine(x, y, pop) {
    const r = 8 * pop
    ctx.save()
    ctx.shadowColor = '#ff4d6d'
    ctx.shadowBlur = 16
    ctx.fillStyle = '#ff4d6d'
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#ffb3c2'
    ctx.lineWidth = 1.6
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
      ctx.beginPath()
      ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r)
      ctx.lineTo(x + Math.cos(a) * (r + 4), y + Math.sin(a) * (r + 4))
      ctx.stroke()
    }
    ctx.restore()
  }

  function drawRevealed(x, y, cell, now) {
    const px = OFFX + x * CELL
    const py = OFFY + y * CELL
    const pop = Math.max(0, Math.min(1, (now - cell.revealAt) / POP_MS))
    // Sunken pit.
    ctx.fillStyle = cell.boom ? 'rgba(60, 12, 20, 0.7)' : 'rgba(8, 16, 22, 0.55)'
    ctx.beginPath()
    ctx.roundRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3, 6)
    ctx.fill()
    ctx.strokeStyle = 'rgba(120, 230, 210, 0.06)'
    ctx.lineWidth = 1
    ctx.stroke()

    const mx = px + CELL / 2
    const my = py + CELL / 2
    if (cell.boom) return drawMine(mx, my, pop)
    if (cell.adj > 0) {
      ctx.save()
      ctx.globalAlpha = pop
      ctx.fillStyle = NUM_COLORS[cell.adj]
      ctx.shadowColor = NUM_COLORS[cell.adj]
      ctx.shadowBlur = 8
      ctx.font = `700 ${Math.round(22 * (0.6 + 0.4 * pop))}px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(cell.adj), mx, my + 1)
      ctx.restore()
    }
  }

  function drawCursor(now) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 220)
    ctx.save()
    ctx.shadowColor = ACCENT
    ctx.shadowBlur = 12 + pulse * 8
    ctx.strokeStyle = ACCENT
    ctx.globalAlpha = 0.65 + 0.35 * pulse
    ctx.lineWidth = 2.2
    ctx.beginPath()
    ctx.roundRect(dispX - CELL / 2 + 2, dispY - CELL / 2 + 2, CELL - 4, CELL - 4, 6)
    ctx.stroke()
    ctx.restore()
  }

  function drawHud(now) {
    const flags = count(cells, (c) => c.flagged)
    const remaining = MINES - flags
    const secs = started ? Math.min(999, Math.floor((now - startTime) / 1000)) : 0
    ctx.fillStyle = '#8fa3c0'
    ctx.font = `600 13px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText('MINES', 16, 20)
    ctx.textAlign = 'right'
    ctx.fillText('TIME', W - 16, 20)
    ctx.fillStyle = '#eaf2ff'
    ctx.font = `700 18px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText(String(remaining).padStart(2, '0'), 16, 40)
    ctx.textAlign = 'right'
    ctx.fillText(String(secs).padStart(3, '0'), W - 16, 40)
  }

  function overlay(title, sub, color) {
    ctx.fillStyle = 'rgba(3, 5, 14, 0.72)'
    ctx.fillRect(0, 0, W, H)
    const cw = 460
    const ch = 160
    const ox = (W - cw) / 2
    const oy = (H - ch) / 2
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 30
    ctx.fillStyle = 'rgba(9, 13, 28, 0.95)'
    ctx.beginPath()
    ctx.roundRect(ox, oy, cw, ch, 14)
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.5
    ctx.stroke()
    ctx.restore()
    ctx.textAlign = 'center'
    ctx.fillStyle = color
    ctx.font = `700 34px ${FONT}`
    ctx.fillText(title, W / 2, oy + 70)
    ctx.fillStyle = '#8fa3c0'
    ctx.font = `500 14px ${FONT}`
    ctx.fillText(sub, W / 2, oy + ch - 34)
  }

  function render(now) {
    ctx.clearRect(0, 0, W, H)

    // Board frame.
    ctx.strokeStyle = 'rgba(120, 230, 210, 0.1)'
    ctx.lineWidth = 1
    ctx.strokeRect(OFFX - 4, OFFY - 4, COLS * CELL + 8, ROWS * CELL + 8)

    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const cell = cells[idx(x, y)]
        if (cell.revealed && now >= cell.revealAt) drawRevealed(x, y, cell, now)
        else drawCovered(x, y, cell)
      }
    }

    if (!gameOver) drawCursor(now)

    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max)
      ctx.fillStyle = p.color
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
    }
    ctx.globalAlpha = 1

    drawHud(now)

    if (gameOver && win) overlay('SWEPT', 'field cleared — restarting…', ACCENT)
    else if (gameOver) overlay('DETONATED', 'restarting…', '#ff4d6d')
    else if (!playing) overlay('PAUSED', 'claude needs you — answer in the terminal', ACCENT)
  }

  // ── Main loop ─────────────────────────────────────────────────────────
  let last = performance.now()
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (gameOver && now - gameOverAt > RESTART_MS && scheduled.length === 0) reset()
    if (playing) tick(now, dt)
    render(now)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // ── Self-test: `?selftest` runs the pure logic and asserts. ────────────
  function selftest() {
    const ok = (cond, msg) => {
      if (!cond) throw new Error('selftest failed: ' + msg)
    }
    ok(NB[idx(0, 0)].length === 3, 'corner has 3 neighbours')
    ok(NB[idx(1, 1)].length === 8, 'interior has 8 neighbours')

    // First reveal is always safe and clears its neighbourhood of mines.
    const cells = makeCells()
    placeMines(cells, 5, 5)
    ok(count(cells, (c) => c.mine) === MINES, 'exactly MINES mines placed')
    ok(!cells[idx(5, 5)].mine, 'first cell is never a mine')
    ok(NB[idx(5, 5)].every((j) => !cells[j].mine), 'first cell neighbourhood is clear')
    ok(cells[idx(5, 5)].adj === 0, 'safe opening cell counts zero adjacent')

    // Single-cell deductions.
    const d1 = deduce([{ cells: [1, 2, 3], mines: 0 }])
    ok(d1.safe.length === 3 && d1.mine.length === 0, 'zero-mine constraint is all safe')
    const d2 = deduce([{ cells: [1, 2], mines: 2 }])
    ok(d2.mine.length === 2 && d2.safe.length === 0, 'full constraint is all mines')

    // Subset rule: {1,2}=1 ⊆ {1,2,3}=1 ⇒ cell 3 is safe.
    const d3 = deduce([
      { cells: [1, 2], mines: 1 },
      { cells: [1, 2, 3], mines: 1 },
    ])
    ok(d3.safe.includes(3), 'subset rule finds the safe cell')
    // {1,2}=1 ⊆ {1,2,3}=2 ⇒ cell 3 is a mine.
    const d4 = deduce([
      { cells: [1, 2], mines: 1 },
      { cells: [1, 2, 3], mines: 2 },
    ])
    ok(d4.mine.includes(3), 'subset rule finds the mine cell')

    console.log('[sweeper] selftest passed')
    document.getElementById('status').textContent = 'selftest passed ✓'
  }
})()
