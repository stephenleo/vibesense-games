// Tunneler — bundled VibeSense game. Runs while the Claude agent executes;
// freezes when it needs you. Input over SSE from the vibesense host: left
// stick digs/moves through the earth in 4 directions, R2 fires a short-range
// pump-harpoon down the tunnel (hold/repeat to inflate-and-pop a grabbed
// creature), L2 sprints. Crawlers stalk you through the tunnels; phantoms
// drift through solid earth when aggravated; boulders fall when you dig out
// their footing and crush anything in the shaft — including you. Untouched
// controller hands the digger to an autopilot that chases creatures, lines up
// harpoons and drops boulders, so the demo stays lively through long runs.
// Keyboard fallback (arrows/WASD + space + shift) for development. `?play`
// forces the playing state so the game is testable without a host.

;(() => {
  'use strict'

  // ── Pure logic (unit-testable, no I/O) ────────────────────────────────
  const W = 800
  const H = 600
  const CELL = 40
  const COLS = 20 // 800 / 40
  const ROWS = 15 // 600 / 40 — row 0 is the surface/sky, 1..14 is earth

  const UP = { x: 0, y: -1 }
  const DOWN = { x: 0, y: 1 }
  const LEFT = { x: -1, y: 0 }
  const RIGHT = { x: 1, y: 0 }
  const DIRS = [UP, DOWN, LEFT, RIGHT]

  const cc = (i) => i * CELL + CELL / 2 // cell index → pixel centre
  const eqDir = (a, b) => a && b && a.x === b.x && a.y === b.y
  const manhattan = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by)

  // Deterministic 0..1 hash — steady earth texture that doesn't flicker.
  const hash = (a, b) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
    return s - Math.floor(s)
  }

  // Directions ranked by how much they close on the target, dominant axis
  // first, then the rest as fallbacks. Used by the AI and the creatures.
  function towardDirs(fx, fy, tx, ty) {
    const h = tx > fx ? RIGHT : tx < fx ? LEFT : null
    const v = ty > fy ? DOWN : ty < fy ? UP : null
    const primary = Math.abs(tx - fx) >= Math.abs(ty - fy) ? [h, v] : [v, h]
    const order = primary.filter(Boolean)
    for (const d of DIRS) if (!order.includes(d)) order.push(d)
    return order
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

  const ACCENT = '#ff8a3d'
  const BASE_SPEED = 118
  const SPRINT_SPEED = 188
  const HARP_REACH = 4 // cells the pump-harpoon can span
  const PUMP_TIME = 0.32 // seconds of held R2 per inflation stage
  const POP_STAGE = 4 // stages to burst a creature
  const GRAVITY = 900
  const MAX_FALL = 540
  const AUTOPILOT_IDLE_MS = 2500
  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

  let now = 0
  let playing = false
  let dug = [] // [x][y] boolean — true = carved tunnel / open
  let rocks = [] // {gx, gy, x, y, state, vy, t}
  let creatures = [] // see spawnCreature
  let particles = [] // {x, y, vx, vy, life, max, color, size, grav}
  let player = null
  let harpoon = null // {dir, reach, target, pumpAcc, t}
  let spawn = { cx: 3, cy: 3 }
  let inputDir = null // last human-requested direction
  let aiDir = null
  let firing = false
  let sprinting = false
  let score = 0
  let lives = 3
  let level = 1
  let gameOver = false
  let gameOverAt = 0
  let banner = { text: '', t: 0 }
  let nextLevelAt = 0
  let lastHumanInput = -1e9 // start on autopilot so `?play` is lively at once

  const rockAt = (cx, cy) => rocks.some((r) => r.state !== 'gone' && r.gx === cx && r.gy === cy)

  // Can `mode` occupy this cell? dig carves earth, tunnel needs open cells,
  // ghost phases through solid — none may enter a boulder or leave the grid.
  function passable(cx, cy, mode) {
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return false
    if (rockAt(cx, cy)) return false
    if (mode === 'tunnel') return dug[cx][cy]
    return true // dig + ghost can enter any in-bounds non-rock cell
  }

  function carve(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS || dug[cx][cy]) return
    dug[cx][cy] = true
    // Crumbling earth flung out of the fresh cut.
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2
      const v = 30 + Math.random() * 70
      particles.push({
        x: cc(cx),
        y: cc(cy),
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 30,
        life: 0.4 + Math.random() * 0.3,
        max: 0.7,
        color: strata(cy),
        size: 2 + Math.random() * 2,
        grav: 420,
      })
    }
  }

  // Grid-locked stepper: entities travel cell-to-cell, only turning when they
  // reach a cell centre. `mode` decides what they may enter; dig carves.
  function advance(e, want, dt, mode) {
    let budget = e.speed * dt
    while (budget > 0) {
      if (!e.target) {
        let d =
          want && passable(e.cx + want.x, e.cy + want.y, mode)
            ? want
            : e.dir && passable(e.cx + e.dir.x, e.cy + e.dir.y, mode)
              ? e.dir
              : null
        if (!d) {
          e.dir = null
          break
        }
        e.dir = d
        const ncx = e.cx + d.x
        const ncy = e.cy + d.y
        if (mode === 'dig') carve(ncx, ncy)
        e.target = { cx: ncx, cy: ncy, x: cc(ncx), y: cc(ncy) }
      }
      const dx = e.target.x - e.x
      const dy = e.target.y - e.y
      const dist = Math.hypot(dx, dy)
      if (dist <= budget) {
        e.x = e.target.x
        e.y = e.target.y
        e.cx = e.target.cx
        e.cy = e.target.cy
        e.target = null
        budget -= dist
      } else {
        e.x += (dx / dist) * budget
        e.y += (dy / dist) * budget
        budget = 0
      }
    }
  }

  // ── Level construction ────────────────────────────────────────────────
  function makeEntity(cx, cy, extra) {
    return Object.assign({ cx, cy, x: cc(cx), y: cc(cy), dir: null, target: null }, extra)
  }

  function spawnCreature(type, cx, cy) {
    creatures.push(
      makeEntity(cx, cy, {
        type,
        speed: 0,
        stage: 0,
        deflating: false,
        dead: false,
        ghost: type === 'phantom' && !dug[cx][cy],
        ghostT: 1.5 + Math.random() * 2,
        alpha: 1,
        wob: Math.random() * Math.PI * 2,
      }),
    )
  }

  function buildLevel() {
    dug = Array.from({ length: COLS }, () => Array(ROWS).fill(false))
    rocks = []
    creatures = []
    particles = []
    harpoon = null
    const open = (x, y) => {
      if (x >= 0 && y >= 0 && x < COLS && y < ROWS) dug[x][y] = true
    }
    const gallery = (y, x0, x1) => {
      for (let x = x0; x <= x1; x++) open(x, y)
    }
    const shaft = (x, y0, y1) => {
      for (let y = y0; y <= y1; y++) open(x, y)
    }

    for (let x = 0; x < COLS; x++) open(x, 0) // sky
    shaft(3, 0, 12)
    shaft(16, 3, 12)
    gallery(3, 3, 16)
    gallery(6, 3, 12)
    gallery(9, 7, 16)
    gallery(12, 3, 16)

    spawn = { cx: 3, cy: 3 }
    player = makeEntity(spawn.cx, spawn.cy, {
      face: RIGHT,
      alive: true,
      invuln: 1.2,
      speed: BASE_SPEED,
    })
    inputDir = null
    aiDir = null
    firing = false

    spawnCreature('crawler', 12, 3)
    spawnCreature('crawler', 8, 6)
    spawnCreature('crawler', 14, 9)
    spawnCreature('phantom', 10, 4) // buried → starts ghosting toward you
    if (level >= 2) spawnCreature('crawler', 7, 12)
    if (level >= 2) spawnCreature('phantom', 5, 10)
    for (let i = 3; i <= level; i++) {
      // Extra crawlers on deeper levels, dropped into existing tunnel cells.
      let cx, cy, tries = 0
      do {
        cx = Math.floor(Math.random() * COLS)
        cy = 3 + Math.floor(Math.random() * (ROWS - 4))
      } while ((!dug[cx][cy] || manhattan(cx, cy, spawn.cx, spawn.cy) < 6) && tries++ < 60)
      spawnCreature('crawler', cx, cy)
    }

    // Boulders resting on solid footing — dig it out and they fall.
    for (const [gx, gy] of [
      [9, 4],
      [12, 7],
      [5, 8],
      [14, 5],
    ]) {
      rocks.push({ gx, gy, x: cc(gx), y: cc(gy), state: 'rest', vy: 0, t: 0 })
    }
  }

  function reset() {
    score = 0
    lives = 3
    level = 1
    gameOver = false
    nextLevelAt = 0
    buildLevel()
    banner = { text: 'LEVEL 1', t: 1.6 }
  }
  reset()

  // ── Input: SSE from the vibesense host ────────────────────────────────
  function fireHarpoon() {
    if (harpoon || !player.alive) return
    const d = player.face
    harpoon = { dir: d, reach: 0, target: null, pumpAcc: 0, t: 0.5 }
    for (let i = 1; i <= HARP_REACH; i++) {
      const cx = player.cx + d.x * i
      const cy = player.cy + d.y * i
      if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS || rockAt(cx, cy)) break
      harpoon.reach = i
      const hit = creatures.find((c) => !c.dead && c.stage === 0 && c.cx === cx && c.cy === cy)
      if (hit) {
        harpoon.target = hit
        hit.stage = 1
        hit.deflating = false
        break
      }
      if (!dug[cx][cy]) break // the harpoon only runs down open tunnel
    }
  }

  function pressFire(pressed) {
    firing = pressed
    if (pressed) {
      lastHumanInput = now
      if (gameOver) return reset()
      fireHarpoon()
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
        // Left stick → dominant-axis direction, past a deadzone.
        if (msg.axis === 'left_x' && Math.abs(msg.value) > 0.4) {
          inputDir = msg.value > 0 ? RIGHT : LEFT
          lastHumanInput = now
        } else if (msg.axis === 'left_y' && Math.abs(msg.value) > 0.4) {
          inputDir = msg.value > 0 ? DOWN : UP
          lastHumanInput = now
        } else if (Math.abs(msg.value) <= 0.4) {
          // Stick released to centre on this axis — stop steering.
          if (
            (msg.axis === 'left_x' && (inputDir === LEFT || inputDir === RIGHT)) ||
            (msg.axis === 'left_y' && (inputDir === UP || inputDir === DOWN))
          )
            inputDir = null
        }
      } else if (msg.kind === 'button') {
        if (msg.button === 'r2') pressFire(msg.pressed)
        else if (msg.button === 'l2') {
          sprinting = msg.pressed
          if (msg.pressed) lastHumanInput = now
        }
      }
    } else if (msg.type === 'reload') {
      location.href = msg.url // controller swapped games — load the new one
    }
  }
  events.onerror = () => setStatus('host disconnected — is vibesense running?', false)

  // Keyboard fallback for development.
  const KEYDIR = {
    ArrowUp: UP,
    ArrowDown: DOWN,
    ArrowLeft: LEFT,
    ArrowRight: RIGHT,
    w: UP,
    s: DOWN,
    a: LEFT,
    d: RIGHT,
  }
  addEventListener('keydown', (e) => {
    const d = KEYDIR[e.key]
    if (d) {
      inputDir = d
      lastHumanInput = now
    } else if (e.key === ' ') {
      pressFire(true)
    } else if (e.key === 'Shift') {
      sprinting = true
      lastHumanInput = now
    }
  })
  addEventListener('keyup', (e) => {
    if (KEYDIR[e.key] === inputDir) inputDir = null
    if (e.key === ' ') pressFire(false)
    if (e.key === 'Shift') sprinting = false
  })

  function setPlaying(next) {
    playing = next
    setStatus(
      playing ? 'agent executing — dig, pump, survive!' : 'claude needs you — controller is on the terminal',
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
  function burst(x, y, color, n, spread = 190) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const v = 40 + Math.random() * spread
      const max = 0.35 + Math.random() * 0.4
      particles.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: max,
        max,
        color,
        size: 2 + Math.random() * 2.5,
        grav: 120,
      })
    }
  }

  // ── Creatures ─────────────────────────────────────────────────────────
  function creatureTunnelDir(c) {
    const order = towardDirs(c.cx, c.cy, player.cx, player.cy)
    const back = c.dir ? { x: -c.dir.x, y: -c.dir.y } : null
    for (const d of order) {
      if (eqDir(d, back)) continue
      if (passable(c.cx + d.x, c.cy + d.y, 'tunnel')) return d
    }
    for (const d of order) if (passable(c.cx + d.x, c.cy + d.y, 'tunnel')) return d
    return null
  }

  function updateCreature(c, dt) {
    c.wob += dt * 6
    if (c.stage > 0) return // grabbed / inflating — frozen in place

    if (c.type === 'crawler') {
      c.speed = 60 + level * 7
      advance(c, creatureTunnelDir(c), dt, 'tunnel')
      c.alpha = 1
      return
    }

    // Phantom: prowls the tunnels, but phases through solid earth when it
    // can't make progress or its ghost timer fires.
    c.ghostT -= dt
    const distNow = manhattan(c.cx, c.cy, player.cx, player.cy)
    if (c.ghost) {
      c.speed = 34 + level * 4
      const order = towardDirs(c.cx, c.cy, player.cx, player.cy)
      const want = order.find((d) => passable(c.cx + d.x, c.cy + d.y, 'ghost')) || null
      advance(c, want, dt, 'ghost')
      c.alpha += (0.45 - c.alpha) * Math.min(1, dt * 6)
      if (c.ghostT <= 0 && dug[c.cx][c.cy]) {
        c.ghost = false
        c.ghostT = 2 + Math.random() * 2.5
      }
    } else {
      c.speed = 48 + level * 6
      const td = creatureTunnelDir(c)
      const reduces = td && manhattan(c.cx + td.x, c.cy + td.y, player.cx, player.cy) < distNow
      if (!reduces || c.ghostT <= 0) {
        c.ghost = true
        c.ghostT = 1.2 + Math.random() * 1.3
      } else {
        advance(c, td, dt, 'tunnel')
      }
      c.alpha += (1 - c.alpha) * Math.min(1, dt * 6)
    }
  }

  function popCreature(c) {
    c.dead = true
    score += 120 + c.cy * 15 + level * 20
    burst(c.x, c.y, c.type === 'phantom' ? '#c9a3ff' : '#ff6d7a', 24, 220)
  }

  // ── Boulders ──────────────────────────────────────────────────────────
  function crushAt(cx, cy) {
    if (player.alive && player.invuln <= 0 && player.cx === cx && player.cy === cy) killPlayer()
    for (const c of creatures) {
      if (!c.dead && c.cx === cx && c.cy === cy) {
        c.dead = true
        score += 200
        burst(c.x, c.y, '#d8b48c', 22, 200)
      }
    }
  }

  function updateRocks(dt) {
    for (const r of rocks) {
      if (r.state === 'rest') {
        const by = r.gy + 1
        if (by < ROWS && dug[r.gx][by] && !rocks.some((o) => o !== r && o.gx === r.gx && o.gy === by)) {
          r.state = 'teeter'
          r.t = 0.5
        }
      } else if (r.state === 'teeter') {
        r.t -= dt
        if (r.t <= 0) {
          r.state = 'fall'
          r.vy = 0
        }
      } else if (r.state === 'fall') {
        r.vy = Math.min(MAX_FALL, r.vy + GRAVITY * dt)
        r.y += r.vy * dt
        r.gy = Math.round((r.y - CELL / 2) / CELL)
        crushAt(r.gx, r.gy)
        const by = r.gy + 1
        const blocked = by >= ROWS || !dug[r.gx][by] || rocks.some((o) => o !== r && o.gx === r.gx && o.gy === by)
        if (blocked && r.y >= cc(r.gy) - 1) {
          r.y = cc(r.gy)
          r.state = 'shatter'
          r.t = 0.35
          for (let i = 0; i < 16; i++) {
            const a = Math.random() * Math.PI - Math.PI // upward-ish fan
            const v = 60 + Math.random() * 120
            particles.push({
              x: r.x + (Math.random() - 0.5) * CELL,
              y: cc(r.gy) + CELL / 2,
              vx: Math.cos(a) * v,
              vy: Math.sin(a) * v * 0.5 - 40,
              life: 0.4 + Math.random() * 0.3,
              max: 0.7,
              color: '#cbb08a',
              size: 2 + Math.random() * 2,
              grav: 500,
            })
          }
        }
      } else if (r.state === 'shatter') {
        r.t -= dt
        if (r.t <= 0) r.state = 'gone'
      }
    }
    rocks = rocks.filter((r) => r.state !== 'gone')
  }

  // ── Player ────────────────────────────────────────────────────────────
  function killPlayer() {
    if (!player.alive || player.invuln > 0) return
    burst(player.x, player.y, '#ffb37a', 26, 220)
    lives--
    harpoon = null
    firing = false
    if (lives <= 0) {
      gameOver = true
      gameOverAt = now
      player.alive = false
      return
    }
    Object.assign(player, {
      cx: spawn.cx,
      cy: spawn.cy,
      x: cc(spawn.cx),
      y: cc(spawn.cy),
      dir: null,
      target: null,
      invuln: 2,
    })
  }

  // ── Autopilot ─────────────────────────────────────────────────────────
  // With no human at the stick: chase the nearest creature, line up harpoons,
  // and occasionally dig a boulder's footing out over a creature below.
  function clearLine(dir, span) {
    for (let i = 1; i <= span; i++) {
      const cx = player.cx + dir.x * i
      const cy = player.cy + dir.y * i
      if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS || rockAt(cx, cy) || !dug[cx][cy]) return false
    }
    return true
  }

  function boulderPlay() {
    // A resting boulder with a creature a few cells below it in the same
    // column: dig out its footing (the cell just under it) to drop it.
    for (const r of rocks) {
      if (r.state !== 'rest' && r.state !== 'teeter') continue
      const below = creatures.find((c) => !c.dead && c.cx === r.gx && c.cy > r.gy && c.cy - r.gy <= 4)
      if (below) return { cx: r.gx, cy: r.gy + 1 }
    }
    return null
  }

  function autopilot(dt) {
    if (harpoon) {
      firing = true
      return
    }
    let best = null
    let bd = 1e9
    for (const c of creatures) {
      const d = manhattan(c.cx, c.cy, player.cx, player.cy)
      if (d < bd) {
        bd = d
        best = c
      }
    }
    firing = false
    if (!best) {
      aiDir = null
      return
    }

    const dx = best.cx - player.cx
    const dy = best.cy - player.cy
    let line = null
    if (dy === 0 && dx !== 0 && Math.abs(dx) <= HARP_REACH) line = dx > 0 ? RIGHT : LEFT
    else if (dx === 0 && dy !== 0 && Math.abs(dy) <= HARP_REACH) line = dy > 0 ? DOWN : UP
    if (line && best.stage === 0 && clearLine(line, Math.max(Math.abs(dx), Math.abs(dy)))) {
      player.face = line
      player.dir = line
      aiDir = null
      firing = true
      fireHarpoon()
      return
    }

    const goal = boulderPlay() || { cx: best.cx, cy: best.cy }
    const order = towardDirs(player.cx, player.cy, goal.cx, goal.cy)
    aiDir = order.find((d) => passable(player.cx + d.x, player.cy + d.y, 'dig')) || null
  }

  // ── Simulation ────────────────────────────────────────────────────────
  function tick(dt) {
    const idle = now - lastHumanInput > AUTOPILOT_IDLE_MS
    player.invuln = Math.max(0, player.invuln - dt)
    banner.t = Math.max(0, banner.t - dt)

    if (player.alive) {
      if (idle) autopilot(dt)
      const moveDir = idle ? aiDir : inputDir
      player.speed = sprinting && !idle ? SPRINT_SPEED : BASE_SPEED
      if (!harpoon) {
        advance(player, moveDir, dt, 'dig') // frozen while a harpoon is out
        if (player.dir) player.face = player.dir
      }
    }

    // Pump-harpoon lifecycle.
    if (harpoon) {
      if (harpoon.target) {
        if (harpoon.target.dead) harpoon = null
        else if (firing) {
          harpoon.pumpAcc += dt
          if (harpoon.pumpAcc >= PUMP_TIME) {
            harpoon.pumpAcc = 0
            harpoon.target.stage++
            if (harpoon.target.stage >= POP_STAGE) {
              popCreature(harpoon.target)
              harpoon = null
            }
          }
        } else {
          harpoon.target.deflating = true // R2 released — let it recover
          harpoon = null
        }
      } else {
        harpoon.t -= dt
        if (harpoon.t <= 0) harpoon = null // missed — retract
      }
    }

    for (const c of creatures) {
      if (c.deflating) {
        c.stage -= dt * 3.5
        if (c.stage <= 0) {
          c.stage = 0
          c.deflating = false
        }
      }
      updateCreature(c, dt)
    }

    updateRocks(dt)

    // Ship ↔ creature: touching an un-grabbed creature costs a life.
    if (player.alive && player.invuln <= 0) {
      for (const c of creatures) {
        if (!c.dead && c.stage === 0 && Math.hypot(c.x - player.x, c.y - player.y) < 22) {
          killPlayer()
          break
        }
      }
    }

    for (const p of particles) {
      p.vy += p.grav * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.life -= dt
    }
    particles = particles.filter((p) => p.life > 0)

    creatures = creatures.filter((c) => !c.dead)
    if (creatures.length === 0 && !nextLevelAt && !gameOver) {
      nextLevelAt = now + 1400
      banner = { text: 'AREA CLEAR', t: 1.4 }
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  function strata(cy) {
    const t = (cy - 1) / (ROWS - 2) // 0 top of earth → 1 bottom
    const hue = 26 - t * 24 - (level - 1) * 7
    const sat = 46 - t * 10
    const lig = 21 - t * 9
    return `hsl(${hue}, ${sat}%, ${lig}%)`
  }

  function drawEarth() {
    // Surface strip with a glowing horizon.
    const sky = ctx.createLinearGradient(0, 0, 0, CELL)
    sky.addColorStop(0, '#1c1226')
    sky.addColorStop(1, '#331a0e')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, W, CELL)
    ctx.save()
    ctx.strokeStyle = ACCENT
    ctx.globalAlpha = 0.55
    ctx.shadowColor = ACCENT
    ctx.shadowBlur = 12
    ctx.beginPath()
    ctx.moveTo(0, CELL)
    ctx.lineTo(W, CELL)
    ctx.stroke()
    ctx.restore()

    for (let x = 0; x < COLS; x++) {
      for (let y = 1; y < ROWS; y++) {
        const px = x * CELL
        const py = y * CELL
        if (dug[x][y]) continue // tunnels are the dark backdrop
        ctx.fillStyle = strata(y)
        ctx.fillRect(px, py, CELL, CELL)
        // Banding + speckle so each stratum reads as packed earth.
        ctx.fillStyle = 'rgba(0,0,0,0.16)'
        ctx.fillRect(px, py + CELL * 0.5, CELL, 2)
        for (let k = 0; k < 3; k++) {
          ctx.globalAlpha = 0.12
          ctx.fillStyle = k % 2 ? '#000' : ACCENT
          ctx.fillRect(px + hash(x + k, y) * (CELL - 4), py + hash(x, y + k) * (CELL - 4), 2, 2)
          ctx.globalAlpha = 1
        }
      }
    }

    // Glowing carved rims where tunnels meet solid earth.
    ctx.save()
    ctx.strokeStyle = 'rgba(255,150,90,0.28)'
    ctx.lineWidth = 2
    for (let x = 0; x < COLS; x++) {
      for (let y = 1; y < ROWS; y++) {
        if (!dug[x][y]) continue
        const px = x * CELL
        const py = y * CELL
        ctx.beginPath()
        if (y + 1 < ROWS && !dug[x][y + 1]) {
          ctx.moveTo(px + 1, py + CELL - 1)
          ctx.lineTo(px + CELL - 1, py + CELL - 1)
        }
        if (x + 1 < COLS && !dug[x + 1][y]) {
          ctx.moveTo(px + CELL - 1, py + 1)
          ctx.lineTo(px + CELL - 1, py + CELL - 1)
        }
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  function drawRocks() {
    for (const r of rocks) {
      if (r.state === 'gone') continue
      const wob = r.state === 'teeter' ? Math.sin(now / 40) * 2 : 0
      const x = r.x + wob
      const y = r.y
      if (r.state === 'shatter') {
        ctx.globalAlpha = Math.max(0, r.t / 0.35)
      }
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.6)'
      ctx.shadowBlur = 10
      const g = ctx.createRadialGradient(x - 6, y - 8, 3, x, y, CELL * 0.5)
      g.addColorStop(0, '#b79a72')
      g.addColorStop(0.6, '#8a6f4c')
      g.addColorStop(1, '#5a4630')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.roundRect(x - CELL * 0.42, y - CELL * 0.42, CELL * 0.84, CELL * 0.84, 9)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,220,180,0.25)'
      ctx.lineWidth = 1.4
      ctx.stroke()
      ctx.restore()
      ctx.globalAlpha = 1
    }
  }

  function drawHarpoon() {
    if (!harpoon) return
    const d = harpoon.dir
    let ex, ey
    if (harpoon.target) {
      ex = harpoon.target.x
      ey = harpoon.target.y
    } else {
      const span = harpoon.reach + 0.5
      ex = player.x + d.x * span * CELL * 0.5
      ey = player.y + d.y * span * CELL * 0.5
    }
    ctx.save()
    ctx.strokeStyle = ACCENT
    ctx.shadowColor = ACCENT
    ctx.shadowBlur = 10
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(player.x, player.y)
    ctx.lineTo(ex, ey)
    ctx.stroke()
    // Spearhead.
    ctx.fillStyle = '#ffd6ad'
    ctx.beginPath()
    ctx.arc(ex, ey, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  function drawCreatures() {
    for (const c of creatures) {
      const scale = 1 + c.stage * 0.34
      const r = 13 * scale
      const wob = c.stage > 0 ? Math.sin(c.wob) * 1.5 : 0
      ctx.save()
      ctx.globalAlpha = c.alpha
      const isP = c.type === 'phantom'
      ctx.shadowColor = isP ? '#b98cff' : '#ff5566'
      ctx.shadowBlur = c.stage > 0 ? 20 : 10
      const g = ctx.createRadialGradient(c.x - 4, c.y - 5, 2, c.x, c.y, r)
      if (isP) {
        g.addColorStop(0, '#e3d0ff')
        g.addColorStop(0.6, '#9b6cff')
        g.addColorStop(1, '#5b34b0')
      } else {
        g.addColorStop(0, '#ffb0b8')
        g.addColorStop(0.55, '#ff4d5e')
        g.addColorStop(1, '#b81f34')
      }
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(c.x + wob, c.y, r, 0, Math.PI * 2)
      ctx.fill()
      // Eyes.
      ctx.fillStyle = '#fff'
      const ex = 4.5 * scale
      for (const s of [-1, 1]) {
        ctx.beginPath()
        ctx.arc(c.x + wob + s * ex, c.y - 2, 3.2 * scale, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.fillStyle = '#1a0a12'
      for (const s of [-1, 1]) {
        ctx.beginPath()
        ctx.arc(c.x + wob + s * ex, c.y - 2, 1.5 * scale, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }
  }

  function drawPlayer() {
    if (!player.alive) return
    if (player.invuln > 0 && Math.floor(now / 110) % 2 === 0) return // respawn blink
    const d = player.face
    ctx.save()
    ctx.shadowColor = ACCENT
    ctx.shadowBlur = 14
    const g = ctx.createRadialGradient(player.x - 4, player.y - 5, 2, player.x, player.y, 15)
    g.addColorStop(0, '#ffd9b0')
    g.addColorStop(0.55, ACCENT)
    g.addColorStop(1, '#b8541a')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(player.x, player.y, 13, 0, Math.PI * 2)
    ctx.fill()
    // Drill nose in the facing direction.
    ctx.fillStyle = '#ffe9d2'
    ctx.beginPath()
    ctx.moveTo(player.x + d.x * 20, player.y + d.y * 20)
    ctx.lineTo(player.x + d.x * 9 - d.y * 7, player.y + d.y * 9 + d.x * 7)
    ctx.lineTo(player.x + d.x * 9 + d.y * 7, player.y + d.y * 9 - d.x * 7)
    ctx.closePath()
    ctx.fill()
    // Goggle eyes.
    ctx.fillStyle = '#0a1c2a'
    for (const s of [-1, 1]) {
      ctx.beginPath()
      ctx.arc(player.x - d.y * s * 5 + d.x * 3, player.y + d.x * s * 5 + d.y * 3, 3, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  function drawHud() {
    ctx.fillStyle = '#b39a86'
    ctx.font = `600 13px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText('SCORE', 16, 18)
    ctx.textAlign = 'center'
    ctx.fillText(`LEVEL ${level}`, W / 2, 18)
    ctx.textAlign = 'right'
    ctx.fillText('LIVES', W - 16, 18)
    ctx.fillStyle = '#ffe0c4'
    ctx.font = `700 16px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText(String(score).padStart(6, '0'), 16, 33)
    // Lives as little digger dots.
    for (let i = 0; i < lives; i++) {
      ctx.fillStyle = ACCENT
      ctx.beginPath()
      ctx.arc(W - 22 - i * 22, 30, 6, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  function overlay(title, sub, color, showScore) {
    ctx.fillStyle = 'rgba(6, 3, 10, 0.78)'
    ctx.fillRect(0, 0, W, H)
    const cw = 460
    const ch = showScore ? 190 : 160
    const cx = (W - cw) / 2
    const cy = (H - ch) / 2
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 30
    ctx.fillStyle = 'rgba(18, 10, 6, 0.95)'
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
      ctx.fillStyle = '#ffe0c4'
      ctx.font = `700 18px ${FONT}`
      ctx.fillText(`SCORE ${score} · LEVEL ${level}`, W / 2, cy + 100)
    }
    ctx.fillStyle = '#b39a86'
    ctx.font = `500 14px ${FONT}`
    ctx.fillText(sub, W / 2, cy + ch - 38)
  }

  function render() {
    ctx.clearRect(0, 0, W, H)
    drawEarth()
    drawRocks()
    drawHarpoon()
    drawCreatures()
    drawPlayer()

    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max)
      ctx.fillStyle = p.color
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
    }
    ctx.globalAlpha = 1

    drawHud()

    if (banner.t > 0) {
      ctx.globalAlpha = Math.min(1, banner.t / 0.4)
      ctx.fillStyle = '#ffd6ad'
      ctx.font = `700 40px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText(banner.text, W / 2, H / 2 - 40)
      ctx.globalAlpha = 1
    }

    if (gameOver) {
      overlay('GAME OVER', 'R2 / SPACE to play again — restarting…', '#ff5566', true)
    } else if (!playing) {
      overlay('PAUSED', 'claude needs you — answer in the terminal', ACCENT, false)
    }
  }

  // ── Main loop ─────────────────────────────────────────────────────────
  let last = performance.now()
  function frame(t) {
    now = t
    const dt = Math.min(0.05, (t - last) / 1000)
    last = t
    if (gameOver && t - gameOverAt > 2200) reset()
    if (nextLevelAt && t >= nextLevelAt) {
      level++
      buildLevel()
      banner = { text: `LEVEL ${level}`, t: 1.6 }
      nextLevelAt = 0
    }
    if (playing && !gameOver) tick(dt)
    render()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // ── Self-test: `?selftest` runs the pure logic and asserts. ────────────
  function selftest() {
    const ok = (cond, msg) => {
      if (!cond) throw new Error('selftest failed: ' + msg)
    }
    ok(cc(0) === 20 && cc(3) === 140, 'cell centre maths')
    ok(manhattan(0, 0, 3, 4) === 7, 'manhattan distance')

    // Toward a target to the right: first move must be RIGHT and it must close.
    const first = towardDirs(2, 5, 10, 5)[0]
    ok(eqDir(first, RIGHT), 'dominant axis leads horizontally')
    ok(manhattan(2 + first.x, 5 + first.y, 10, 5) < manhattan(2, 5, 10, 5), 'first step reduces distance')
    // Vertical dominance flips the order.
    ok(eqDir(towardDirs(5, 2, 5, 12)[0], DOWN), 'dominant axis leads vertically')
    // towardDirs always offers all four directions as fallbacks.
    ok(towardDirs(5, 5, 5, 5).length === 4, 'all directions available as fallback')

    const h = hash(3, 7)
    ok(h >= 0 && h < 1, 'hash stays in [0,1)')

    console.log('[tunneler] selftest passed')
    document.getElementById('status').textContent = 'selftest passed ✓'
  }
})()
