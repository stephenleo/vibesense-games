// Hopper — a Frogger-style lane crosser bundled with VibeSense. Runs while the
// Claude agent executes; freezes the instant it needs you. Input arrives over
// SSE from the vibesense host: FLICK the left stick to hop one grid cell in that
// direction (threshold + re-arm at center, so one flick = exactly one hop), R2
// hops forward, L2 hops back. Cross five lanes of neon traffic, a median, then a
// river you can only cross by riding drifting logs — into the five home slots.
// When nobody's touching the controller a demo autopilot plans gaps and log
// timing and visibly hops its way across, so the marketplace shots are lively.
// Keyboard fallback (arrows/WASD → stick, Space → R2, Shift → L2) for dev.
// `?play` forces the playing state so the game is testable without a host.

;(() => {
  'use strict'

  // ── Pure geometry (unit-testable, no I/O) ─────────────────────────────
  const W = 800
  const H = 600
  const ROWS = 13 // 0 home · 1-5 river · 6 median · 7-11 road · 12 start
  const ROW_H = H / ROWS
  const FROG_HALF = 13

  const wrapX = (v) => ((v % W) + W) % W
  // Shortest distance between two x's on a horizontally-wrapping strip.
  const circDist = (a, b) => {
    const d = Math.abs(a - b)
    return Math.min(d, W - d)
  }
  const yFor = (row) => row * ROW_H + ROW_H / 2
  const isRiver = (r) => r >= 1 && r <= 5
  const isRoad = (r) => r >= 7 && r <= 11

  // Position of body #i in a lane at time offset `t` seconds from now.
  const predict = (lane, i, t) => wrapX(lane.phase + lane.vel * t + i * lane.spacing)

  // Is x under a car in this lane right now? (fatal on the road.)
  function carHit(lane, x) {
    for (let i = 0; i < lane.n; i++) {
      if (circDist(x, predict(lane, i, 0)) < lane.w / 2 + FROG_HALF - 2) return true
    }
    return false
  }

  // The log covering x in this lane, or null (used to ride / to drown).
  function logUnder(lane, x, t = 0) {
    for (let i = 0; i < lane.n; i++) {
      if (circDist(x, predict(lane, i, t)) < lane.w / 2 - 6) return { vel: lane.vel, x: predict(lane, i, t) }
    }
    return null
  }

  // Will a car be dangerously near x within the next ~0.4s? (autopilot look-ahead)
  function carDanger(lane, x) {
    for (const t of [0, 0.13, 0.26, 0.42]) {
      for (let i = 0; i < lane.n; i++) {
        if (circDist(x, predict(lane, i, t)) < lane.w / 2 + FROG_HALF + 11) return true
      }
    }
    return false
  }

  if (location.search.includes('selftest')) return selftest()

  // ── Setup ─────────────────────────────────────────────────────────────
  const canvas = document.getElementById('game')
  const ctx = canvas.getContext('2d')
  const statusEl = document.getElementById('status')

  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = W * dpr
  canvas.height = H * dpr
  ctx.scale(dpr, dpr)

  const ACCENT = '#7dff5e'
  const CELL_W = 50 // horizontal hop distance
  const HOP_DUR = 0.13 // seconds airborne per hop
  const JUMP_H = ROW_H * 0.55
  const TIME_LIMIT = 30 // seconds per attempt
  const AUTOPILOT_IDLE_MS = 2500
  const AUTO_HOP_MS = 150 // demo cadence between hops
  const CAR_COLORS = ['#ff4d6d', '#ffb84d', '#4dd2ff', '#c77dff', '#ff7de3']
  const SLOT_X = [80, 240, 400, 560, 720]
  const SLOT_HALF = 42
  const START_X = 400

  let playing = false
  let level = 1
  let score = 0
  let lives = 3
  let timer = TIME_LIMIT
  let gameOver = false
  let gameOverAt = 0
  let banner = { text: '', t: 0 }
  let laneByRow = {} // row → { kind, row, vel, w, n, spacing, phase, color }
  let slots = SLOT_X.map((x) => ({ x, filled: false }))
  let frog = null // { row, x, hopping, hopT, fromX, fromY, toX, toY, look }
  let particles = [] // { x, y, vx, vy, life, max, color }
  let ripples = [] // { x, y, r, max, life }
  let lastHumanInput = -1e9 // negative → autopilot drives from the first frame
  let lastHopAt = -1e9
  let armX = true
  let armY = true

  function buildLevel() {
    laneByRow = {}
    // Road: five lanes, alternating direction, varied speed/width, faster each level.
    for (let r = 7; r <= 11; r++) {
      const k = r - 7
      const dir = k % 2 === 0 ? 1 : -1
      const n = 2 + (k % 2)
      laneByRow[r] = {
        kind: 'car',
        row: r,
        vel: dir * (58 + k * 9 + Math.random() * 26 + (level - 1) * 15),
        w: 56 + (k % 2) * 16,
        n,
        spacing: W / n,
        phase: Math.random() * W,
        color: CAR_COLORS[k % CAR_COLORS.length],
      }
    }
    // River: five log lanes; fewer logs at higher levels (harder to cross).
    const logN = Math.max(2, 4 - Math.floor((level - 1) / 2))
    for (let r = 1; r <= 5; r++) {
      const k = r - 1
      const dir = k % 2 === 0 ? -1 : 1
      laneByRow[r] = {
        kind: 'log',
        row: r,
        vel: dir * (36 + Math.random() * 22 + (level - 1) * 9),
        w: Math.max(96, 128 + Math.random() * 34 - k * 4),
        n: logN,
        spacing: W / logN,
        phase: Math.random() * W,
      }
    }
  }

  function respawn() {
    frog = { row: 12, x: START_X, hopping: false, hopT: 0, fromX: START_X, fromY: yFor(12), toX: START_X, toY: yFor(12), look: 'up' }
    timer = TIME_LIMIT
  }

  function reset() {
    level = 1
    score = 0
    lives = 3
    gameOver = false
    particles = []
    ripples = []
    slots = SLOT_X.map((x) => ({ x, filled: false }))
    buildLevel()
    respawn()
    banner = { text: 'LEVEL 1', t: 1.4 }
  }
  reset()

  // ── Hops ──────────────────────────────────────────────────────────────
  function hop(dir, now) {
    if (!frog || frog.hopping || gameOver) return
    let row = frog.row
    let x = frog.x
    if (dir === 'up') row -= 1
    else if (dir === 'down') row += 1
    else if (dir === 'left') x -= CELL_W
    else if (dir === 'right') x += CELL_W
    if (row < 0 || row > 12) return
    if (x < FROG_HALF || x > W - FROG_HALF) return
    frog.look = dir
    frog.fromX = frog.x
    frog.fromY = yFor(frog.row)
    frog.row = row
    frog.x = x
    frog.toX = x
    frog.toY = yFor(row)
    frog.hopping = true
    frog.hopT = 0
    lastHopAt = now
  }

  // Called the instant a hop lands. The home row resolves here; other rows are
  // handled by the per-frame collision below.
  function land(now) {
    if (frog.row !== 0) return
    let best = null
    let bestD = Infinity
    for (const s of slots) {
      const d = Math.abs(frog.x - s.x)
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    if (best && bestD <= SLOT_HALF && !best.filled) {
      best.filled = true
      score += 100 + Math.max(0, Math.round(timer * 6))
      burst(best.x, yFor(0), ACCENT, 22)
      ripple(best.x, yFor(0))
      if (slots.every((s) => s.filled)) {
        level += 1
        score += 500
        banner = { text: 'LEVEL ' + level, t: 1.5 }
        slots.forEach((s) => (s.filled = false))
        buildLevel()
      }
      respawn()
    } else {
      die('missed', now)
    }
  }

  function die(cause, now) {
    if (!frog || gameOver) return
    const y = frog.hopping ? frog.toY : yFor(frog.row)
    if (cause === 'drown' || cause === 'swept') {
      burst(frog.x, y, '#4dd2ff', 20)
      ripple(frog.x, y, 34)
    } else {
      burst(frog.x, y, '#ff4d6d', 24)
    }
    lives -= 1
    if (lives <= 0) {
      gameOver = true
      gameOverAt = now
      frog = null
      return
    }
    respawn()
  }

  // ── Autopilot: plan a gap or a log, then hop toward a slot ─────────────
  function autopilot(now) {
    if (!frog || frog.hopping || now - lastHopAt < AUTO_HOP_MS) return
    const r = frog.row

    // River bank edge: swept-off recovery is handled by dying; here just cross.
    const target = (slots.find((s) => !s.filled) || slots[0]).x
    // Aim at the nearest UNFILLED slot for a straighter approach.
    let tx = target
    let td = Infinity
    for (const s of slots) {
      if (s.filled) continue
      const d = Math.abs(frog.x - s.x)
      if (d < td) {
        td = d
        tx = s.x
      }
    }

    const nr = r - 1
    const toward = () => {
      if (tx < frog.x - 8) hop('left', now)
      else if (tx > frog.x + 8) hop('right', now)
    }

    if (nr === 0) {
      // At the river's last log, line up under a slot then hop home.
      if (Math.abs(frog.x - tx) <= 16) hop('up', now)
      else toward()
      return
    }

    let safe
    if (isRoad(nr)) safe = !carDanger(laneByRow[nr], frog.x)
    else if (isRiver(nr)) safe = !!logUnder(laneByRow[nr], frog.x, HOP_DUR)
    else safe = true // median / start ground

    if (safe) {
      hop('up', now)
    } else if (isRiver(r) && td > CELL_W * 0.6) {
      // Riding a log with no landing above yet — drift-align toward the slot.
      toward()
    }
    // Otherwise wait one beat: cars pass, logs slide into reach.
  }

  // ── Effects ───────────────────────────────────────────────────────────
  function burst(x, y, color, n = 16) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const v = 60 + Math.random() * 160
      const max = 0.35 + Math.random() * 0.4
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: max, max, color })
    }
  }

  function ripple(x, y, max = 26) {
    ripples.push({ x, y, r: 4, max, life: 1 })
  }

  // ── Input: SSE from the vibesense host ────────────────────────────────
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
      const now = performance.now()
      if (msg.kind === 'axis') {
        // Flick to hop: fire past the threshold, then require a return to center
        // before the same axis can fire again — one flick, one hop.
        if (msg.axis === 'left_x') {
          if (Math.abs(msg.value) > 0.55 && armX) {
            humanHop(msg.value > 0 ? 'right' : 'left', now)
            armX = false
          } else if (Math.abs(msg.value) < 0.25) armX = true
        } else if (msg.axis === 'left_y') {
          if (Math.abs(msg.value) > 0.55 && armY) {
            humanHop(msg.value > 0 ? 'down' : 'up', now)
            armY = false
          } else if (Math.abs(msg.value) < 0.25) armY = true
        }
      } else if (msg.kind === 'button' && msg.pressed) {
        if (msg.button === 'r2') humanHop('up', now)
        else if (msg.button === 'l2') humanHop('down', now)
      }
    } else if (msg.type === 'reload') {
      location.href = msg.url // controller swapped games — load the new one
    }
  }
  events.onerror = () => setStatus('host disconnected — is vibesense running?', false)

  function humanHop(dir, now) {
    lastHumanInput = now
    if (gameOver) reset()
    else hop(dir, now)
  }

  // Keyboard fallback for development.
  const KEY_DIR = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    w: 'up',
    s: 'down',
    a: 'left',
    d: 'right',
    ' ': 'up',
    Shift: 'down',
  }
  addEventListener('keydown', (e) => {
    const dir = KEY_DIR[e.key]
    if (dir) humanHop(dir, performance.now())
  })

  function setPlaying(next) {
    playing = next
    setStatus(
      playing ? 'agent executing — hop across!' : 'claude needs you — controller is on the terminal',
      playing,
    )
  }

  function setStatus(text, isPlaying) {
    statusEl.textContent = text
    statusEl.className = isPlaying ? 'playing' : ''
  }

  // Dev affordance: `?play` runs the game without a host.
  if (location.search.includes('play')) setPlaying(true)

  // ── Simulation ────────────────────────────────────────────────────────
  function tick(dt, now) {
    banner.t = Math.max(0, banner.t - dt)
    for (const r in laneByRow) laneByRow[r].phase = wrapX(laneByRow[r].phase + laneByRow[r].vel * dt)

    for (const p of particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += 220 * dt
      p.life -= dt
    }
    particles = particles.filter((p) => p.life > 0)
    for (const rp of ripples) {
      rp.r += (rp.max - rp.r) * Math.min(1, dt * 5)
      rp.life -= dt * 1.6
    }
    ripples = ripples.filter((rp) => rp.life > 0)

    if (gameOver) return

    if (frog.hopping) {
      frog.hopT += dt
      if (frog.hopT >= HOP_DUR) {
        frog.hopT = HOP_DUR
        frog.hopping = false
        land(now)
      }
    } else {
      const r = frog.row
      if (isRiver(r)) {
        const log = logUnder(laneByRow[r], frog.x)
        if (!log) {
          die('drown', now)
        } else {
          frog.x += log.vel * dt
          if (frog.x < FROG_HALF - 4 || frog.x > W - FROG_HALF + 4) die('swept', now)
          else if (Math.random() < dt * 2.5) ripple(frog.x, yFor(r) + 6, 16)
        }
      } else if (isRoad(r) && carHit(laneByRow[r], frog.x)) {
        die('squash', now)
      }
    }

    if (frog && !gameOver) {
      if (now - lastHumanInput > AUTOPILOT_IDLE_MS) autopilot(now)
      timer -= dt
      if (timer <= 0) die('time', now)
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  const lerp = (a, b, t) => a + (b - a) * t

  function drawZones(now) {
    // Start & median grass.
    for (const r of [12, 6]) {
      ctx.fillStyle = '#0f2f1c'
      ctx.fillRect(0, r * ROW_H, W, ROW_H)
      ctx.fillStyle = 'rgba(125, 255, 94, 0.05)'
      for (let x = 6; x < W; x += 26) ctx.fillRect(x, r * ROW_H + 6, 3, ROW_H - 12)
    }
    // Road.
    ctx.fillStyle = '#0d0f16'
    ctx.fillRect(0, 7 * ROW_H, W, 5 * ROW_H)
    ctx.strokeStyle = 'rgba(215, 201, 74, 0.5)'
    ctx.lineWidth = 2
    ctx.setLineDash([18, 20])
    for (let r = 8; r <= 11; r++) {
      ctx.beginPath()
      ctx.moveTo(0, r * ROW_H)
      ctx.lineTo(W, r * ROW_H)
      ctx.stroke()
    }
    ctx.setLineDash([])
    // River.
    const g = ctx.createLinearGradient(0, ROW_H, 0, 6 * ROW_H)
    g.addColorStop(0, '#08243f')
    g.addColorStop(1, '#0a3352')
    ctx.fillStyle = g
    ctx.fillRect(0, ROW_H, W, 5 * ROW_H)
    ctx.strokeStyle = 'rgba(79, 208, 255, 0.10)'
    ctx.lineWidth = 1.4
    for (let r = 1; r <= 5; r++) {
      const y = yFor(r)
      ctx.beginPath()
      for (let x = 0; x <= W; x += 14) {
        const yy = y + 8 * Math.sin(x / 46 + now / 520 + r)
        x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy)
      }
      ctx.stroke()
    }
    // Home bank.
    ctx.fillStyle = '#0c2417'
    ctx.fillRect(0, 0, W, ROW_H)
    for (const s of slots) {
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(s.x - SLOT_HALF, 6, SLOT_HALF * 2, ROW_H - 12, 10)
      ctx.fillStyle = s.filled ? 'rgba(125, 255, 94, 0.16)' : 'rgba(4, 12, 8, 0.85)'
      ctx.fill()
      ctx.strokeStyle = s.filled ? ACCENT : 'rgba(125, 255, 94, 0.28)'
      ctx.lineWidth = 1.6
      ctx.stroke()
      ctx.restore()
      if (s.filled) drawFrogShape(s.x, yFor(0), 0.72, 'up', 1)
    }
  }

  function drawLanes(now) {
    for (const r in laneByRow) {
      const lane = laneByRow[r]
      const y = yFor(lane.row)
      for (let i = 0; i < lane.n; i++) {
        const cx = predict(lane, i, 0)
        for (const off of [0, -W, W]) {
          const x = cx + off
          if (x < -lane.w || x > W + lane.w) continue
          if (lane.kind === 'car') drawCar(x, y, lane, now)
          else drawLog(x, y, lane)
        }
      }
    }
  }

  function drawCar(x, y, lane, now) {
    const w = lane.w
    const h = ROW_H * 0.6
    // Headlight glow at the leading edge.
    const dir = lane.vel >= 0 ? 1 : -1
    const hx = x + (dir * w) / 2
    const glow = ctx.createRadialGradient(hx, y, 1, hx, y, 46)
    glow.addColorStop(0, 'rgba(255, 248, 210, 0.5)')
    glow.addColorStop(1, 'rgba(255, 248, 210, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(hx - 46, y - 24, 92, 48)

    ctx.save()
    ctx.shadowColor = lane.color
    ctx.shadowBlur = 14
    const grad = ctx.createLinearGradient(x, y - h / 2, x, y + h / 2)
    grad.addColorStop(0, lane.color)
    grad.addColorStop(1, shade(lane.color, -0.45))
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 8)
    ctx.fill()
    ctx.restore()
    // Windshield.
    ctx.fillStyle = 'rgba(10, 16, 30, 0.55)'
    ctx.beginPath()
    ctx.roundRect(x - w / 2 + w * 0.24, y - h / 2 + 4, w * 0.32, h - 8, 4)
    ctx.fill()
    // Twin headlight dots.
    ctx.fillStyle = '#fff6d0'
    ctx.beginPath()
    ctx.arc(hx - dir * 3, y - h / 4, 2.4, 0, Math.PI * 2)
    ctx.arc(hx - dir * 3, y + h / 4, 2.4, 0, Math.PI * 2)
    ctx.fill()
  }

  function drawLog(x, y, lane) {
    const w = lane.w
    const h = ROW_H * 0.56
    ctx.save()
    ctx.shadowColor = 'rgba(79, 208, 255, 0.55)'
    ctx.shadowBlur = 10
    const grad = ctx.createLinearGradient(x, y - h / 2, x, y + h / 2)
    grad.addColorStop(0, '#8a6038')
    grad.addColorStop(1, '#5a3c22')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2)
    ctx.fill()
    ctx.restore()
    // Wood grain + end rings.
    ctx.strokeStyle = 'rgba(58, 38, 20, 0.6)'
    ctx.lineWidth = 1.4
    for (const gy of [-h * 0.18, h * 0.18]) {
      ctx.beginPath()
      ctx.moveTo(x - w / 2 + 10, y + gy)
      ctx.lineTo(x + w / 2 - 10, y + gy)
      ctx.stroke()
    }
    for (const ex of [-1, 1]) {
      ctx.strokeStyle = 'rgba(216, 178, 120, 0.5)'
      ctx.beginPath()
      ctx.arc(x + ex * (w / 2 - 8), y, h * 0.22, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  // Frog drawn at pixel (cx, cy), scaled, facing `look`, with a mid-hop squash.
  function drawFrogShape(cx, cy, scale, look, squashT) {
    const sq = Math.sin(squashT * Math.PI) // 0 at ground, 1 mid-air
    const sx = scale * (1 - 0.18 * sq)
    const sy = scale * (1 + 0.26 * sq)
    const rot = look === 'left' ? -Math.PI / 2 : look === 'right' ? Math.PI / 2 : look === 'down' ? Math.PI : 0
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(rot)
    ctx.scale(sx, sy)
    ctx.shadowColor = ACCENT
    ctx.shadowBlur = 14
    // Legs.
    ctx.fillStyle = '#4fbf3a'
    for (const s of [-1, 1]) {
      ctx.beginPath()
      ctx.ellipse(s * 12, 9, 5, 9, s * 0.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.ellipse(s * 12, -9, 5, 8, -s * 0.5, 0, Math.PI * 2)
      ctx.fill()
    }
    // Body.
    const grad = ctx.createRadialGradient(-3, -4, 2, 0, 0, 15)
    grad.addColorStop(0, '#b6ff8f')
    grad.addColorStop(0.6, ACCENT)
    grad.addColorStop(1, '#3fbf2f')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.ellipse(0, 0, 12, 13, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
    // Eyes (toward the top / travel direction).
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#eafff0'
      ctx.beginPath()
      ctx.arc(s * 6, -9, 4.2, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#08210d'
      ctx.beginPath()
      ctx.arc(s * 6, -10, 2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  function drawFrog(now) {
    if (!frog) return
    let x, y, t
    if (frog.hopping) {
      const p = frog.hopT / HOP_DUR
      x = lerp(frog.fromX, frog.toX, p)
      y = lerp(frog.fromY, frog.toY, p) - Math.sin(p * Math.PI) * JUMP_H
      t = p
    } else {
      x = frog.x
      y = yFor(frog.row) + Math.sin(now / 300) * 1.2
      t = 0
    }
    drawFrogShape(x, y, 1, frog.look, t)
  }

  function drawEffects() {
    for (const rp of ripples) {
      ctx.globalAlpha = Math.max(0, rp.life) * 0.6
      ctx.strokeStyle = '#8fe3ff'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max)
      ctx.fillStyle = p.color
      ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5)
    }
    ctx.globalAlpha = 1
  }

  function drawHud() {
    ctx.fillStyle = '#8fa3c0'
    ctx.font = `600 13px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText('SCORE', 16, 18)
    ctx.textAlign = 'center'
    ctx.fillText(`LEVEL ${level}`, W / 2, 18)
    ctx.textAlign = 'right'
    ctx.fillText('LIVES', W - 16, 18)
    ctx.fillStyle = '#eaf2ff'
    ctx.font = `700 16px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText(String(score).padStart(6, '0'), 16, 33)
    // Lives as little frog dots.
    for (let i = 0; i < lives; i++) {
      ctx.fillStyle = ACCENT
      ctx.beginPath()
      ctx.arc(W - 22 - i * 20, 30, 5, 0, Math.PI * 2)
      ctx.fill()
    }
    // Timer bar along the very bottom.
    const frac = Math.max(0, timer / TIME_LIMIT)
    ctx.fillStyle = 'rgba(140, 170, 255, 0.12)'
    ctx.fillRect(0, H - 5, W, 5)
    ctx.fillStyle = frac < 0.25 ? '#ff4d6d' : ACCENT
    ctx.fillRect(0, H - 5, W * frac, 5)
  }

  function overlay(title, sub, color, showScore) {
    ctx.fillStyle = 'rgba(3, 5, 14, 0.78)'
    ctx.fillRect(0, 0, W, H)
    const cw = 460
    const ch = showScore ? 190 : 160
    const cx = (W - cw) / 2
    const cy = (H - ch) / 2
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 30
    ctx.fillStyle = 'rgba(9, 13, 28, 0.95)'
    ctx.beginPath()
    ctx.roundRect(cx, cy, cw, ch, 14)
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.5
    ctx.stroke()
    ctx.restore()

    ctx.textAlign = 'center'
    ctx.fillStyle = color
    ctx.font = `700 34px ${FONT}`
    ctx.fillText(title, W / 2, cy + 62)
    if (showScore) {
      ctx.fillStyle = '#eaf2ff'
      ctx.font = `700 18px ${FONT}`
      ctx.fillText(`SCORE ${score} · LEVEL ${level}`, W / 2, cy + 100)
    }
    ctx.fillStyle = '#8fa3c0'
    ctx.font = `500 14px ${FONT}`
    ctx.fillText(sub, W / 2, cy + ch - 38)
  }

  function render(now) {
    ctx.clearRect(0, 0, W, H)
    drawZones(now)
    drawLanes(now)
    drawEffects()
    drawFrog(now)
    drawHud()

    if (banner.t > 0 && !gameOver) {
      ctx.globalAlpha = Math.min(1, banner.t / 0.4)
      ctx.fillStyle = '#c9ffd8'
      ctx.font = `700 40px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText(banner.text, W / 2, H / 2 - 40)
      ctx.globalAlpha = 1
    }

    if (gameOver) {
      overlay('GAME OVER', 'flick to play again — restarting…', '#ff4d6d', true)
    } else if (!playing) {
      overlay('PAUSED', 'claude needs you — answer in the terminal', ACCENT, false)
    }
  }

  // ── Main loop ─────────────────────────────────────────────────────────
  let last = performance.now()
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (gameOver && now - gameOverAt > 2000) reset()
    if (playing) tick(dt, now)
    render(now)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // Lighten (t>0) or darken (t<0) a #rrggbb color toward white/black.
  function shade(hex, t) {
    const n = parseInt(hex.slice(1), 16)
    const mix = (c) => Math.round(t < 0 ? c * (1 + t) : c + (255 - c) * t)
    const r = mix((n >> 16) & 255)
    const g = mix((n >> 8) & 255)
    const b = mix(n & 255)
    return `rgb(${r}, ${g}, ${b})`
  }

  // ── Self-test: `?selftest` runs the pure logic and asserts. ────────────
  function selftest() {
    const ok = (cond, msg) => {
      if (!cond) throw new Error('selftest failed: ' + msg)
    }
    ok(wrapX(810) === 10 && wrapX(-10) === 790, 'wrapX folds onto the strip')
    ok(circDist(10, 790) === 20, 'circDist takes the short way around the wrap')
    ok(circDist(100, 130) === 30, 'circDist plain interior distance')

    const lane = { row: 8, vel: 100, w: 60, n: 2, spacing: 400, phase: 0 }
    ok(carHit(lane, 0), 'car sitting on x is a hit')
    ok(!carHit(lane, 200), 'clear gap is not a hit')
    ok(carDanger(lane, 60), 'a car about to arrive reads as danger')

    const river = { row: 3, vel: 0, w: 120, n: 1, spacing: 800, phase: 400 }
    ok(logUnder(river, 400), 'x over the log finds it')
    ok(!logUnder(river, 700), 'x in open water finds no log')

    console.log('[hopper] selftest passed')
    document.getElementById('status').textContent = 'selftest passed ✓'
  }
})()
