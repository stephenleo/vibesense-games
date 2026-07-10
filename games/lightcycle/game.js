// Lightcycle — bundled VibeSense game. Runs while the Claude agent executes;
// freezes when it needs you. You + 3 AI cycles carve glowing light-walls across
// a grid arena; touch any wall and you crash. Input over SSE from the vibesense
// host: left stick flicks a 90° turn (re-arm at center), R2 = speed boost off a
// recharging meter, L2 = brake. Last cycle alive takes the round. An untouched
// controller hands your cycle to a survival autopilot (wall lookahead + a
// flood-fill space heuristic) so the demo keeps racing through long agent runs.
// Keyboard fallback (arrows/WASD + space + shift) for development. `?play`
// forces the playing state so the game is testable without a host.

;(() => {
  'use strict'

  // ── Pure grid logic (unit-testable, no I/O) ───────────────────────────
  const COLS = 100
  const ROWS = 75
  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  }
  const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' }
  // Clockwise ring — turn(dir, +1) is a right (CW) 90°, -1 is a left (CCW) 90°.
  const CW = ['up', 'right', 'down', 'left']
  const turn = (dir, rel) => (rel === 0 ? dir : CW[(CW.indexOf(dir) + rel + 4) % 4])

  // Reachable open cells from (sx, sy), counting the start, capped at `cap`.
  // `free(x, y)` reports whether a cell is on-board and unoccupied. This is the
  // autopilot's "how much room does this move leave me?" score — bigger is safer.
  function floodFill(free, sx, sy, cap) {
    if (!free(sx, sy)) return 0
    const seen = new Set([sx + ',' + sy])
    const q = [[sx, sy]]
    let head = 0
    let n = 0
    while (head < q.length && n < cap) {
      const [x, y] = q[head++]
      n++
      for (const k in DIRS) {
        const nx = x + DIRS[k].x
        const ny = y + DIRS[k].y
        const key = nx + ',' + ny
        if (!seen.has(key) && free(nx, ny)) {
          seen.add(key)
          q.push([nx, ny])
        }
      }
    }
    return n
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
  const CELL = W / COLS // 8px logical; arena is 100×75 cells

  const STEP_MS = 62 // base ms per grid cell
  const BOOST_MS = 34 // speed boost
  const BRAKE_MS = 110 // L2 brake
  const DRAIN = 0.8 // boost meter units drained per second while boosting
  const RECHARGE = 0.34 // meter units regained per second otherwise
  const AUTOPILOT_IDLE_MS = 2500
  const WIN_TARGET = 5 // first to this many round wins resets the match

  // Cycle 0 is the human/hero; 1–3 are always AI. Distinct bloom colors.
  const COLORS = ['#5e8bff', '#ff8c42', '#43e08a', '#ff5e9c']
  const NAMES = ['YOU', 'RED', 'GRN', 'PNK']

  // grid[y*COLS + x] = 0 empty, else (cycle index + 1). Fast collision test.
  const grid = new Uint8Array(COLS * ROWS)
  const isFree = (x, y) => x >= 0 && x < COLS && y >= 0 && y < ROWS && grid[y * COLS + x] === 0

  let playing = false
  let cycles = []
  let particles = [] // {x, y, vx, vy, life, max, color}
  let round = 1
  let roundOver = false
  let roundOverAt = 0
  let winner = null // cycle object, or null on a mutual crash
  let lastHumanInput = -Infinity // no human yet → autopilot drives from frame one
  let humanBoost = false
  let humanBrake = false
  let armed = true // stick returned to center → next flick is allowed
  let sx = 0
  let sy = 0

  // Four cycles start on the mid-lines facing inward, well apart.
  const STARTS = [
    { x: 18, y: 37, dir: 'right' },
    { x: 81, y: 37, dir: 'left' },
    { x: 50, y: 14, dir: 'down' },
    { x: 50, y: 60, dir: 'up' },
  ]

  function newRound() {
    grid.fill(0)
    particles = []
    roundOver = false
    winner = null
    armed = true
    cycles = STARTS.map((s, i) => {
      grid[s.y * COLS + s.x] = i + 1
      return {
        x: s.x,
        y: s.y,
        dir: s.dir,
        pendingDir: null,
        color: COLORS[i],
        wins: cycles[i] ? cycles[i].wins : 0,
        alive: true,
        boost: false,
        brake: false,
        meter: 1,
        acc: 0,
        points: [{ x: s.x, y: s.y }],
      }
    })
  }

  function resetMatch() {
    round = 1
    cycles = [] // wins default to 0 in newRound
    newRound()
  }
  resetMatch()

  // ── Input: SSE from the vibesense host ────────────────────────────────
  // Absolute stick direction → a 90° turn on the hero cycle (never a reversal).
  function flick(dir) {
    if (!armed) return
    const me = cycles[0]
    if (dir === OPP[me.dir] || dir === me.dir) return
    me.pendingDir = dir
    armed = false
    lastHumanInput = performance.now()
  }

  function stickToDir() {
    if (Math.hypot(sx, sy) < 0.3) {
      armed = true
      return
    }
    if (Math.abs(sx) >= Math.abs(sy)) {
      if (Math.abs(sx) > 0.5) flick(sx > 0 ? 'right' : 'left')
    } else if (Math.abs(sy) > 0.5) {
      flick(sy > 0 ? 'down' : 'up')
    }
  }

  function pressBoost(pressed) {
    humanBoost = pressed
    if (pressed) {
      lastHumanInput = performance.now()
      if (roundOver) newRound()
    }
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
        if (msg.axis === 'left_x') sx = msg.value
        else if (msg.axis === 'left_y') sy = msg.value
        stickToDir()
      } else if (msg.kind === 'button') {
        if (msg.button === 'r2') pressBoost(msg.pressed)
        else if (msg.button === 'l2') {
          humanBrake = msg.pressed
          if (msg.pressed) lastHumanInput = performance.now()
        }
      }
    } else if (msg.type === 'reload') {
      location.href = msg.url // controller swapped games — load the new one
    }
  }
  events.onerror = () => setStatus('host disconnected — is vibesense running?', false)

  // Keyboard fallback for development.
  const KEYS = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    w: 'up',
    s: 'down',
    a: 'left',
    d: 'right',
  }
  addEventListener('keydown', (e) => {
    const dir = KEYS[e.key]
    if (dir) {
      flick(dir)
      lastHumanInput = performance.now()
    } else if (e.key === ' ') pressBoost(true)
    else if (e.key === 'Shift') {
      humanBrake = true
      lastHumanInput = performance.now()
    }
  })
  addEventListener('keyup', (e) => {
    if (KEYS[e.key]) armed = true
    else if (e.key === ' ') pressBoost(false)
    else if (e.key === 'Shift') humanBrake = false
  })

  function setPlaying(next) {
    playing = next
    setStatus(
      playing ? 'agent executing — outlast the grid!' : 'claude needs you — controller is on the terminal',
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
  // Pick the turn that leaves the most open space (flood fill), preferring to
  // hold a straight line on ties so it doesn't jitter. Boost to press an
  // advantage: with room to spare and a rival close, cut them off.
  // ponytail: greedy space heuristic, not adversarial search — good enough to
  // look sharp in a demo; upgrade to minimax only if it dies dumbly too often.
  function ai(c) {
    let best = null
    for (const rel of [0, -1, 1]) {
      const nd = turn(c.dir, rel)
      const nx = c.x + DIRS[nd].x
      const ny = c.y + DIRS[nd].y
      if (!isFree(nx, ny)) continue
      const area = floodFill(isFree, nx, ny, 160) + (rel === 0 ? 4 : 0)
      if (!best || area > best.area) best = { nd, area }
    }
    if (!best) {
      c.boost = false
      return // boxed in — hold course and crash
    }
    c.dir = best.nd
    let nearRival = false
    for (const o of cycles) {
      if (o !== c && o.alive && Math.abs(o.x - c.x) + Math.abs(o.y - c.y) < 11) nearRival = true
    }
    c.boost = c.meter > 0.35 && (nearRival || best.area > 130)
    c.brake = false
  }

  // ── Simulation ────────────────────────────────────────────────────────
  const cx = (x) => x * CELL + CELL / 2
  const cy = (y) => y * CELL + CELL / 2

  function burst(x, y, color, n = 22) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const v = 70 + Math.random() * 190
      const max = 0.4 + Math.random() * 0.45
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: max, max, color })
    }
  }

  function decide(c, i, idle) {
    if (i === 0 && !idle) {
      if (c.pendingDir && c.pendingDir !== OPP[c.dir]) c.dir = c.pendingDir
      c.pendingDir = null
      c.boost = humanBoost && c.meter > 0
      c.brake = humanBrake
    } else {
      ai(c)
    }
  }

  function stepCycle(c, i, idle) {
    decide(c, i, idle)
    const nx = c.x + DIRS[c.dir].x
    const ny = c.y + DIRS[c.dir].y
    if (!isFree(nx, ny)) {
      c.alive = false
      c.boost = false
      burst(cx(c.x), cy(c.y), c.color, 30)
      checkRoundOver()
      return
    }
    grid[ny * COLS + nx] = i + 1
    c.x = nx
    c.y = ny
    c.points.push({ x: nx, y: ny })
  }

  function checkRoundOver() {
    const alive = cycles.filter((c) => c.alive)
    if (alive.length > 1 || roundOver) return
    roundOver = true
    roundOverAt = performance.now()
    winner = alive[0] || null
    if (winner) winner.wins++
    round++
    if (cycles.some((c) => c.wins >= WIN_TARGET)) {
      // Match point reached — the next round starts a fresh match.
      round = 1
      for (const c of cycles) c.pendingWinReset = true
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

  function drawGrid(now) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 650)
    ctx.strokeStyle = `rgba(94, 139, 255, ${0.035 + 0.045 * pulse})`
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = 0; x <= COLS; x += 5) {
      ctx.moveTo(x * CELL, 0)
      ctx.lineTo(x * CELL, H)
    }
    for (let y = 0; y <= ROWS; y += 5) {
      ctx.moveTo(0, y * CELL)
      ctx.lineTo(W, y * CELL)
    }
    ctx.stroke()
  }

  function drawTrail(c) {
    if (c.points.length < 1) return
    ctx.save()
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = c.color
    ctx.shadowColor = c.color
    ctx.shadowBlur = 8
    ctx.lineWidth = CELL * 0.72
    ctx.globalAlpha = c.alive ? 1 : 0.45
    ctx.beginPath()
    ctx.moveTo(cx(c.points[0].x), cy(c.points[0].y))
    for (let i = 1; i < c.points.length; i++) ctx.lineTo(cx(c.points[i].x), cy(c.points[i].y))
    ctx.stroke()
    ctx.restore()
  }

  function drawHead(c) {
    if (!c.alive) return
    const px = cx(c.x)
    const py = cy(c.y)
    ctx.save()
    ctx.shadowColor = c.color
    ctx.shadowBlur = 16
    ctx.fillStyle = c.color
    ctx.beginPath()
    ctx.roundRect(px - CELL * 0.75, py - CELL * 0.75, CELL * 1.5, CELL * 1.5, 3)
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(px, py, CELL * 0.4, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  function drawHud() {
    ctx.fillStyle = '#8fa3c0'
    ctx.font = `600 13px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText('LIGHTCYCLE', 16, 18)
    ctx.textAlign = 'right'
    ctx.fillText(`ROUND ${round}`, W - 16, 18)

    // Per-cycle win pips, colored.
    ctx.textAlign = 'left'
    let ox = 16
    for (let i = 0; i < cycles.length; i++) {
      const c = cycles[i]
      ctx.save()
      ctx.shadowColor = c.color
      ctx.shadowBlur = 8
      ctx.fillStyle = c.color
      ctx.beginPath()
      ctx.arc(ox + 4, 34, 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      ctx.fillStyle = '#eaf2ff'
      ctx.font = `700 14px ${FONT}`
      const label = `${NAMES[i]} ${c.wins}`
      ctx.fillText(label, ox + 14, 39)
      ox += 14 + ctx.measureText(label).width + 18
    }

    // Boost meter for the hero cycle.
    const me = cycles[0]
    const bw = 150
    const bx = W - 16 - bw
    const by = 30
    ctx.fillStyle = 'rgba(140, 170, 255, 0.12)'
    ctx.beginPath()
    ctx.roundRect(bx, by, bw, 8, 4)
    ctx.fill()
    ctx.save()
    ctx.shadowColor = me.color
    ctx.shadowBlur = 10
    ctx.fillStyle = me.meter > 0.15 ? me.color : '#ff4d6d'
    ctx.beginPath()
    ctx.roundRect(bx, by, Math.max(2, bw * me.meter), 8, 4)
    ctx.fill()
    ctx.restore()
    ctx.fillStyle = '#8fa3c0'
    ctx.font = `600 11px ${FONT}`
    ctx.textAlign = 'right'
    ctx.fillText('BOOST', bx - 8, 39)
  }

  function overlay(title, sub, color) {
    ctx.fillStyle = 'rgba(3, 5, 14, 0.72)'
    ctx.fillRect(0, 0, W, H)
    const cw = 480
    const ch = 190
    const bx = (W - cw) / 2
    const by = (H - ch) / 2
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 30
    ctx.fillStyle = 'rgba(9, 13, 28, 0.95)'
    ctx.beginPath()
    ctx.roundRect(bx, by, cw, ch, 14)
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.5
    ctx.stroke()
    ctx.restore()

    ctx.textAlign = 'center'
    ctx.fillStyle = color
    ctx.font = `700 34px ${FONT}`
    ctx.fillText(title, W / 2, by + 76)
    ctx.fillStyle = '#8fa3c0'
    ctx.font = `500 14px ${FONT}`
    ctx.fillText(sub, W / 2, by + ch - 40)
  }

  function render(now) {
    ctx.clearRect(0, 0, W, H)
    drawGrid(now)
    for (const c of cycles) drawTrail(c)
    for (const c of cycles) drawHead(c)

    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max)
      ctx.fillStyle = p.color
      ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5)
    }
    ctx.globalAlpha = 1
    drawHud()

    if (roundOver) {
      const idx = winner ? cycles.indexOf(winner) : -1
      const title = winner ? `${NAMES[idx]} TAKES THE ROUND` : 'MUTUAL CRASH'
      overlay(title, 'next round starting…', winner ? winner.color : '#ff4d6d')
    } else if (!playing) {
      overlay('PAUSED', 'claude needs you — answer in the terminal', '#5e8bff')
    }
  }

  // ── Main loop ─────────────────────────────────────────────────────────
  let last = performance.now()
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (roundOver && now - roundOverAt > 2000) {
      // A match may have just ended — clear win tallies before the fresh round.
      if (cycles.some((c) => c.pendingWinReset)) for (const c of cycles) c.wins = 0
      newRound()
    }
    if (playing) {
      for (const p of particles) {
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.life -= dt
      }
      particles = particles.filter((p) => p.life > 0)

      if (!roundOver) {
        const idle = now - lastHumanInput > AUTOPILOT_IDLE_MS
        for (let i = 0; i < cycles.length; i++) {
          const c = cycles[i]
          if (!c.alive) continue
          if (c.boost && c.meter > 0) {
            c.meter = Math.max(0, c.meter - DRAIN * dt)
            if (c.meter === 0) c.boost = false
          } else {
            c.meter = Math.min(1, c.meter + RECHARGE * dt)
          }
          c.acc += dt
          let interval = (c.boost ? BOOST_MS : c.brake ? BRAKE_MS : STEP_MS) / 1000
          while (c.alive && !roundOver && c.acc >= interval) {
            c.acc -= interval
            stepCycle(c, i, idle)
            interval = (c.boost ? BOOST_MS : c.brake ? BRAKE_MS : STEP_MS) / 1000
          }
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
    ok(turn('up', 1) === 'right' && turn('up', -1) === 'left', 'turn rotates 90°')
    ok(turn('right', 1) === 'down' && turn('left', -1) === 'down', 'turn wraps the ring')
    ok(turn('up', 0) === 'up', 'zero turn holds course')

    // Open 3×3 board → 9 reachable cells; a wall cell is unreachable.
    const open = (x, y) => x >= 0 && x < 3 && y >= 0 && y < 3
    ok(floodFill(open, 0, 0, 100) === 9, 'flood counts the whole open board')
    ok(floodFill(open, 5, 5, 100) === 0, 'flood off-board is empty')
    ok(floodFill(open, 0, 0, 4) === 4, 'flood respects the cap')
    // A wall splitting the board limits reachable area.
    const split = (x, y) => open(x, y) && x !== 1
    ok(floodFill(split, 0, 0, 100) === 3, 'flood is blocked by a wall')

    console.log('[lightcycle] selftest passed')
    document.getElementById('status').textContent = 'selftest passed ✓'
  }
})()
