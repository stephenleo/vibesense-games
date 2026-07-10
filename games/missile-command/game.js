// Missile Command — bundled VibeSense game. Runs while the Claude agent
// executes; freezes when it needs you. Input over SSE from the vibesense
// host: left stick flies the crosshair (both axes), R2/L2 fires an
// interceptor that detonates at the crosshair — an expanding blast ring that
// vaporizes warheads and chains into their own explosions. When nobody's on
// the controller, an autopilot triages the most urgent warhead and fires at
// a lead point on its path, so the cities survive long agent runs.
// Keyboard fallback (arrows + space) for development. `?play` forces the
// playing state so the game is testable without a host.

;(() => {
  'use strict'

  // ── Pure logic (unit-testable, no I/O) ────────────────────────────────
  const W = 800
  const H = 600
  const GROUND_Y = 552
  const BATTERY = { x: W / 2, y: GROUND_Y - 10 }
  const BLAST_R = 55

  // Blast ring radius over its lifetime: grow, hold, collapse. Zero once dead.
  function blastRadius(age) {
    if (age < 0 || age >= 1.0) return 0
    if (age < 0.4) return BLAST_R * (age / 0.4)
    if (age < 0.65) return BLAST_R
    return BLAST_R * (1 - (age - 0.65) / 0.35)
  }

  // One-step intercept estimate: fire at where the warhead will be when the
  // interceptor gets there.
  function leadPoint(sx, sy, tx, ty, tvx, tvy, shotSpeed) {
    const t = Math.hypot(tx - sx, ty - sy) / shotSpeed
    return { x: tx + tvx * t, y: ty + tvy * t }
  }

  // Split a MIRV warhead into `n` children fanning toward distinct targets.
  function mirvChildren(w, targets, speed) {
    return targets.map((t) => {
      const d = Math.hypot(t.x - w.x, GROUND_Y - w.y)
      return {
        x: w.x,
        y: w.y,
        sx: w.x,
        sy: w.y,
        vx: ((t.x - w.x) / d) * speed,
        vy: ((GROUND_Y - w.y) / d) * speed,
        tx: t.x,
        mirvAt: 0,
      }
    })
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

  const ACCENT = '#f87171'
  const CITY_X = [110, 210, 310, 490, 590, 690]
  const CROSSHAIR_SPEED = 520
  const SHOT_SPEED = 640
  const FIRE_COOLDOWN = 0.3
  const MAX_SHOTS = 3
  const AUTOPILOT_IDLE_MS = 2500

  let playing = false
  let cities = CITY_X.map((x) => ({ x, alive: true }))
  let warheads = [] // {x, y, sx, sy, vx, vy, tx, mirvAt, claimedUntil?}
  let shots = [] // interceptors {x, y, tx, ty, vx, vy}
  let blasts = [] // {x, y, age}
  let particles = []
  let stars = []
  let cross = { x: W / 2, y: 260 }
  let stickX = 0
  let stickY = 0
  let keyX = 0
  let keyY = 0
  let fireTimer = 0
  let score = 0
  let wave = 0
  let waveQueue = 0 // warheads still to spawn this wave
  let spawnTimer = 0
  let waveBreak = 0 // countdown between waves
  let banner = { text: '', t: 0 }
  let flash = 0 // full-screen flash on a city death
  let shake = { t: 0, mag: 0 }
  let gameOver = false
  let gameOverAt = 0
  let lastHumanInput = 0

  for (let i = 0; i < 80; i++) {
    stars.push({ x: Math.random() * W, y: Math.random() * (GROUND_Y - 60), tw: Math.random() * 7 })
  }

  const aliveCities = () => cities.filter((c) => c.alive)

  function spawnWarhead() {
    const targets = aliveCities()
    const t = targets[Math.floor(Math.random() * targets.length)]
    const x = 40 + Math.random() * (W - 80)
    const speed = 34 + wave * 7 + Math.random() * 18
    const d = Math.hypot(t.x - x, GROUND_Y)
    warheads.push({
      x,
      y: 0,
      sx: x,
      sy: 0,
      vx: ((t.x - x) / d) * speed,
      vy: (GROUND_Y / d) * speed,
      tx: t.x,
      // A third of warheads MIRV-split partway down.
      mirvAt: Math.random() < 0.33 ? 140 + Math.random() * 120 : 0,
    })
  }

  function startWave() {
    wave++
    waveQueue = 6 + wave * 2
    spawnTimer = 0.5
    banner = { text: `WAVE ${wave}`, t: 1.5 }
  }

  function reset() {
    cities = CITY_X.map((x) => ({ x, alive: true }))
    warheads = []
    shots = []
    blasts = []
    particles = []
    score = 0
    wave = 0
    waveBreak = 0
    gameOver = false
    startWave()
  }
  reset()

  // ── Input: SSE from the vibesense host ────────────────────────────────
  function fire() {
    lastHumanInput = performance.now()
    if (gameOver) return reset()
    if (fireTimer > 0 || shots.length >= MAX_SHOTS) return
    fireTimer = FIRE_COOLDOWN
    const d = Math.hypot(cross.x - BATTERY.x, cross.y - BATTERY.y) || 1
    shots.push({
      x: BATTERY.x,
      y: BATTERY.y,
      tx: cross.x,
      ty: cross.y,
      vx: ((cross.x - BATTERY.x) / d) * SHOT_SPEED,
      vy: ((cross.y - BATTERY.y) / d) * SHOT_SPEED,
    })
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
        if (msg.axis === 'left_x') stickX = Math.abs(msg.value) > 0.15 ? msg.value : 0
        else if (msg.axis === 'left_y') stickY = Math.abs(msg.value) > 0.15 ? msg.value : 0
        if (stickX || stickY) lastHumanInput = performance.now()
      } else if (msg.kind === 'button' && (msg.button === 'r2' || msg.button === 'l2')) {
        if (msg.pressed) fire()
      }
    } else if (msg.type === 'reload') {
      location.href = msg.url // controller swapped games — load the new one
    }
  }
  events.onerror = () => setStatus('host disconnected — is vibesense running?', false)

  // Keyboard fallback for development.
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') keyX = -1
    else if (e.key === 'ArrowRight') keyX = 1
    else if (e.key === 'ArrowUp') keyY = -1
    else if (e.key === 'ArrowDown') keyY = 1
    else if (e.key === ' ') fire()
    else return
    lastHumanInput = performance.now()
  })
  addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' && keyX === -1) keyX = 0
    if (e.key === 'ArrowRight' && keyX === 1) keyX = 0
    if (e.key === 'ArrowUp' && keyY === -1) keyY = 0
    if (e.key === 'ArrowDown' && keyY === 1) keyY = 0
  })

  function setPlaying(next) {
    playing = next
    setStatus(
      playing ? 'agent executing — defend the cities!' : 'claude needs you — controller is on the terminal',
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
  function burst(x, y, color, n = 14) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const v = 40 + Math.random() * 150
      const max = 0.4 + Math.random() * 0.5
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 30, life: max, max, color })
    }
  }

  // ── Autopilot ─────────────────────────────────────────────────────────
  function autopilot(now, dt) {
    if (gameOver) return
    // Most urgent unclaimed warhead that still threatens a live city — shots
    // spent on duds aimed at rubble are shots not defending the skyline.
    let target = null
    let urgency = Infinity
    for (const w of warheads) {
      if (w.claimedUntil && now < w.claimedUntil) continue
      if (!cities.some((c) => c.alive && Math.abs(c.x - w.tx) < 34) && !w.mirvAt) continue
      const tti = (GROUND_Y - w.y) / w.vy
      if (tti < urgency) {
        urgency = tti
        target = w
      }
    }
    if (!target) return
    const aim = leadPoint(BATTERY.x, BATTERY.y, target.x, target.y, target.vx, target.vy, SHOT_SPEED)
    aim.y = Math.max(60, Math.min(GROUND_Y - 60, aim.y))
    const dx = aim.x - cross.x
    const dy = aim.y - cross.y
    const d = Math.hypot(dx, dy)
    const step = CROSSHAIR_SPEED * dt
    if (d > step) {
      cross.x += (dx / d) * step
      cross.y += (dy / d) * step
    } else {
      cross.x = aim.x
      cross.y = aim.y
    }
    if (d < 22 && fireTimer <= 0 && shots.length < MAX_SHOTS) {
      // Claim it long enough for the shot to arrive and the blast to bloom.
      target.claimedUntil = now + (Math.hypot(aim.x - BATTERY.x, aim.y - BATTERY.y) / SHOT_SPEED) * 1000 + 900
      fire()
    }
  }

  // ── Simulation ────────────────────────────────────────────────────────
  function killWarhead(i) {
    const w = warheads[i]
    warheads.splice(i, 1)
    score += 25 * wave
    blasts.push({ x: w.x, y: w.y, age: 0.15 }) // chain blast, slightly pre-grown
    burst(w.x, w.y, '#ffc46d', 8)
  }

  function cityHit(c) {
    c.alive = false
    flash = 0.5
    shake = { t: 0.5, mag: 10 }
    burst(c.x, GROUND_Y - 12, ACCENT, 30)
    burst(c.x, GROUND_Y - 12, '#ffc46d', 20)
    if (!aliveCities().length) {
      gameOver = true
      gameOverAt = performance.now()
    }
  }

  function tick(dt, now) {
    fireTimer = Math.max(0, fireTimer - dt)
    banner.t = Math.max(0, banner.t - dt)
    flash = Math.max(0, flash - dt)
    shake.t = Math.max(0, shake.t - dt)

    const idle = now - lastHumanInput > AUTOPILOT_IDLE_MS
    if (!gameOver) {
      if (idle) {
        autopilot(now, dt)
      } else {
        const vx = stickX !== 0 ? stickX : keyX
        const vy = stickY !== 0 ? stickY : keyY
        cross.x = Math.max(20, Math.min(W - 20, cross.x + vx * CROSSHAIR_SPEED * dt))
        cross.y = Math.max(40, Math.min(GROUND_Y - 40, cross.y + vy * CROSSHAIR_SPEED * dt))
      }
    }

    // Wave sequencing.
    if (!gameOver) {
      if (waveBreak > 0) {
        waveBreak -= dt
        if (waveBreak <= 0) startWave()
      } else if (waveQueue > 0) {
        spawnTimer -= dt
        if (spawnTimer <= 0) {
          spawnTimer = Math.max(0.45, 1.5 - wave * 0.08)
          spawnWarhead()
          waveQueue--
        }
      } else if (!warheads.length && !shots.length && !blasts.length) {
        const bonus = aliveCities().length * 100
        score += bonus
        banner = { text: `WAVE CLEAR · +${bonus}`, t: 1.6 }
        waveBreak = 2.2
      }
    }

    // Interceptors: fly to the aim point, then detonate.
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i]
      s.x += s.vx * dt
      s.y += s.vy * dt
      const remaining = (s.tx - s.x) * s.vx + (s.ty - s.y) * s.vy // sign flips past target
      if (remaining <= 0) {
        blasts.push({ x: s.tx, y: s.ty, age: 0 })
        shots.splice(i, 1)
      }
    }

    // Blasts age; anything inside a live ring dies (including MIRVs mid-split).
    for (let i = blasts.length - 1; i >= 0; i--) {
      blasts[i].age += dt
      if (blasts[i].age >= 1.0) blasts.splice(i, 1)
    }

    // Warheads: fall, maybe split, collide with blasts and the ground.
    for (let i = warheads.length - 1; i >= 0; i--) {
      const w = warheads[i]
      w.x += w.vx * dt
      w.y += w.vy * dt

      if (w.mirvAt && w.y >= w.mirvAt) {
        w.mirvAt = 0
        const others = aliveCities().filter((c) => c.x !== w.tx)
        const picks = []
        for (let k = 0; k < 2 && others.length; k++) {
          picks.push(others.splice(Math.floor(Math.random() * others.length), 1)[0])
        }
        if (picks.length) {
          const speed = Math.hypot(w.vx, w.vy)
          warheads.push(...mirvChildren(w, picks, speed))
        }
      }

      let dead = false
      for (const b of blasts) {
        const r = blastRadius(b.age)
        if (r > 0 && (w.x - b.x) ** 2 + (w.y - b.y) ** 2 < r * r) {
          dead = true
          break
        }
      }
      if (dead) {
        killWarhead(i)
        continue
      }

      if (w.y >= GROUND_Y) {
        warheads.splice(i, 1)
        blasts.push({ x: w.x, y: GROUND_Y - 4, age: 0.25 })
        const c = cities.find((c) => c.alive && Math.abs(c.x - w.x) < 34)
        if (c) cityHit(c)
        else burst(w.x, GROUND_Y - 4, '#8fa3c0', 10)
      }
    }

    for (const p of particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += 180 * dt
      p.life -= dt
    }
    particles = particles.filter((p) => p.life > 0)
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

  function drawSky(now) {
    for (const s of stars) {
      ctx.globalAlpha = 0.3 * (0.5 + 0.5 * Math.sin(now / 1000 + s.tw))
      ctx.fillStyle = '#cfe4ff'
      ctx.fillRect(s.x, s.y, 1.2, 1.2)
    }
    ctx.globalAlpha = 1
  }

  function drawGround() {
    const g = ctx.createLinearGradient(0, GROUND_Y, 0, H)
    g.addColorStop(0, '#1a2440')
    g.addColorStop(1, '#0a0f22')
    ctx.fillStyle = g
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y)
    ctx.save()
    ctx.shadowColor = '#4d6dff'
    ctx.shadowBlur = 8
    ctx.strokeStyle = 'rgba(120, 150, 255, 0.5)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(0, GROUND_Y)
    ctx.lineTo(W, GROUND_Y)
    ctx.stroke()
    ctx.restore()

    // Battery: a small glowing pyramid at center.
    ctx.save()
    ctx.shadowColor = ACCENT
    ctx.shadowBlur = 12
    ctx.fillStyle = '#2a3558'
    ctx.strokeStyle = '#9fb3e8'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(BATTERY.x - 26, GROUND_Y)
    ctx.lineTo(BATTERY.x, GROUND_Y - 24)
    ctx.lineTo(BATTERY.x + 26, GROUND_Y)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  // Tiny procedural skyline per city — deterministic from its x.
  function drawCity(c) {
    const heights = [14, 22, 17, 26, 12, 19]
    ctx.save()
    if (c.alive) {
      ctx.shadowColor = '#7dd3fc'
      ctx.shadowBlur = 10
      ctx.fillStyle = '#173049'
    } else {
      ctx.fillStyle = '#141a2e'
    }
    for (let i = 0; i < 6; i++) {
      const bw = 9
      const bh = c.alive ? heights[(i + Math.floor(c.x / 100)) % 6] : 4 + (i % 3) * 2
      ctx.fillRect(c.x - 27 + i * bw, GROUND_Y - bh, bw - 1.5, bh)
    }
    if (c.alive) {
      // Lit windows.
      ctx.fillStyle = 'rgba(125, 211, 252, 0.7)'
      for (let i = 0; i < 6; i++) {
        ctx.fillRect(c.x - 24 + i * 9, GROUND_Y - 9 - (i % 3) * 5, 2, 2)
      }
    }
    ctx.restore()
  }

  function drawWarheads() {
    for (const w of warheads) {
      const grad = ctx.createLinearGradient(w.sx, w.sy, w.x, w.y)
      grad.addColorStop(0, 'rgba(248, 113, 113, 0)')
      grad.addColorStop(0.7, 'rgba(248, 113, 113, 0.35)')
      grad.addColorStop(1, 'rgba(255, 196, 109, 0.9)')
      ctx.strokeStyle = grad
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(w.sx, w.sy)
      ctx.lineTo(w.x, w.y)
      ctx.stroke()
      ctx.save()
      ctx.shadowColor = '#ffc46d'
      ctx.shadowBlur = 10
      ctx.fillStyle = '#fff3d6'
      ctx.beginPath()
      ctx.arc(w.x, w.y, 2.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  }

  function drawShots() {
    for (const s of shots) {
      const grad = ctx.createLinearGradient(BATTERY.x, BATTERY.y, s.x, s.y)
      grad.addColorStop(0, 'rgba(125, 211, 252, 0)')
      grad.addColorStop(1, 'rgba(125, 211, 252, 0.8)')
      ctx.strokeStyle = grad
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(BATTERY.x, BATTERY.y)
      ctx.lineTo(s.x, s.y)
      ctx.stroke()
      ctx.save()
      ctx.shadowColor = '#7dd3fc'
      ctx.shadowBlur = 10
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(s.x, s.y, 2.6, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      // Aim marker where it will detonate.
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.5)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(s.tx - 5, s.ty)
      ctx.lineTo(s.tx + 5, s.ty)
      ctx.moveTo(s.tx, s.ty - 5)
      ctx.lineTo(s.tx, s.ty + 5)
      ctx.stroke()
    }
  }

  function drawBlasts(now) {
    for (const b of blasts) {
      const r = blastRadius(b.age)
      if (r <= 0) continue
      const flicker = 0.9 + 0.1 * Math.sin(now / 24 + b.x)
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r)
      g.addColorStop(0, `rgba(255, 255, 255, ${0.95 * flicker})`)
      g.addColorStop(0.45, `rgba(255, 196, 109, ${0.8 * flicker})`)
      g.addColorStop(0.8, `rgba(248, 113, 113, ${0.5 * flicker})`)
      g.addColorStop(1, 'rgba(248, 113, 113, 0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  function drawCrosshair(now) {
    const pulse = 0.7 + 0.3 * Math.sin(now / 200)
    ctx.save()
    ctx.shadowColor = ACCENT
    ctx.shadowBlur = 10
    ctx.strokeStyle = `rgba(248, 113, 113, ${pulse})`
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.arc(cross.x, cross.y, 11, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      ctx.moveTo(cross.x + dx * 6, cross.y + dy * 6)
      ctx.lineTo(cross.x + dx * 16, cross.y + dy * 16)
    }
    ctx.stroke()
    ctx.restore()
  }

  function drawHud() {
    ctx.fillStyle = '#8fa3c0'
    ctx.font = `600 13px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText('SCORE', 16, 18)
    ctx.textAlign = 'center'
    ctx.fillText(`WAVE ${wave}`, W / 2, 18)
    ctx.textAlign = 'right'
    ctx.fillText(`CITIES ${aliveCities().length}`, W - 16, 18)
    ctx.fillStyle = '#eaf2ff'
    ctx.font = `700 16px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText(String(score).padStart(6, '0'), 16, 33)
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
      ctx.fillText(`SCORE ${score} · WAVE ${wave}`, W / 2, cy + 100)
    }
    ctx.fillStyle = '#8fa3c0'
    ctx.font = `500 14px ${FONT}`
    ctx.fillText(sub, W / 2, cy + ch - 38)
  }

  function render(now) {
    ctx.clearRect(0, 0, W, H)
    ctx.save()
    if (shake.t > 0) {
      const m = shake.mag * (shake.t / 0.5)
      ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m)
    }
    drawSky(now)
    drawGround()
    for (const c of cities) drawCity(c)
    drawWarheads()
    drawShots()
    drawBlasts(now)

    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max)
      ctx.fillStyle = p.color
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4)
    }
    ctx.globalAlpha = 1

    if (!gameOver) drawCrosshair(now)
    drawHud()

    if (banner.t > 0) {
      ctx.globalAlpha = Math.min(1, banner.t / 0.4)
      ctx.fillStyle = '#ffe1e1'
      ctx.font = `700 36px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText(banner.text, W / 2, 180)
      ctx.globalAlpha = 1
    }
    if (flash > 0) {
      ctx.fillStyle = `rgba(255, 120, 100, ${flash * 0.25})`
      ctx.fillRect(0, 0, W, H)
    }
    ctx.restore()

    if (gameOver) {
      overlay('THE END', 'R2 / SPACE to defend again — restarting…', ACCENT, true)
    } else if (!playing) {
      overlay('PAUSED', 'claude needs you — answer in the terminal', ACCENT, false)
    }
  }

  // ── Main loop ─────────────────────────────────────────────────────────
  let last = performance.now()
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (gameOver && now - gameOverAt > 4500) reset()
    if (playing) tick(dt, now)
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

    ok(blastRadius(0) === 0 && blastRadius(1.0) === 0, 'blast starts and ends at zero')
    ok(near(blastRadius(0.4), BLAST_R) && near(blastRadius(0.6), BLAST_R), 'blast holds at full size')
    ok(blastRadius(0.2) > 0 && blastRadius(0.2) < BLAST_R, 'blast grows through the ramp')
    ok(blastRadius(-0.1) === 0, 'unborn blast has no radius')

    const still = leadPoint(400, 540, 200, 100, 0, 0, 600)
    ok(near(still.x, 200) && near(still.y, 100), 'stationary target needs no lead')
    const falling = leadPoint(400, 540, 200, 100, 0, 50, 600)
    ok(falling.y > 100 && near(falling.x, 200), 'falling target is led downward')

    const kids = mirvChildren({ x: 300, y: 200 }, [{ x: 100 }, { x: 700 }], 60)
    ok(kids.length === 2, 'MIRV splits into one child per target')
    ok(kids[0].vx < 0 && kids[1].vx > 0, 'children fan toward their targets')
    ok(
      kids.every((k) => near(Math.hypot(k.vx, k.vy), 60, 1e-9)),
      'children keep the parent speed',
    )
    ok(kids.every((k) => k.vy > 0), 'children keep falling')

    console.log('[missile-command] selftest passed')
    document.getElementById('status').textContent = 'selftest passed ✓'
  }
})()
