// Alien Defenders — the bundled VibeSense game.
// Auto-plays while the Claude agent executes; pauses when it needs you.
// Input arrives over SSE from the vibesense host (left stick = move, R2 = fire).
// Keyboard fallback (arrows + space) for development. `?play` forces the
// playing state so the game is testable without a host.

;(() => {
  'use strict'

  const canvas = document.getElementById('game')
  const ctx = canvas.getContext('2d')
  const statusEl = document.getElementById('status')

  // Logical resolution stays 800×600; backing store scales for HiDPI.
  const W = 800
  const H = 600
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = W * dpr
  canvas.height = H * dpr
  ctx.scale(dpr, dpr)

  // ── State ─────────────────────────────────────────────────────────────
  let playing = false
  let moveInput = 0 // -1..1 from stick or keyboard
  let firing = false
  let lastShot = 0

  const ship = { x: W / 2, y: H - 50, w: 40, h: 20, speed: 320 }
  let bullets = [] // {x, y}
  let bombs = [] // {x, y}
  let aliens = []
  let alienDir = 1
  let alienSpeed = 24
  let score = 0
  let lives = 3
  let wave = 1
  let gameOver = false
  let gameOverAt = 0
  let particles = [] // {x, y, vx, vy, life, max, color}
  let shake = 0
  let hitFlash = 0

  // ── Random formation ──────────────────────────────────────────────────
  // Every wave (and every restart) rolls fresh dimensions and a pattern, so
  // no two fleets look alike. Masks that come out too sparse fall back to a
  // full grid.
  function formationMask() {
    const rows = 4 + Math.floor(Math.random() * 3) // 4–6
    const cols = 8 + Math.floor(Math.random() * 5) // 8–12
    const midR = (rows - 1) / 2
    const midC = (cols - 1) / 2
    const type = Math.floor(Math.random() * 5)
    const half = Array.from({ length: rows }, () =>
      Array.from({ length: Math.ceil(cols / 2) }, () => Math.random() < 0.6),
    )
    const pyramid = (r, c) => Math.abs(c - midC) <= (r / (rows - 1)) * midC + 0.5
    const cell = (r, c) => {
      if (type === 0) return half[r][Math.min(c, cols - 1 - c)] // mirrored random
      if (type === 1)
        return Math.abs(r - midR) / (midR + 0.5) + Math.abs(c - midC) / (midC + 0.5) <= 1 // diamond
      if (type === 2) return Math.abs(c - midC) >= ((rows - 1 - r) / (rows - 1)) * midC - 0.5 // V wings
      if (type === 3) return pyramid(r, c)
      return Math.abs(Math.abs(r - midR) / (midR + 0.5) - Math.abs(c - midC) / (midC + 0.5)) < 0.3 // X cross
    }
    const build = (fn) => {
      const mask = []
      let count = 0
      for (let r = 0; r < rows; r++) {
        mask.push([])
        for (let c = 0; c < cols; c++) {
          const v = fn(r, c)
          mask[r].push(v)
          if (v) count++
        }
      }
      return { mask, count }
    }
    const { mask, count } = build(cell)
    // Too sparse to play? Fall back to a pyramid — still a shape, never a slab.
    if (count < 12) return { rows, cols, mask: build(pyramid).mask }
    return { rows, cols, mask }
  }

  function spawnWave() {
    aliens = []
    const { rows, cols, mask } = formationMask()
    const spacing = 56
    const x0 = W / 2 - ((cols - 1) * spacing) / 2
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (mask[r][c]) aliens.push({ x: x0 + c * spacing, y: 72 + r * 46, alive: true, row: r })
      }
    }
    alienDir = 1
    alienSpeed = 24 + (wave - 1) * 10
  }

  function reset() {
    score = 0
    lives = 3
    wave = 1
    gameOver = false
    bullets = []
    bombs = []
    particles = []
    ship.x = W / 2
    spawnWave()
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
      if (msg.kind === 'axis' && msg.axis === 'left_x') moveInput = msg.value
      if (msg.kind === 'button' && (msg.button === 'r2' || msg.button === 'l2')) {
        firing = msg.pressed
        if (msg.pressed && gameOver) reset()
      }
    } else if (msg.type === 'reload') {
      location.href = msg.url // controller swapped games — load the new one
    }
  }
  events.onerror = () => setStatus('host disconnected — is vibesense running?', false)

  // Keyboard fallback for development.
  const keys = {}
  addEventListener('keydown', (e) => {
    keys[e.key] = true
    if (e.key === ' ' && gameOver) reset()
  })
  addEventListener('keyup', (e) => (keys[e.key] = false))

  function setPlaying(next) {
    playing = next
    setStatus(
      playing ? 'agent executing — defend!' : 'claude needs you — controller is on the terminal',
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
  function burst(x, y, color, n = 16, speed = 180) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const v = speed * (0.3 + Math.random() * 0.7)
      const max = 0.35 + Math.random() * 0.4
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: max, max, color })
    }
  }

  function step(dt) {
    for (const p of particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += 60 * dt
      p.life -= dt
    }
    particles = particles.filter((p) => p.life > 0)
    if (gameOver) return

    const kb = (keys.ArrowLeft ? -1 : 0) + (keys.ArrowRight ? 1 : 0)
    const move = Math.abs(moveInput) > 0.15 ? moveInput : kb
    ship.x = Math.max(ship.w / 2, Math.min(W - ship.w / 2, ship.x + move * ship.speed * dt))

    const wantFire = firing || keys[' ']
    const now = performance.now()
    if (wantFire && now - lastShot > 280) {
      bullets.push({ x: ship.x, y: ship.y - 14 })
      lastShot = now
    }

    bullets = bullets.filter((b) => (b.y -= 480 * dt) > 0)
    bombs = bombs.filter((b) => (b.y += 220 * dt) < H)
    for (const b of bombs) b.x = b.x0 + Math.sin(b.y / 26 + b.phase) * 9 // weave as they fall

    // March the fleet; drop and reverse at the edges.
    const alive = aliens.filter((a) => a.alive)
    if (alive.length === 0) {
      wave++
      spawnWave()
      return
    }
    const minX = Math.min(...alive.map((a) => a.x))
    const maxX = Math.max(...alive.map((a) => a.x))
    if ((alienDir > 0 && maxX > W - 50) || (alienDir < 0 && minX < 50)) {
      alienDir *= -1
      for (const a of aliens) a.y += 22
    }
    for (const a of aliens) a.x += alienDir * alienSpeed * dt

    // Random bombs from the fleet.
    if (Math.random() < 0.9 * dt) {
      const shooter = alive[Math.floor(Math.random() * alive.length)]
      bombs.push({ x: shooter.x, y: shooter.y + 14, x0: shooter.x, phase: Math.random() * Math.PI * 2 })
    }

    // Collisions.
    for (const b of bullets) {
      for (const a of alive) {
        if (a.alive && Math.abs(b.x - a.x) < 22 && Math.abs(b.y - a.y) < 16) {
          a.alive = false
          b.y = -99
          score += 10 * wave
          burst(a.x, a.y, ROW_COLORS[a.row % ROW_COLORS.length])
        }
      }
    }
    for (const b of bombs) {
      if (Math.abs(b.x - ship.x) < ship.w / 2 && Math.abs(b.y - ship.y) < ship.h) {
        b.y = H + 99
        lives--
        shake = 12
        hitFlash = 0.5
        burst(ship.x, ship.y, '#4dff88', 24, 240)
        if (lives <= 0) {
          gameOver = true
          gameOverAt = performance.now()
        }
      }
    }
    if (alive.some((a) => a.y > ship.y - 30)) {
      gameOver = true
      gameOverAt = performance.now()
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  const ROW_COLORS = ['#ff4d6d', '#ffb347', '#4dff88', '#4dc9ff', '#c77dff']

  // Two-frame classic invader, pre-rendered per color with the glow baked in
  // so the frame loop is pure drawImage (per-alien shadowBlur is too slow).
  const SPRITE_FRAMES = [
    [
      '..X.....X..',
      '...X...X...',
      '..XXXXXXX..',
      '.XX.XXX.XX.',
      'XXXXXXXXXXX',
      'X.XXXXXXX.X',
      'X.X.....X.X',
      '...XX.XX...',
    ],
    [
      '..X.....X..',
      'X..X...X..X',
      'X.XXXXXXX.X',
      'XXX.XXX.XXX',
      'XXXXXXXXXXX',
      '.XXXXXXXXX.',
      '..X.....X..',
      '.X.......X.',
    ],
  ]

  function makeSprite(frame, color) {
    const px = 3 * dpr
    const pad = 8 * dpr
    const off = document.createElement('canvas')
    off.width = frame[0].length * px + pad * 2
    off.height = frame.length * px + pad * 2
    const g = off.getContext('2d')
    g.shadowColor = color
    g.shadowBlur = 8 * dpr
    g.fillStyle = color
    for (let y = 0; y < frame.length; y++) {
      for (let x = 0; x < frame[y].length; x++) {
        if (frame[y][x] === 'X') g.fillRect(pad + x * px, pad + y * px, px, px)
      }
    }
    return off
  }
  const sprites = ROW_COLORS.map((c) => SPRITE_FRAMES.map((f) => makeSprite(f, c)))

  // Static starfield with per-star depth and twinkle phase; drifts slowly.
  const stars = Array.from({ length: 110 }, () => ({
    x: Math.random() * W,
    y: Math.random() * H,
    z: 0.25 + Math.random() * 0.75,
    ph: Math.random() * Math.PI * 2,
  }))

  function drawStars(now) {
    for (const s of stars) {
      const y = (s.y + now * 0.008 * s.z) % H
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now * 0.002 * s.z + s.ph))
      ctx.globalAlpha = tw * s.z
      ctx.fillStyle = s.z > 0.7 ? '#cfe4ff' : '#5b7699'
      const r = s.z > 0.7 ? 1.6 : 1
      ctx.fillRect(s.x, y, r, r)
    }
    ctx.globalAlpha = 1
  }

  function drawShip(x, y, scale = 1, flame = false) {
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(scale, scale)
    if (flame) {
      const f = 8 + Math.random() * 7
      const grad = ctx.createLinearGradient(0, 10, 0, 10 + f)
      grad.addColorStop(0, 'rgba(255, 200, 80, 0.9)')
      grad.addColorStop(1, 'rgba(255, 80, 40, 0)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.moveTo(-5, 10)
      ctx.lineTo(5, 10)
      ctx.lineTo(0, 10 + f)
      ctx.closePath()
      ctx.fill()
    }
    ctx.shadowColor = '#4dff88'
    ctx.shadowBlur = 14
    ctx.fillStyle = '#4dff88'
    ctx.beginPath()
    ctx.moveTo(0, -16)
    ctx.lineTo(20, 10)
    ctx.lineTo(-20, 10)
    ctx.closePath()
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.fillStyle = '#0a2814'
    ctx.beginPath()
    ctx.moveTo(0, -9)
    ctx.lineTo(9, 7)
    ctx.lineTo(-9, 7)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#d6ffe4'
    ctx.fillRect(-2, -6, 4, 8)
    ctx.restore()
  }

  function tracer(x, y, len, color) {
    const grad = ctx.createLinearGradient(x, y, x, y + len)
    grad.addColorStop(0, color)
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = grad
    ctx.fillRect(x - 1.5, y, 3, len)
  }

  function drawHud() {
    ctx.strokeStyle = 'rgba(140, 170, 255, 0.12)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(16, 38)
    ctx.lineTo(W - 16, 38)
    ctx.stroke()

    ctx.fillStyle = '#8fa3c0'
    ctx.font = `600 13px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText('SCORE', 16, 18)
    ctx.textAlign = 'center'
    ctx.fillText('WAVE', W / 2, 18)
    ctx.textAlign = 'right'
    ctx.fillText('LIVES', W - 16, 18)

    ctx.fillStyle = '#eaf2ff'
    ctx.font = `700 16px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText(String(score).padStart(5, '0'), 16, 33)
    ctx.textAlign = 'center'
    ctx.fillText(String(wave), W / 2, 33)
    for (let i = 0; i < lives; i++) drawShip(W - 24 - i * 26, 28, 0.42)
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
    if (shake > 0.5) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake)
      shake *= 0.88
    }

    drawStars(now)

    const frame = Math.floor(now / 420) % 2
    for (const a of aliens) {
      if (!a.alive) continue
      const img = sprites[a.row % ROW_COLORS.length][frame]
      ctx.drawImage(img, a.x - img.width / (2 * dpr), a.y - img.height / (2 * dpr), img.width / dpr, img.height / dpr)
    }

    drawShip(ship.x, ship.y, 1, playing && !gameOver)

    for (const b of bullets) tracer(b.x, b.y - 4, 14, '#eaffea')

    // Alien bombs: pulsing plasma orbs with a fading trail — nothing like the
    // player's clean tracer rounds.
    for (const b of bombs) {
      const pulse = 1 + 0.25 * Math.sin(now / 60 + b.phase)
      for (let i = 1; i <= 3; i++) {
        ctx.globalAlpha = 0.22 / i
        ctx.fillStyle = '#ff4d6d'
        ctx.beginPath()
        ctx.arc(b.x0 + Math.sin((b.y - i * 10) / 26 + b.phase) * 9, b.y - i * 10, 3.5 * pulse, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      ctx.fillStyle = '#ff4d6d'
      ctx.beginPath()
      ctx.arc(b.x, b.y, 5 * pulse, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#ffd0da'
      ctx.beginPath()
      ctx.arc(b.x, b.y, 2.2 * pulse, 0, Math.PI * 2)
      ctx.fill()
    }

    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max)
      ctx.fillStyle = p.color
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4)
    }
    ctx.globalAlpha = 1

    drawHud()

    if (hitFlash > 0) {
      ctx.fillStyle = `rgba(255, 60, 80, ${hitFlash * 0.35})`
      ctx.fillRect(0, 0, W, H)
      hitFlash -= 0.02
    }

    if (gameOver) {
      overlay('GAME OVER', 'restarting…', '#ff4d6d', true)
    } else if (!playing) {
      overlay('PAUSED', 'claude needs you — answer in the terminal', '#4dff88', false)
    }
    ctx.restore()
  }

  // ── Main loop ─────────────────────────────────────────────────────────
  let last = performance.now()
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (gameOver && now - gameOverAt > 4000) reset()
    if (playing) step(dt)
    render(now)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
})()
