// Swarm — bundled VibeSense game, a Centipede-style fixed shooter. Runs while
// the Claude agent executes; freezes the instant it needs you. Input over SSE
// from the vibesense host: left stick moves the ship freely across the bottom
// zone (both axes), R2 boosts the constant autofire, L2 slows movement for
// precision. Untouched controller hands the ship to an autopilot that slides
// under the lowest descending column and dodges anything that reaches its zone,
// so the demo keeps firing through long agent runs.
// Keyboard fallback (arrows/WASD + space + shift) for development. `?play`
// forces the playing state so the game is testable without a host.

;(() => {
  'use strict'

  // ── Pure grid logic (unit-testable, no I/O) ───────────────────────────
  const W = 800
  const H = 600
  const CELL = 25
  const COLS = W / CELL // 32
  const ROWS = H / CELL // 24
  const TOPROW = 0
  const BOTROW = ROWS - 1
  const ZONE_ROW = 18 // swarm turns hunter once it snakes this deep

  const lerp = (a, b, t) => a + (b - a) * t

  // Where the swarm head lands next. Marches horizontally; on hitting a wall or
  // a spore it drops one row (bouncing back up off the floor/ceiling) and
  // reverses. Pure: obstacles come in through `hasSpore(col,row)`.
  function advanceHead(head, dir, vdir, hasSpore) {
    let col = head.col + dir
    let row = head.row
    let ndir = dir
    let nvdir = vdir
    if (col < 0 || col >= COLS || hasSpore(col, row)) {
      ndir = -dir
      row = head.row + vdir
      if (row < TOPROW || row > BOTROW) {
        nvdir = -vdir
        row = head.row + nvdir
      }
      col = head.col
    }
    return { col, row, dir: ndir, vdir: nvdir }
  }

  // Shooting a mid segment breaks the column in two: everything ahead of the
  // hit keeps its head, everything behind becomes a new column led from the
  // break. The hit cell itself becomes a spore.
  const splitAt = (segs, i) => ({ front: segs.slice(0, i), back: segs.slice(i + 1) })

  if (location.search.includes('selftest')) return selftest()

  // ── Setup ─────────────────────────────────────────────────────────────
  const canvas = document.getElementById('game')
  const ctx = canvas.getContext('2d')
  const statusEl = document.getElementById('status')

  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = W * dpr
  canvas.height = H * dpr
  ctx.scale(dpr, dpr)

  const ACCENT = '#ff5ecb'
  const SPORE = '#54f0d0'
  const ZONE_TOP = ZONE_ROW * CELL + 5 // 455 — ship roams below here
  const SHIP_MIN_Y = ZONE_TOP + 10
  const SHIP_MAX_Y = H - 15
  const SHIP_SPEED = 340
  const SHIP_SLOW = 130 // L2 precision
  const SHIP_R = 11
  const BULLET_SPEED = 660
  const FIRE_MS = 115
  const BOOST_MS = 60 // R2 rapid fire
  const SEG_R = CELL * 0.42
  const SPORE_HP = 4
  const SPIDER_MS = 9000
  const AUTOPILOT_IDLE_MS = 2500

  let playing = false
  let ship = null // {x, y, invulnUntil, deadUntil}
  let swarm = [] // [{ segs:[{col,row,pcol,prow}], dir, vdir }]
  let spores = new Map() // "col,row" → {col, row, hp}
  let bullets = [] // {x, y} — a tracer trails downward from y
  let particles = [] // {x, y, vx, vy, life, max, color}
  let spider = null // {x, y, vx, vy}
  let score = 0
  let lives = 3
  let wave = 0
  let gameOver = false
  let gameOverAt = 0
  let banner = { text: '', t: 0 }
  let lastHumanInput = 0
  let stickX = 0
  let stickY = 0
  let keyX = 0
  let keyY = 0
  let slow = false
  let stepAcc = 0
  let stepMs = 140
  let fireTimer = 0
  let boost = false
  let spiderTimer = SPIDER_MS

  const sporeKey = (col, row) => col + ',' + row
  const hasSpore = (col, row) => spores.has(sporeKey(col, row))
  const cellCenter = (col, row) => ({ x: (col + 0.5) * CELL, y: (row + 0.5) * CELL })

  function addSpore(col, row) {
    if (col < 0 || col >= COLS || row < 1 || row > BOTROW) return
    const k = sporeKey(col, row)
    if (!spores.has(k)) spores.set(k, { col, row, hp: SPORE_HP })
  }

  function scatterSpores(n) {
    for (let i = 0; i < n; i++) {
      addSpore(Math.floor(Math.random() * COLS), 3 + Math.floor(Math.random() * (ZONE_ROW - 3)))
    }
  }

  function spawnSwarm() {
    wave++
    banner = { text: 'WAVE ' + wave, t: 1.5 }
    stepMs = Math.max(70, 150 - wave * 12)
    const len = 9 + wave * 2
    const dir = Math.random() < 0.5 ? 1 : -1
    const startCol = dir === 1 ? 0 : COLS - 1
    const segs = []
    for (let i = 0; i < len; i++) {
      const col = startCol - dir * i
      segs.push({ col, row: 2, pcol: col, prow: 2 })
    }
    swarm = [{ segs, dir, vdir: 1 }]
  }

  function spawnShip() {
    ship = { x: W / 2, y: SHIP_MAX_Y - 10, invulnUntil: performance.now() + 2500, deadUntil: 0 }
  }

  function reset() {
    score = 0
    lives = 3
    wave = 0
    gameOver = false
    spores = new Map()
    bullets = []
    particles = []
    spider = null
    spiderTimer = SPIDER_MS
    stepAcc = 0
    scatterSpores(42)
    spawnShip()
    spawnSwarm()
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
        if (msg.axis === 'left_x') {
          stickX = Math.abs(msg.value) > 0.18 ? msg.value : 0
          if (stickX !== 0) lastHumanInput = performance.now()
        } else if (msg.axis === 'left_y') {
          stickY = Math.abs(msg.value) > 0.18 ? msg.value : 0
          if (stickY !== 0) lastHumanInput = performance.now()
        }
      } else if (msg.kind === 'button') {
        if (msg.button === 'r2') {
          boost = msg.pressed
          if (msg.pressed) {
            lastHumanInput = performance.now()
            if (gameOver) reset()
          }
        } else if (msg.button === 'l2') {
          slow = msg.pressed
          if (msg.pressed && gameOver) reset()
        }
      }
    } else if (msg.type === 'reload') {
      location.href = msg.url // controller swapped games — load the new one
    }
  }
  events.onerror = () => setStatus('host disconnected — is vibesense running?', false)

  // Keyboard fallback for development.
  const keyAxis = (e, down) => {
    const k = e.key
    if (k === 'ArrowLeft' || k === 'a') keyX = down ? -1 : keyX < 0 ? 0 : keyX
    else if (k === 'ArrowRight' || k === 'd') keyX = down ? 1 : keyX > 0 ? 0 : keyX
    else if (k === 'ArrowUp' || k === 'w') keyY = down ? -1 : keyY < 0 ? 0 : keyY
    else if (k === 'ArrowDown' || k === 's') keyY = down ? 1 : keyY > 0 ? 0 : keyY
    else return
    lastHumanInput = performance.now()
  }
  addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      boost = true
      if (gameOver) reset()
    } else if (e.key === 'Shift') slow = true
    else keyAxis(e, true)
  })
  addEventListener('keyup', (e) => {
    if (e.key === ' ') boost = false
    else if (e.key === 'Shift') slow = false
    else keyAxis(e, false)
  })

  function setPlaying(next) {
    playing = next
    setStatus(
      playing ? 'agent executing — hold the swarm back!' : 'claude needs you — controller is on the terminal',
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
      const v = 50 + Math.random() * 170
      const max = 0.3 + Math.random() * 0.4
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: max, max, color })
    }
  }

  // ── Simulation ────────────────────────────────────────────────────────
  function fire() {
    bullets.push({ x: ship.x, y: ship.y - SHIP_R })
  }

  function stepSwarm() {
    for (const c of swarm) {
      for (const s of c.segs) {
        s.pcol = s.col
        s.prow = s.row
      }
      const nh = advanceHead(c.segs[0], c.dir, c.vdir, hasSpore)
      c.dir = nh.dir
      c.vdir = nh.vdir
      for (let i = c.segs.length - 1; i >= 1; i--) {
        c.segs[i].col = c.segs[i - 1].pcol
        c.segs[i].row = c.segs[i - 1].prow
      }
      c.segs[0].col = nh.col
      c.segs[0].row = nh.row
      // Deep enough to hunt: steer the head toward the ship's column.
      if (nh.row >= ZONE_ROW && ship) {
        const shipCol = Math.floor(ship.x / CELL)
        if (shipCol !== nh.col) c.dir = shipCol > nh.col ? 1 : -1
      }
    }
  }

  function hitSegment(ci, si, now) {
    const c = swarm[ci]
    const seg = c.segs[si]
    const p = cellCenter(seg.col, seg.row)
    // Closer to the bottom (deeper row) is worth more, Centipede-style.
    score += 10 + seg.row * 2
    burst(p.x, p.y, ACCENT, 14)
    addSpore(seg.col, seg.row)
    const { front, back } = splitAt(c.segs, si)
    const parts = []
    if (front.length) parts.push({ segs: front, dir: c.dir, vdir: c.vdir })
    if (back.length) {
      for (const s of back) {
        s.pcol = s.col
        s.prow = s.row
      }
      parts.push({ segs: back, dir: -c.dir, vdir: c.vdir })
    }
    swarm.splice(ci, 1, ...parts)
    if (!swarm.length) {
      banner = { text: 'WAVE CLEARED', t: 1.4 }
      score += 100
      setTimeout(() => {
        if (playing && !gameOver && !swarm.length) spawnSwarm()
      }, 1100)
    }
  }

  function spawnSpider() {
    const fromLeft = Math.random() < 0.5
    spider = {
      x: fromLeft ? -20 : W + 20,
      y: ZONE_TOP + 20 + Math.random() * (H - ZONE_TOP - 60),
      vx: (fromLeft ? 1 : -1) * (130 + Math.random() * 60),
      vy: (Math.random() < 0.5 ? 1 : -1) * 150,
    }
  }

  function loseShip(now) {
    burst(ship.x, ship.y, '#ff9d6d', 26)
    lives--
    if (lives <= 0) {
      gameOver = true
      gameOverAt = now
      ship = null
      return
    }
    ship.x = W / 2
    ship.y = SHIP_MAX_Y - 10
    ship.invulnUntil = now + 2200
  }

  function moveShip(dt) {
    const idle = performance.now() - lastHumanInput > AUTOPILOT_IDLE_MS
    let ax = 0
    let ay = 0
    if (idle) {
      const cmd = autopilot()
      ax = cmd.x
      ay = cmd.y
    } else {
      ax = stickX !== 0 ? stickX : keyX
      ay = stickY !== 0 ? stickY : keyY
    }
    const sp = slow ? SHIP_SLOW : SHIP_SPEED
    ship.x = Math.max(SHIP_R, Math.min(W - SHIP_R, ship.x + ax * sp * dt))
    ship.y = Math.max(SHIP_MIN_Y, Math.min(SHIP_MAX_Y, ship.y + ay * sp * dt))
  }

  // Autopilot: slide under the lowest descending segment and shoot it, but
  // peel away from anything that gets close inside the zone.
  function autopilot() {
    let threat = null // deepest segment (closest to the floor)
    let danger = null // nearest thing to the ship
    let dBest = Infinity
    const consider = (x, y) => {
      const d = Math.hypot(x - ship.x, y - ship.y)
      if (d < dBest) {
        dBest = d
        danger = { x, y }
      }
    }
    for (const c of swarm) {
      for (const s of c.segs) {
        const p = cellCenter(s.col, s.row)
        if (!threat || s.row > threat.row) threat = { row: s.row, x: p.x }
        consider(p.x, p.y)
      }
    }
    if (spider) consider(spider.x, spider.y)
    if (danger && dBest < 80) {
      // Dodge: move opposite on x, and hug the floor.
      return { x: ship.x < danger.x ? -1 : 1, y: 0.6 }
    }
    const tx = threat ? threat.x : W / 2
    const dx = tx - ship.x
    return { x: Math.abs(dx) < 6 ? 0 : Math.sign(dx), y: 0.5 }
  }

  function tick(dt, now) {
    banner.t = Math.max(0, banner.t - dt)
    fireTimer -= dt * 1000
    spiderTimer -= dt * 1000

    // Swarm marches on its own grid clock; ship + bullets run every frame.
    stepAcc += dt * 1000
    while (stepAcc >= stepMs) {
      stepAcc -= stepMs
      stepSwarm()
    }

    if (ship) {
      moveShip(dt)
      if (fireTimer <= 0) {
        fire()
        fireTimer = boost ? BOOST_MS : FIRE_MS
      }
    }

    // Bullets fly straight up, leaving a short tracer.
    for (const b of bullets) {
      b.y -= BULLET_SPEED * dt
    }
    bullets = bullets.filter((b) => b.y > -8)

    // Bullet ↔ spore / segment / spider.
    outer: for (let bi = bullets.length - 1; bi >= 0; bi--) {
      const b = bullets[bi]
      const col = Math.floor(b.x / CELL)
      const row = Math.floor(b.y / CELL)
      const sp = spores.get(sporeKey(col, row))
      if (sp) {
        sp.hp--
        burst(b.x, b.y, SPORE, 5)
        if (sp.hp <= 0) {
          spores.delete(sporeKey(col, row))
          score += 5
        }
        bullets.splice(bi, 1)
        continue
      }
      for (let ci = 0; ci < swarm.length; ci++) {
        const segs = swarm[ci].segs
        for (let si = 0; si < segs.length; si++) {
          const f = stepAcc / stepMs
          const cx = lerp(segs[si].pcol + 0.5, segs[si].col + 0.5, f) * CELL
          const cy = lerp(segs[si].prow + 0.5, segs[si].row + 0.5, f) * CELL
          if ((b.x - cx) ** 2 + (b.y - cy) ** 2 < SEG_R * SEG_R) {
            bullets.splice(bi, 1)
            hitSegment(ci, si, now)
            continue outer
          }
        }
      }
      if (spider && (b.x - spider.x) ** 2 + (b.y - spider.y) ** 2 < 16 ** 2) {
        score += 300
        burst(spider.x, spider.y, '#ffd76e', 22)
        spider = null
        spiderTimer = SPIDER_MS
        bullets.splice(bi, 1)
      }
    }

    // Spider zigzags through the zone, eating spores, then exits.
    if (!spider && spiderTimer <= 0) spawnSpider()
    if (spider) {
      spider.x += spider.vx * dt
      spider.y += spider.vy * dt
      if (spider.y < ZONE_TOP + 12 || spider.y > H - 14) spider.vy = -spider.vy
      if (Math.random() < 0.02) spider.vy = -spider.vy // jittery zigzag
      spores.delete(sporeKey(Math.floor(spider.x / CELL), Math.floor(spider.y / CELL)))
      if (spider.x < -30 || spider.x > W + 30) {
        spider = null
        spiderTimer = SPIDER_MS
      }
    }

    // Ship ↔ swarm / spider.
    if (ship && now > ship.invulnUntil) {
      const f = stepAcc / stepMs
      let hit = false
      for (const c of swarm) {
        for (const s of c.segs) {
          const cx = lerp(s.pcol + 0.5, s.col + 0.5, f) * CELL
          const cy = lerp(s.prow + 0.5, s.row + 0.5, f) * CELL
          if ((ship.x - cx) ** 2 + (ship.y - cy) ** 2 < (SHIP_R + SEG_R) ** 2) hit = true
        }
      }
      if (spider && (ship.x - spider.x) ** 2 + (ship.y - spider.y) ** 2 < (SHIP_R + 12) ** 2) hit = true
      if (hit) loseShip(now)
    }

    for (const p of particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.life -= dt
    }
    particles = particles.filter((p) => p.life > 0)
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

  function drawField(now) {
    // Player zone glows faintly at the base of the field.
    const g = ctx.createLinearGradient(0, ZONE_TOP, 0, H)
    g.addColorStop(0, 'rgba(255, 94, 203, 0)')
    g.addColorStop(1, 'rgba(255, 94, 203, 0.06)')
    ctx.fillStyle = g
    ctx.fillRect(0, ZONE_TOP, W, H - ZONE_TOP)
    ctx.strokeStyle = 'rgba(255, 94, 203, 0.18)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, ZONE_TOP)
    ctx.lineTo(W, ZONE_TOP)
    ctx.stroke()
  }

  function drawSpores(now) {
    ctx.save()
    for (const s of spores.values()) {
      const p = cellCenter(s.col, s.row)
      const t = s.hp / SPORE_HP // 1 healthy → 0 nearly gone
      const r = SEG_R * (0.55 + 0.35 * t)
      const pulse = 0.5 + 0.5 * Math.sin(now / 500 + s.col)
      ctx.shadowColor = SPORE
      ctx.shadowBlur = 6 + t * 10 + pulse * 3
      const grad = ctx.createRadialGradient(p.x, p.y - 1, 1, p.x, p.y, r)
      grad.addColorStop(0, t > 0.5 ? '#bafff0' : '#7fead8')
      grad.addColorStop(0.5, SPORE)
      grad.addColorStop(1, `rgba(84, 240, 208, ${0.35 + 0.4 * t})`)
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fill()
      // A cracked, dimmer core as it takes damage.
      if (t < 0.75) {
        ctx.shadowBlur = 0
        ctx.fillStyle = `rgba(10, 30, 28, ${0.5 * (1 - t)})`
        ctx.beginPath()
        ctx.arc(p.x, p.y, r * 0.4, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.restore()
  }

  function drawSwarm(now) {
    const f = stepAcc / stepMs
    ctx.save()
    ctx.shadowColor = ACCENT
    for (const c of swarm) {
      for (let i = c.segs.length - 1; i >= 0; i--) {
        const s = c.segs[i]
        const x = lerp(s.pcol + 0.5, s.col + 0.5, f) * CELL
        const y = lerp(s.prow + 0.5, s.row + 0.5, f) * CELL
        const head = i === 0
        ctx.shadowBlur = head ? 20 : 12
        const grad = ctx.createRadialGradient(x - 2, y - 3, 1, x, y, SEG_R)
        grad.addColorStop(0, '#ffd6f2')
        grad.addColorStop(0.45, head ? '#ff8fdb' : ACCENT)
        grad.addColorStop(1, '#b81f86')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(x, y, SEG_R, 0, Math.PI * 2)
        ctx.fill()
        if (head) {
          // Eyes facing the direction of travel.
          ctx.shadowBlur = 0
          ctx.fillStyle = '#2a0620'
          for (const sgn of [1, -1]) {
            ctx.beginPath()
            ctx.arc(x + c.dir * 3.5, y - 2 + sgn * 3.5, 1.8, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }
    }
    ctx.restore()
  }

  function drawSpider(now) {
    if (!spider) return
    ctx.save()
    ctx.shadowColor = '#ffd76e'
    ctx.shadowBlur = 16
    ctx.strokeStyle = '#ffe6a3'
    ctx.lineWidth = 1.6
    const r = 9
    // Skittering legs.
    for (let i = 0; i < 4; i++) {
      const a = 0.5 + i * 0.6 + Math.sin(now / 90 + i) * 0.25
      for (const sgn of [1, -1]) {
        ctx.beginPath()
        ctx.moveTo(spider.x, spider.y)
        ctx.lineTo(spider.x + sgn * Math.cos(a) * (r + 8), spider.y + Math.sin(a) * (r + 5))
        ctx.stroke()
      }
    }
    ctx.fillStyle = '#ffcf5a'
    ctx.beginPath()
    ctx.arc(spider.x, spider.y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  function drawShip(now) {
    if (!ship) return
    if (now < ship.invulnUntil && Math.floor(now / 125) % 2 === 0) return // respawn blink
    ctx.save()
    ctx.shadowColor = ACCENT
    ctx.shadowBlur = 14
    ctx.strokeStyle = '#ffe0f4'
    ctx.lineWidth = 1.8
    ctx.fillStyle = 'rgba(255, 94, 203, 0.12)'
    ctx.beginPath()
    ctx.moveTo(ship.x, ship.y - SHIP_R - 2)
    ctx.lineTo(ship.x - SHIP_R, ship.y + SHIP_R)
    ctx.lineTo(ship.x, ship.y + SHIP_R * 0.4)
    ctx.lineTo(ship.x + SHIP_R, ship.y + SHIP_R)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  function drawBullets() {
    ctx.save()
    ctx.shadowColor = '#ffffff'
    ctx.shadowBlur = 8
    ctx.strokeStyle = '#fff2fb'
    ctx.lineWidth = 2.4
    for (const b of bullets) {
      ctx.beginPath()
      ctx.moveTo(b.x, b.y)
      ctx.lineTo(b.x, b.y + 18)
      ctx.stroke()
    }
    ctx.restore()
  }

  function drawHud() {
    ctx.fillStyle = '#a88fc0'
    ctx.font = `600 13px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText('SCORE', 16, 18)
    ctx.textAlign = 'center'
    ctx.fillText('WAVE ' + wave, W / 2, 18)
    ctx.textAlign = 'right'
    ctx.fillText('LIVES', W - 16, 18)
    ctx.fillStyle = '#eaf2ff'
    ctx.font = `700 16px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText(String(score).padStart(6, '0'), 16, 33)
    ctx.fillStyle = ACCENT
    ctx.textAlign = 'right'
    ctx.fillText('◆ '.repeat(Math.max(0, lives)).trim(), W - 16, 34)
  }

  function overlay(title, sub, color, showScore) {
    ctx.fillStyle = 'rgba(6, 3, 14, 0.78)'
    ctx.fillRect(0, 0, W, H)
    const cw = 460
    const ch = showScore ? 190 : 160
    const cx = (W - cw) / 2
    const cy = (H - ch) / 2
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 30
    ctx.fillStyle = 'rgba(18, 9, 28, 0.95)'
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
    ctx.fillStyle = '#a88fc0'
    ctx.font = `500 14px ${FONT}`
    ctx.fillText(sub, W / 2, cy + ch - 38)
  }

  function render(now) {
    ctx.clearRect(0, 0, W, H)
    drawField(now)
    drawSpores(now)
    drawSwarm(now)
    drawSpider(now)
    drawBullets()
    drawShip(now)

    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max)
      ctx.fillStyle = p.color
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4)
    }
    ctx.globalAlpha = 1
    drawHud()

    if (banner.t > 0) {
      ctx.globalAlpha = Math.min(1, banner.t / 0.4)
      ctx.fillStyle = '#ffd6f2'
      ctx.font = `700 40px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText(banner.text, W / 2, H / 2 - 70)
      ctx.globalAlpha = 1
    }

    if (gameOver) {
      overlay('GAME OVER', 'R2 / SPACE to play again — restarting…', '#ff4d6d', true)
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
    if (playing && !gameOver) tick(dt, now)
    else if (playing) {
      for (const p of particles) {
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.life -= dt
      }
      particles = particles.filter((p) => p.life > 0)
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
    const none = () => false

    // Marches horizontally over open ground.
    let r = advanceHead({ col: 5, row: 3 }, 1, 1, none)
    ok(r.col === 6 && r.row === 3 && r.dir === 1, 'head marches sideways')

    // Wall on the right → drop a row and reverse.
    r = advanceHead({ col: COLS - 1, row: 3 }, 1, 1, none)
    ok(r.col === COLS - 1 && r.row === 4 && r.dir === -1, 'wall drops and reverses')

    // A spore ahead is an obstacle too.
    r = advanceHead({ col: 5, row: 3 }, 1, 1, (c, ro) => c === 6 && ro === 3)
    ok(r.row === 4 && r.dir === -1, 'spore drops and reverses')

    // Bounces back up off the floor.
    r = advanceHead({ col: COLS - 1, row: BOTROW }, 1, 1, none)
    ok(r.row === BOTROW - 1 && r.vdir === -1, 'bounces up off the floor')

    // Splitting a mid segment yields a front and a back.
    const segs = [0, 1, 2, 3, 4].map((n) => ({ col: n }))
    const { front, back } = splitAt(segs, 2)
    ok(front.length === 2 && back.length === 2, 'split drops the hit segment, keeps both ends')
    ok(front[0].col === 0 && back[0].col === 3, 'split parts are contiguous around the hit')

    console.log('[swarm] selftest passed')
    document.getElementById('status').textContent = 'selftest passed ✓'
  }
})()
