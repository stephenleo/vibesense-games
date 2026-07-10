// Rally — Pong evolved, a bundled VibeSense game. Runs while the Claude agent
// executes; freezes when it needs you. Input over SSE from the vibesense host:
// left stick Y slides your paddle, R2 SMASHES the ball on contact for a speed
// burst, L2 lobs a defensive backspin. Rallies speed the ball up; paddle
// motion imparts spin. First to 7 wins the match. Untouched controller hands
// your paddle to an autopilot that plays a touch sharper than the rival, so the
// demo usually wins its rallies.
// Keyboard fallback (arrows/WASD + space + shift) for development. `?play`
// forces the playing state so the game is testable without a host.

;(() => {
  'use strict'

  // ── Pure logic (unit-testable, no I/O) ────────────────────────────────
  const W = 800
  const H = 600
  const PADDLE_W = 14
  const PADDLE_H = 96
  const PADDLE_X = 34 // gap from wall to a paddle's outer edge
  const BALL_R = 9
  const WIN = 7

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

  // Where a paddle's playing face sits on x, given its side.
  const faceX = (side) => (side === 'left' ? PADDLE_X + PADDLE_W : W - PADDLE_X - PADDLE_W)

  // Ball overlaps a paddle whose center-y is `py`, moving toward that side.
  function hitsPaddle(ball, py, side) {
    const face = faceX(side)
    const toward = side === 'left' ? ball.vx < 0 : ball.vx > 0
    if (!toward) return false
    const reach = side === 'left' ? ball.x - BALL_R <= face && ball.x - BALL_R >= face - 26 : ball.x + BALL_R >= face && ball.x + BALL_R <= face + 26
    return reach && Math.abs(ball.y - py) <= PADDLE_H / 2 + BALL_R
  }

  // Contact offset in [-1, 1]: 0 at paddle center, ±1 at the tips. Drives the
  // rebound angle, exactly like the original — hit near a tip to steepen it.
  const contactOffset = (ballY, py) => clamp((ballY - py) / (PADDLE_H / 2), -1, 1)

  if (location.search.includes('selftest')) return selftest()

  // ── Setup ─────────────────────────────────────────────────────────────
  const canvas = document.getElementById('game')
  const ctx = canvas.getContext('2d')
  const statusEl = document.getElementById('status')

  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = W * dpr
  canvas.height = H * dpr
  ctx.scale(dpr, dpr)

  const ACCENT = '#4de3ff' // you
  const RIVAL = '#ff5e7d' // the adaptive opponent
  const BASE_SPEED = 380
  const MAX_SPEED = 820
  const RALLY_ACCEL = 1.045 // ball speeds up on every paddle touch
  const MAX_BOUNCE = 0.95 // rad off horizontal at a tip hit
  const SPIN = 0.22 // how much paddle motion bleeds into the ball's vy
  const SMASH_BOOST = 1.55 // R2 on contact
  const PLAYER_SPEED = 560 // human paddle at full stick
  const AI_YOU = 510 // your autopilot tracking speed…
  const AI_RIVAL = 355 // …deliberately quicker than the rival's
  const AUTOPILOT_IDLE_MS = 2500

  let playing = false
  let you = { y: H / 2, vy: 0 }
  let rival = { y: H / 2, vy: 0 }
  let ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 }
  let rally = 0
  let scoreYou = 0
  let scoreRival = 0
  let serveTimer = 0.6 // ball parks at center, then launches
  let serveDir = 1
  let matchOver = false
  let matchOverAt = 0
  let winner = ''
  let banner = { text: '', t: 0 }
  let particles = [] // {x, y, vx, vy, life, max, color}
  let trail = [] // recent ball positions {x, y}
  let flash = 0 // brief screen-edge flash on a smash
  let lastHumanInput = 0
  let stickY = 0
  let keyDir = 0
  let smash = false
  let lob = false

  function serve(dir) {
    ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 }
    serveDir = dir
    serveTimer = 0.45
    rally = 0
    trail = []
  }

  function launch() {
    const a = (Math.random() - 0.5) * 0.7 // shallow opening angle
    ball.vx = serveDir * Math.cos(a) * BASE_SPEED
    ball.vy = Math.sin(a) * BASE_SPEED
  }

  function reset() {
    scoreYou = 0
    scoreRival = 0
    matchOver = false
    winner = ''
    you = { y: H / 2, vy: 0 }
    rival = { y: H / 2, vy: 0 }
    particles = []
    banner = { text: 'FIRST TO 7', t: 1.6 }
    serve(1) // open by serving at the rival so the demo starts on the attack
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
      if (msg.kind === 'axis' && msg.axis === 'left_y') {
        stickY = Math.abs(msg.value) > 0.18 ? msg.value : 0
        if (stickY !== 0) lastHumanInput = performance.now()
      } else if (msg.kind === 'button') {
        if (msg.button === 'r2') {
          smash = msg.pressed
          if (msg.pressed) {
            lastHumanInput = performance.now()
            if (matchOver) reset()
          }
        } else if (msg.button === 'l2') {
          lob = msg.pressed
          if (msg.pressed) {
            lastHumanInput = performance.now()
            if (matchOver) reset()
          }
        }
      }
    } else if (msg.type === 'reload') {
      location.href = msg.url // controller swapped games — load the new one
    }
  }
  events.onerror = () => setStatus('host disconnected — is vibesense running?', false)

  // Keyboard fallback for development.
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'w') keyDir = -1
    else if (e.key === 'ArrowDown' || e.key === 's') keyDir = 1
    else if (e.key === ' ') {
      smash = true
      if (matchOver) reset()
    } else if (e.key === 'Shift') lob = true
    else return
    lastHumanInput = performance.now()
  })
  addEventListener('keyup', (e) => {
    if ((e.key === 'ArrowUp' || e.key === 'w') && keyDir === -1) keyDir = 0
    if ((e.key === 'ArrowDown' || e.key === 's') && keyDir === 1) keyDir = 0
    if (e.key === ' ') smash = false
    if (e.key === 'Shift') lob = false
  })

  function setPlaying(next) {
    playing = next
    setStatus(
      playing ? 'agent executing — win the rally!' : 'claude needs you — controller is on the terminal',
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
  function burst(x, y, color, n = 12) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const v = 60 + Math.random() * 190
      const max = 0.3 + Math.random() * 0.4
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: max, max, color })
    }
  }

  // ── Paddle control ────────────────────────────────────────────────────
  function drivePaddle(p, targetVy, dt) {
    p.vy = targetVy
    p.y = clamp(p.y + targetVy * dt, PADDLE_H / 2, H - PADDLE_H / 2)
  }

  // Track the ball at `speed`, but only chase hard when it's coming at you —
  // otherwise ease back toward center. `chaseAway` keeps YOUR autopilot glued
  // to the ball even on the return, which is the edge it holds over the rival.
  function trackBall(p, dt, speed, coming, chaseAway) {
    const goal = coming || chaseAway ? ball.y : H / 2
    const d = goal - p.y
    const vy = Math.abs(d) < 6 ? 0 : Math.sign(d) * speed
    drivePaddle(p, vy, dt)
  }

  // ── Ball rebound off a paddle ─────────────────────────────────────────
  function rebound(p, side, boosted) {
    const off = contactOffset(ball.y, p.y)
    let speed = Math.hypot(ball.vx, ball.vy) * RALLY_ACCEL
    if (boosted) speed *= SMASH_BOOST
    speed = Math.min(MAX_SPEED, speed)
    const dir = side === 'left' ? 1 : -1
    const angle = off * MAX_BOUNCE
    ball.vx = dir * Math.cos(angle) * speed
    ball.vy = Math.sin(angle) * speed + p.vy * SPIN
    ball.x = side === 'left' ? faceX('left') + BALL_R : faceX('right') - BALL_R
    rally++
    const spark = boosted ? '#ffffff' : side === 'left' ? ACCENT : RIVAL
    burst(ball.x, ball.y, spark, boosted ? 24 : 12)
    if (boosted) flash = 0.28
  }

  // ── Simulation ────────────────────────────────────────────────────────
  function point(scorer, now) {
    burst(ball.x, ball.y, scorer === 'you' ? ACCENT : RIVAL, 22)
    if (scorer === 'you') scoreYou++
    else scoreRival++
    if (scoreYou >= WIN || scoreRival >= WIN) {
      matchOver = true
      matchOverAt = now
      winner = scoreYou >= WIN ? 'you' : 'rival'
      return
    }
    banner = { text: `${scoreYou} — ${scoreRival}`, t: 0.9 }
    serve(scorer === 'you' ? -1 : 1) // serve toward whoever just conceded
  }

  function tick(dt, now) {
    banner.t = Math.max(0, banner.t - dt)
    flash = Math.max(0, flash - dt)

    const idle = now - lastHumanInput > AUTOPILOT_IDLE_MS
    const comingYou = ball.vx < 0
    const comingRival = ball.vx > 0

    // Your paddle: human stick when touched, sharp autopilot otherwise.
    if (idle) {
      trackBall(you, dt, AI_YOU, comingYou, true)
    } else {
      const input = stickY !== 0 ? stickY : keyDir
      drivePaddle(you, input * PLAYER_SPEED, dt)
    }
    // Rival: always the adaptive AI, a step slower so demos tend to win.
    trackBall(rival, dt, AI_RIVAL, comingRival, false)

    if (serveTimer > 0) {
      serveTimer -= dt
      ball.x = W / 2
      ball.y = H / 2
      if (serveTimer <= 0) launch()
      return
    }

    // Autopilot smashes when the ball is on top of your paddle; the rival never
    // does, so your returns bite harder during a demo.
    const autoSmash = idle && comingYou && ball.x < faceX('left') + 40

    ball.x += ball.vx * dt
    ball.y += ball.vy * dt

    // Top / bottom walls.
    if (ball.y - BALL_R < 0) {
      ball.y = BALL_R
      ball.vy = Math.abs(ball.vy)
      burst(ball.x, ball.y, '#8fa3c0', 6)
    } else if (ball.y + BALL_R > H) {
      ball.y = H - BALL_R
      ball.vy = -Math.abs(ball.vy)
      burst(ball.x, ball.y, '#8fa3c0', 6)
    }

    // Paddles.
    if (hitsPaddle(ball, you.y, 'left')) rebound(you, 'left', smash || autoSmash)
    else if (hitsPaddle(ball, rival.y, 'right')) rebound(rival, 'right', false)

    // Point scored.
    if (ball.x < -BALL_R) point('rival', now)
    else if (ball.x > W + BALL_R) point('you', now)

    // Trail + particles.
    trail.push({ x: ball.x, y: ball.y })
    if (trail.length > 16) trail.shift()
    for (const p of particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.life -= dt
    }
    particles = particles.filter((p) => p.life > 0)
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

  function drawCenterLine(now) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 500)
    ctx.save()
    ctx.shadowColor = ACCENT
    ctx.shadowBlur = 12 + pulse * 6
    ctx.strokeStyle = 'rgba(140, 210, 255, 0.35)'
    ctx.lineWidth = 3
    ctx.setLineDash([12, 16])
    ctx.beginPath()
    ctx.moveTo(W / 2, 12)
    ctx.lineTo(W / 2, H - 12)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }

  function drawPaddle(p, side, color) {
    const x = side === 'left' ? PADDLE_X : W - PADDLE_X - PADDLE_W
    const y = p.y - PADDLE_H / 2
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 18
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(x, y, PADDLE_W, PADDLE_H, 7)
    ctx.fill()
    // Cooler inner core for a little depth.
    ctx.shadowBlur = 0
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
    ctx.beginPath()
    ctx.roundRect(x + 4, y + 6, PADDLE_W - 8, PADDLE_H - 12, 4)
    ctx.fill()
    ctx.restore()
  }

  function drawBall() {
    // Neon trail, oldest → newest.
    for (let i = 0; i < trail.length; i++) {
      const t = trail[i]
      const f = i / trail.length
      ctx.globalAlpha = f * 0.5
      ctx.fillStyle = ACCENT
      ctx.beginPath()
      ctx.arc(t.x, t.y, BALL_R * (0.3 + f * 0.7), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    ctx.save()
    ctx.shadowColor = ACCENT
    ctx.shadowBlur = 22
    const g = ctx.createRadialGradient(ball.x - 3, ball.y - 3, 1, ball.x, ball.y, BALL_R)
    g.addColorStop(0, '#ffffff')
    g.addColorStop(0.5, '#d3f6ff')
    g.addColorStop(1, ACCENT)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  function drawHud() {
    ctx.textAlign = 'center'
    ctx.fillStyle = '#8fa3c0'
    ctx.font = `600 12px ${FONT}`
    ctx.fillText('FIRST TO 7', W / 2, 30)

    ctx.font = `700 46px ${FONT}`
    ctx.fillStyle = ACCENT
    ctx.fillText(String(scoreYou), W / 2 - 70, 62)
    ctx.fillStyle = RIVAL
    ctx.fillText(String(scoreRival), W / 2 + 70, 62)

    ctx.font = `600 12px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillStyle = ACCENT
    ctx.fillText('YOU', 16, 26)
    ctx.textAlign = 'right'
    ctx.fillStyle = RIVAL
    ctx.fillText('RIVAL', W - 16, 26)

    if (rally >= 3) {
      ctx.textAlign = 'center'
      ctx.fillStyle = '#eaf2ff'
      ctx.font = `700 13px ${FONT}`
      ctx.fillText(`RALLY ×${rally}`, W / 2, H - 18)
    }
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
      ctx.fillText(`YOU ${scoreYou} · RIVAL ${scoreRival}`, W / 2, cy + 100)
    }
    ctx.fillStyle = '#8fa3c0'
    ctx.font = `500 14px ${FONT}`
    ctx.fillText(sub, W / 2, cy + ch - 38)
  }

  function render(now) {
    ctx.clearRect(0, 0, W, H)
    drawCenterLine(now)
    drawPaddle(you, 'left', ACCENT)
    drawPaddle(rival, 'right', RIVAL)
    drawBall() // always on court — parked at center during a serve

    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max)
      ctx.fillStyle = p.color
      ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5)
    }
    ctx.globalAlpha = 1

    if (flash > 0) {
      ctx.globalAlpha = flash
      ctx.fillStyle = ACCENT
      ctx.fillRect(0, 0, W, 5)
      ctx.fillRect(0, H - 5, W, 5)
      ctx.globalAlpha = 1
    }

    drawHud()

    if (banner.t > 0 && !matchOver) {
      ctx.globalAlpha = Math.min(1, banner.t / 0.4)
      ctx.fillStyle = '#c9ecff'
      ctx.font = `700 40px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText(banner.text, W / 2, H / 2 - 40)
      ctx.globalAlpha = 1
    }

    if (matchOver) {
      overlay(winner === 'you' ? 'YOU WIN' : 'RIVAL WINS', 'new match…', winner === 'you' ? ACCENT : RIVAL, true)
    } else if (!playing) {
      overlay('PAUSED', 'claude needs you — answer in the terminal', ACCENT, false)
    }
  }

  // ── Main loop ─────────────────────────────────────────────────────────
  let last = performance.now()
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (matchOver && now - matchOverAt > 2000) reset()
    if (playing) {
      if (matchOver) {
        // Let the pyrotechnics settle behind the scoreboard card.
        for (const p of particles) {
          p.x += p.vx * dt
          p.y += p.vy * dt
          p.life -= dt
        }
        particles = particles.filter((p) => p.life > 0)
      } else {
        tick(dt, now)
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
    const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

    ok(clamp(5, 0, 10) === 5 && clamp(-1, 0, 10) === 0 && clamp(11, 0, 10) === 10, 'clamp bounds')
    ok(faceX('left') === PADDLE_X + PADDLE_W, 'left face at inner edge')
    ok(faceX('right') === W - PADDLE_X - PADDLE_W, 'right face at inner edge')

    ok(near(contactOffset(300, 300), 0), 'center hit is flat')
    ok(near(contactOffset(300 + PADDLE_H / 2, 300), 1), 'tip hit is full angle')
    ok(near(contactOffset(300 - PADDLE_H, 300), -1), 'past the tip clamps to -1')

    // A ball crossing the left face at the paddle's height, moving left, hits.
    ok(hitsPaddle({ x: faceX('left') + BALL_R - 1, y: 300, vx: -300, vy: 0 }, 300, 'left'), 'ball meets the left paddle')
    // Same ball moving away does not.
    ok(!hitsPaddle({ x: faceX('left') + BALL_R - 1, y: 300, vx: 300, vy: 0 }, 300, 'left'), 'no hit when moving away')
    // Ball level with the paddle's center but far off in y misses.
    ok(!hitsPaddle({ x: faceX('left') + BALL_R - 1, y: 100, vx: -300, vy: 0 }, 300, 'left'), 'no hit when out of paddle range')

    console.log('[rally] selftest passed')
    document.getElementById('status').textContent = 'selftest passed ✓'
  }
})()
