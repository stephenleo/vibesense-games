// Glider — bundled VibeSense game. A one-button flow runner: pilot a neon
// glider through the gaps between luminous pylon pairs scrolling right-to-left.
// Runs while the Claude agent executes; freezes when it needs you. Input over
// SSE from the vibesense host: R2 (or left stick up) pulses thrust against
// gravity, L2 (or stick down) dives. Physics are floaty-but-precise. Untouched
// controller hands the glider to a predictive autopilot that aims for gap
// centres and survives long agent runs, so the demo always looks skillful.
// Keyboard fallback (arrows/WASD + space + shift) for development. `?play`
// forces the playing state so the game is testable without a host.

;(() => {
  'use strict'

  // ── Pure logic (unit-testable, no I/O) ────────────────────────────────
  const W = 800
  const H = 600

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

  // Gap half-height and scroll speed both ramp with the level (every 10 gates).
  const levelOf = (gates) => Math.floor(gates / 10) + 1
  const gapHalfFor = (level) => Math.max(74, 118 - (level - 1) * 7)
  const scrollFor = (level) => Math.min(360, 190 + (level - 1) * 20)

  // Does the glider (centre y, radius r) clear a gap centred on gapY?
  const clearsGap = (y, r, gapY, gapHalf) => y - r > gapY - gapHalf && y + r < gapY + gapHalf

  // Autopilot bang-bang PD controller. In screen coords y grows downward and a
  // thrust produces upward (negative) acceleration. Command the desired down-
  // ward accel a = kp·(target − y) − kd·vy; when it is negative we want to rise,
  // so hold thrust. This hovers the glider onto a moving gap centre.
  const KP = 8.5
  const KD = 3.1
  const wantThrust = (y, vy, target) => KP * (target - y) - KD * vy < 0

  if (location.search.includes('selftest')) return selftest()

  // ── Setup ─────────────────────────────────────────────────────────────
  const canvas = document.getElementById('game')
  const ctx = canvas.getContext('2d')
  const statusEl = document.getElementById('status')

  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = W * dpr
  canvas.height = H * dpr
  ctx.scale(dpr, dpr)

  const ACCENT = '#ffb84d'
  const GX = 210 // glider's fixed screen x
  const GR = 12 // collision radius
  const GW = 46 // pylon width
  const SPACING = 300 // horizontal gap between successive gates
  const GRAVITY = 1050
  const THRUST = 2150 // upward accel while held (net ≈ 1100 up — floaty)
  const DIVE = 1150 // extra downward accel on L2 / stick-down
  const MAX_VY = 540
  const AUTOPILOT_IDLE_MS = 2500

  let playing = false
  let glider = { y: H / 2, vy: 0 } // {y, vy}
  let gates = [] // {x, gapY, half, baseY, amp, phase, w, passed}
  let particles = [] // engine trail + crash debris {x, y, vx, vy, life, max, color, size}
  let stars = [] // parallax dust {x, y, r, depth}
  let skyline = [] // distant buildings {x, w, h}
  let score = 0
  let gatesPassed = 0
  let level = 1
  let scroll = scrollFor(1)
  let gameOver = false
  let gameOverAt = 0
  let shudder = 0 // screen-shake amount, decays after a crash
  let flash = 0 // gate-pass flash, decays
  let thrustUp = false
  let diving = false
  let lastHumanInput = -1e9 // autopilot flies from frame one for the demo
  // Keyboard fallback holds.
  let keyUp = false
  let keyDown = false

  for (let i = 0; i < 120; i++) {
    stars.push({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() < 0.82 ? 1 : 1.7,
      depth: 0.25 + Math.random() * 0.9, // parallax factor
    })
  }
  {
    let x = 0
    while (x < W + 220) {
      const w = 26 + Math.random() * 54
      skyline.push({ x, w, h: 60 + Math.random() * 150 })
      x += w + 10 + Math.random() * 26
    }
  }

  // ── Gates ─────────────────────────────────────────────────────────────
  function makeGate(x) {
    const half = gapHalfFor(level)
    const margin = half + 40
    const baseY = margin + Math.random() * (H - margin * 2)
    // Moving gaps arrive from level 3, more often as it ramps.
    const moving = level >= 3 && Math.random() < Math.min(0.5, 0.12 * level)
    const amp = moving ? 40 + Math.random() * (28 + level * 6) : 0
    return { x, gapY: baseY, half, baseY, amp, phase: Math.random() * Math.PI * 2, w: GW, passed: false }
  }

  function reset() {
    glider = { y: H / 2, vy: 0 }
    gates = []
    particles = []
    score = 0
    gatesPassed = 0
    level = 1
    scroll = scrollFor(1)
    gameOver = false
    shudder = 0
    flash = 0
    // Pre-place gates so the very first screenshot shows lively gameplay.
    for (let i = 0; i < 4; i++) gates.push(makeGate(560 + i * SPACING))
  }
  reset()

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
      if (msg.kind === 'axis') {
        if (msg.axis === 'left_y') {
          thrustUp = msg.value < -0.3
          diving = msg.value > 0.3
          if (Math.abs(msg.value) > 0.3) touch()
        }
        // left_x is unused — the glider only climbs and dives.
      } else if (msg.kind === 'button') {
        if (msg.button === 'r2') {
          thrustUp = msg.pressed
          if (msg.pressed) touch()
        } else if (msg.button === 'l2') {
          diving = msg.pressed
          if (msg.pressed) touch()
        }
      }
    } else if (msg.type === 'reload') {
      location.href = msg.url // controller swapped games — load the new one
    }
  }
  events.onerror = () => setStatus('host disconnected — is vibesense running?', false)

  function touch() {
    lastHumanInput = performance.now()
    if (gameOver) reset()
  }

  // Keyboard fallback for development: up/W/space climb, down/S/shift dive.
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ') keyUp = true
    else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'Shift') keyDown = true
    else return
    thrustUp = keyUp
    diving = keyDown
    touch()
  })
  addEventListener('keyup', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ') keyUp = false
    else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'Shift') keyDown = false
    thrustUp = keyUp
    diving = keyDown
  })

  function setPlaying(next) {
    playing = next
    setStatus(
      playing ? 'agent executing — thread the gates!' : 'claude needs you — controller is on the terminal',
      playing,
    )
  }

  function setStatus(text, isPlaying) {
    statusEl.textContent = text
    statusEl.className = isPlaying ? 'playing' : ''
  }

  // Dev affordance: `?play` runs the game without a host.
  if (location.search.includes('play')) setPlaying(true)

  // ── Effects ───────────────────────────────────────────────────────────
  function trail() {
    // Engine exhaust puffed out the back of the glider.
    particles.push({
      x: GX - 16,
      y: glider.y + 3,
      vx: -scroll * 0.4 - 40 - Math.random() * 60,
      vy: (Math.random() - 0.5) * 50,
      life: 0.45,
      max: 0.45,
      color: Math.random() < 0.5 ? ACCENT : '#ff7a3c',
      size: 2.5 + Math.random() * 2,
    })
  }

  function crashBurst() {
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2
      const v = 60 + Math.random() * 240
      const max = 0.4 + Math.random() * 0.5
      particles.push({
        x: GX,
        y: glider.y,
        vx: Math.cos(a) * v - scroll * 0.3,
        vy: Math.sin(a) * v,
        life: max,
        max,
        color: Math.random() < 0.6 ? '#ff6b4d' : ACCENT,
        size: 2 + Math.random() * 3,
      })
    }
  }

  function updateParticles(dt) {
    for (const p of particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.life -= dt
    }
    particles = particles.filter((p) => p.life > 0)
  }

  // ── Autopilot ─────────────────────────────────────────────────────────
  function autopilot() {
    // Aim at the first gate the glider hasn't yet cleared; when it's still far
    // off, that's the gate dead ahead — hover onto its (possibly moving) centre.
    let target = H / 2
    for (const g of gates) {
      if (g.x + g.w > GX - 4) {
        target = g.gapY
        break
      }
    }
    thrustUp = wantThrust(glider.y, glider.vy, target)
    diving = false
  }

  // ── Simulation ────────────────────────────────────────────────────────
  function crash(now) {
    gameOver = true
    gameOverAt = now
    shudder = 1
    crashBurst()
  }

  function tick(dt, now) {
    flash = Math.max(0, flash - dt * 3)
    shudder = Math.max(0, shudder - dt * 2.5)

    if (now - lastHumanInput > AUTOPILOT_IDLE_MS) autopilot()

    // Glider physics: gravity down, thrust up, optional dive.
    let a = GRAVITY
    if (thrustUp) a -= THRUST
    if (diving) a += DIVE
    glider.vy = clamp(glider.vy + a * dt, -MAX_VY, MAX_VY)
    glider.y += glider.vy * dt
    if (thrustUp && Math.random() < 0.8) trail()

    // Crash into the ceiling or floor.
    if (glider.y - GR < 0 || glider.y + GR > H) {
      glider.y = clamp(glider.y, GR, H - GR)
      return crash(now)
    }

    // Scroll gates and the parallax layers left.
    for (const g of gates) {
      g.x -= scroll * dt
      if (g.amp) g.gapY = clamp(g.baseY + g.amp * Math.sin(now / 700 + g.phase), g.half + 20, H - g.half - 20)
      // Score the moment a gate's trailing edge clears the glider.
      if (!g.passed && g.x + g.w < GX - GR) {
        g.passed = true
        score += 10
        gatesPassed++
        flash = 1
        level = levelOf(gatesPassed)
        scroll = scrollFor(level)
      }
    }
    // Recycle passed gates, keep the runway full ahead.
    gates = gates.filter((g) => g.x + g.w > -20)
    const rightmost = gates.length ? gates[gates.length - 1].x : GX
    if (rightmost < W + SPACING) gates.push(makeGate(rightmost + SPACING))

    for (const s of stars) {
      s.x -= scroll * s.depth * 0.35 * dt
      if (s.x < -2) {
        s.x = W + 2
        s.y = Math.random() * H
      }
    }
    for (const b of skyline) {
      b.x -= scroll * 0.12 * dt
      if (b.x + b.w < -4) b.x += W + 240
    }

    // Pylon collision: while horizontally overlapping a gate, stay in the gap.
    for (const g of gates) {
      if (GX + GR > g.x && GX - GR < g.x + g.w && !clearsGap(glider.y, GR, g.gapY, g.half)) {
        return crash(now)
      }
    }

    updateParticles(dt)
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

  function drawStars() {
    for (const s of stars) {
      ctx.globalAlpha = 0.2 + s.depth * 0.4
      ctx.fillStyle = '#cfe4ff'
      ctx.fillRect(s.x, s.y, s.r, s.r)
    }
    ctx.globalAlpha = 1
  }

  function drawSkyline() {
    ctx.fillStyle = 'rgba(30, 44, 82, 0.55)'
    for (const b of skyline) {
      ctx.fillRect(b.x, H - b.h, b.w, b.h)
    }
    // A few window lights for depth.
    ctx.fillStyle = 'rgba(255, 184, 77, 0.16)'
    for (const b of skyline) {
      for (let wy = H - b.h + 8; wy < H - 6; wy += 16) {
        if ((Math.floor(b.x) + wy) % 3 === 0) ctx.fillRect(b.x + 5, wy, 4, 5)
      }
    }
  }

  function drawGates() {
    for (const g of gates) {
      const topH = g.gapY - g.half
      const botY = g.gapY + g.half
      ctx.save()
      ctx.shadowColor = ACCENT
      ctx.shadowBlur = 16
      const grad = ctx.createLinearGradient(g.x, 0, g.x + g.w, 0)
      grad.addColorStop(0, 'rgba(255, 184, 77, 0.12)')
      grad.addColorStop(0.5, 'rgba(255, 184, 77, 0.5)')
      grad.addColorStop(1, 'rgba(255, 184, 77, 0.12)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.roundRect(g.x, -20, g.w, topH + 20, [0, 0, 8, 8])
      ctx.roundRect(g.x, botY, g.w, H - botY + 20, [8, 8, 0, 0])
      ctx.fill()
      // Bright rims framing the gap.
      ctx.shadowBlur = 22
      ctx.strokeStyle = '#ffe6b0'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.moveTo(g.x + 2, topH)
      ctx.lineTo(g.x + g.w - 2, topH)
      ctx.moveTo(g.x + 2, botY)
      ctx.lineTo(g.x + g.w - 2, botY)
      ctx.stroke()
      ctx.restore()
    }
  }

  function drawGlider(now) {
    ctx.save()
    ctx.translate(GX, glider.y)
    ctx.rotate(clamp(glider.vy / MAX_VY, -1, 1) * 0.5)
    ctx.shadowColor = ACCENT
    ctx.shadowBlur = 18
    // Delta-wing body.
    ctx.fillStyle = 'rgba(255, 184, 77, 0.16)'
    ctx.strokeStyle = '#ffe0a3'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(18, 0)
    ctx.lineTo(-14, -11)
    ctx.lineTo(-7, 0)
    ctx.lineTo(-14, 11)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    // Cockpit glow.
    ctx.shadowBlur = 10
    ctx.fillStyle = '#fff4dc'
    ctx.beginPath()
    ctx.arc(4, 0, 2.6, 0, Math.PI * 2)
    ctx.fill()
    // Engine flare when climbing.
    if (thrustUp) {
      const len = 10 + Math.random() * 10
      ctx.shadowColor = '#ff7a3c'
      ctx.strokeStyle = '#ff9a4d'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(-9, -4)
      ctx.lineTo(-9 - len, 0)
      ctx.lineTo(-9, 4)
      ctx.stroke()
    }
    ctx.restore()
    void now
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max)
      ctx.fillStyle = p.color
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
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
    ctx.fillText('GATES', W - 16, 18)
    ctx.fillStyle = '#eaf2ff'
    ctx.font = `700 16px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText(String(score).padStart(5, '0'), 16, 33)
    ctx.textAlign = 'right'
    ctx.fillText(String(gatesPassed), W - 16, 33)
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
    ctx.save()
    if (shudder > 0) {
      ctx.translate((Math.random() - 0.5) * shudder * 14, (Math.random() - 0.5) * shudder * 14)
    }
    drawStars()
    drawSkyline()
    drawGates()
    drawParticles()
    drawGlider(now)

    // Gate-pass flash — a quick bright sweep at the glider's lane.
    if (flash > 0) {
      ctx.globalAlpha = flash * 0.5
      ctx.fillStyle = ACCENT
      ctx.fillRect(GX - 40, 0, 80, H)
      ctx.globalAlpha = 1
    }

    drawHud()
    ctx.restore()

    if (gameOver) {
      overlay('CRASHED', 'restarting…', '#ff6b4d', true)
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
    if (playing && !gameOver) {
      tick(dt, now)
    } else if (playing) {
      // Let the crash debris settle and the shake decay behind the card.
      updateParticles(dt)
      shudder = Math.max(0, shudder - dt * 2.5)
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

    ok(levelOf(0) === 1 && levelOf(9) === 1 && levelOf(10) === 2, 'level ramps every 10 gates')
    ok(gapHalfFor(1) === 118 && gapHalfFor(20) === 74, 'gap tightens then floors')
    ok(scrollFor(1) === 190 && scrollFor(100) === 360, 'scroll speeds up then caps')

    ok(clearsGap(300, 12, 300, 100), 'centred glider clears a wide gap')
    ok(!clearsGap(300, 12, 300, 8), 'a gap narrower than the glider is a crash')
    ok(!clearsGap(410, 12, 300, 100), 'glider below the gap crashes')

    // PD autopilot: below the target (target above) → thrust up; above → coast.
    ok(wantThrust(400, 0, 200), 'AI thrusts when the gap is above it')
    ok(!wantThrust(200, 0, 400), 'AI coasts down when the gap is below it')
    ok(wantThrust(300, 300, 300), 'AI thrusts to arrest a fast descent through centre')
    ok(!wantThrust(300, -300, 300), 'AI coasts while already rising through centre')

    console.log('[glider] selftest passed')
    document.getElementById('status').textContent = 'selftest passed ✓'
  }
})()
