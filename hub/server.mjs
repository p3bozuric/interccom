// The hub: HTTP API on 127.0.0.1, session board, talk queue + player,
// voice routing, and NDJSON event streams back to sessions.
import http from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Board, ROLES } from './board.mjs'
import { TalkQueue } from './queue.mjs'
import { route } from './router.mjs'
import { toSpeakable } from './text.mjs'
import { createPlayer } from './player.mjs'

export { createPlayer }

const PRIORITIES = new Set(['question', 'heads-up', 'status'])
const MODES = new Set(['wake', 'always', 'off'])
const CONFIG_FIELDS = ['apiKey', 'voiceId', 'ttsModel', 'sttLanguage', 'listenMode', 'muted']
const ERROR_WINDOW_MS = 60_000
const MAX_BODY = 1 << 20
const NONCE = /^[0-9a-f]{1,128}$/i

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({})
      try {
        const v = JSON.parse(raw)
        resolve(v && typeof v === 'object' ? v : {})
      } catch { reject(new HttpError(400, 'invalid JSON')) }
    })
    req.on('error', reject)
  })
}

export function createHub({ token, engines, audio, now = Date.now, idleExitMs = 30_000, onIdleExit = () => {}, startPaused = false, streamGraceMs = 15_000, pingMs = 30_000 }) {
  const board = new Board()
  const queue = new TalkQueue()
  const streams = new Map() // sessionId -> open events response
  const graceTimers = new Map() // sessionId -> timer removing a session that never opened /events
  const lastErrorAt = new Map() // message -> time sent
  const config = {
    apiKey: '',
    voiceId: '21m00Tcm4TlvDq8ikWAM',
    ttsModel: 'eleven_flash_v2_5',
    sttModel: 'scribe_v1',
    sttLanguage: 'en',
    listenMode: 'wake',
    muted: false,
  }
  let listenSticky = false
  const configListeners = []
  let armedUntil = 0
  let micState = 'off' // 'listening' | 'off', replayed to every new stream
  let idleTimer = null
  const tokenBuf = Buffer.from(String(token))

  const player = createPlayer({
    queue, engines, audio, board, now, startPaused,
    getConfig: () => ({ ...config }),
    onError: err => reportError(err),
    boardSize: () => board.size,
  })

  function send(res, obj) {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n')
  }

  function broadcast(obj) {
    if (obj?.type === 'mic') micState = obj.state
    for (const res of streams.values()) send(res, obj)
  }

  function reportError(err) {
    const message = String(err?.message ?? err)
    const t = now()
    const prev = lastErrorAt.get(message)
    if (prev !== undefined && t - prev < ERROR_WINDOW_MS) return
    lastErrorAt.set(message, t)
    broadcast({ type: 'error', message })
  }

  function cancelIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  }

  function startIdle() {
    cancelIdle()
    idleTimer = setTimeout(() => { idleTimer = null; onIdleExit() }, idleExitMs)
    idleTimer.unref?.()
  }

  function clearGrace(id) {
    clearTimeout(graceTimers.get(id))
    graceTimers.delete(id)
  }

  function removeSession(id) {
    clearGrace(id)
    if (!board.get(id)) return
    board.remove(id)
    const res = streams.get(id)
    streams.delete(id)
    res?.end()
    if (board.size === 0) startIdle()
  }

  function stop() {
    armedUntil = 0
    const flushed = queue.flush()
    player.stop()
    return flushed
  }

  // The coordinator counts only once its stream is open: until then, sessions work as if it weren't there.
  function liveCoordinator() {
    const c = board.coordinator()
    return c && streams.has(c.sessionId) ? c : undefined
  }

  async function hear(text) {
    const coord = liveCoordinator()
    const r = route(String(text ?? ''), {
      mode: config.listenMode,
      names: board.list().filter(row => row !== coord).map(row => row.name),
      armedUntil,
      now: now(),
    })
    if (r.kind === 'arm') { armedUntil = r.until; return }
    if (r.kind === 'stop') { stop(); return }
    if (r.kind !== 'deliver') return
    armedUntil = 0
    if (coord) {
      // The coordinator hears everything; a name after the wake word is a hint, and it does the routing.
      board.markActive(coord.sessionId, now())
      send(streams.get(coord.sessionId), { type: 'heard', text: r.text, ...(r.name !== undefined ? { addressed: r.name } : {}) })
      return
    }
    const target = (r.name !== undefined && board.byName(r.name)) || board.defaultTarget()
    const res = target && streams.get(target.sessionId)
    if (!res) return
    // Whoever you just spoke to is the one you're working with now.
    board.markActive(target.sessionId, now())
    send(res, { type: 'heard', text: r.text })
  }

  // One coordinator per machine: a second one is refused unless it takes over.
  function setRole(id, role, takeover, t) {
    if (!ROLES.has(role)) throw new HttpError(400, 'role must be worker or coordinator')
    const row = session(id)
    if (role === 'coordinator') {
      const current = board.coordinator()
      if (current && current !== row) {
        if (!takeover) throw new HttpError(409, `${current.name} is already the coordinator`)
        board.setRole(current.sessionId, 'worker', t)
        const res = streams.get(current.sessionId)
        if (res) send(res, { type: 'role', role: 'worker', reason: `${row.name} took over as coordinator` })
      }
    }
    board.setRole(id, role, t)
    if (role === 'coordinator') board.setQuestion(id, '', t)
    return { role, name: row.name }
  }

  function mergeConfig(body) {
    for (const k of CONFIG_FIELDS) {
      const v = body[k]
      if (v === undefined || v === null || v === '') continue
      if (k === 'muted') { config.muted = Boolean(v); continue }
      if (k === 'listenMode') {
        if (listenSticky || !MODES.has(v)) continue
      }
      config[k] = String(v)
    }
  }

  function notifyConfig() {
    for (const cb of configListeners) {
      try { cb({ ...config }) } catch (err) { reportError(err) }
    }
  }

  function session(id) {
    const row = board.get(id)
    if (!row) throw new HttpError(404, 'unknown session')
    return row
  }

  function openEvents(req, res, id) {
    const row = session(id)
    cancelIdle()
    clearGrace(id)
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
    const older = streams.get(id)
    streams.set(id, res)
    older?.end()
    send(res, { type: 'hello', sessionId: id, name: row.name })
    // The mic may have started before this session opened its stream.
    send(res, { type: 'mic', state: micState })
    // Keepalive: Node's fetch drops a response body that stays quiet for 300 s.
    const ping = setInterval(() => send(res, { type: 'ping' }), pingMs)
    ping.unref?.()
    res.on('close', () => {
      clearInterval(ping)
      if (streams.get(id) === res) {
        streams.delete(id)
        removeSession(id)
      }
    })
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    const m = req.method
    if (m === 'GET' && path === '/events') return openEvents(req, res, url.searchParams.get('session'))
    const body = m === 'POST' ? await readJson(req) : {}
    const t = now()

    if (m === 'GET' && path === '/health') return { ok: true, sessions: board.size }
    if (m === 'GET' && path === '/board') {
      return {
        sessions: board.list().map(r => ({ ...r })),
        mode: config.listenMode,
        playing: player.isPlaying(),
        coordinator: liveCoordinator()?.name ?? null,
        decisions: board.decisions(),
      }
    }
    if (m === 'POST' && path === '/sessions') {
      cancelIdle()
      const reg = board.register({ name: body.name, cwd: body.cwd, pid: body.pid }, t)
      const timer = setTimeout(() => removeSession(reg.sessionId), streamGraceMs)
      timer.unref?.()
      graceTimers.set(reg.sessionId, timer)
      return reg
    }
    if (m === 'POST' && path === '/config') { mergeConfig(body); notifyConfig(); return {} }
    if (m === 'POST' && path === '/listen') {
      if (!MODES.has(body.mode)) throw new HttpError(400, 'mode must be wake, always or off')
      config.listenMode = body.mode
      listenSticky = true
      notifyConfig()
      return { mode: config.listenMode }
    }
    if (m === 'POST' && path === '/stop') return { flushed: stop() }
    if (m === 'POST' && path === '/speak') {
      const row = session(body.sessionId)
      const priority = PRIORITIES.has(body.priority) ? body.priority : 'status'
      const spoken = toSpeakable(body.text ?? '')
      if (!spoken) return { queued: false }
      const coord = liveCoordinator()
      if (coord && coord !== row) {
        // With a coordinator, workers report to it instead of the speakers.
        board.setLastLine(row.sessionId, spoken, t)
        board.setQuestion(row.sessionId, priority === 'question' ? spoken : '', t)
        send(streams.get(coord.sessionId), { type: 'report', from: row.name, priority, text: spoken })
        return { queued: true, spoken, relayed: true }
      }
      if (row.role !== 'coordinator') board.setQuestion(row.sessionId, priority === 'question' ? spoken : '', t)
      queue.push({ sessionId: row.sessionId, name: row.name, text: spoken, priority })
      player.kick()
      return { queued: true, spoken }
    }

    if (m === 'POST' && (path === '/board/resolve' || path === '/board/decision')) {
      const row = session(body.sessionId)
      if (row.role !== 'coordinator') throw new HttpError(403, 'only the coordinator can change the board')
      if (path === '/board/decision') {
        const text = toSpeakable(body.text ?? '')
        if (!text) throw new HttpError(400, 'decision text is empty')
        board.logDecision(text, t)
        return { logged: true }
      }
      const target = board.byName(String(body.name ?? ''))
      if (!target) throw new HttpError(404, 'no session by that name')
      board.setQuestion(target.sessionId, '', t)
      return { resolved: target.name }
    }

    const sm = /^\/sessions\/([^/]+)(?:\/(name|state|active|role))?$/.exec(path)
    if (sm) {
      let id
      try { id = decodeURIComponent(sm[1]) } catch { throw new HttpError(400, 'malformed session id') }
      const action = sm[2]
      if (!action && m === 'DELETE') { session(id); removeSession(id); return {} }
      if (action && m === 'POST') {
        session(id)
        if (action === 'name') return { name: board.rename(id, body.name, t) }
        if (action === 'state') { board.setBusy(id, Boolean(body.busy), t); return {} }
        if (action === 'role') return setRole(id, body.role, Boolean(body.takeover), t)
        board.markActive(id, t)
        return {}
      }
    }
    throw new HttpError(404, 'not found')
  }

  function authorized(req) {
    const got = Buffer.from(String(req.headers['x-interccom-token'] ?? ''))
    return got.length === tokenBuf.length && timingSafeEqual(got, tokenBuf)
  }

  const server = http.createServer(async (req, res) => {
    const reply = (status, obj) => {
      if (res.headersSent) { res.end(); return }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    // Identity proof, answered without the token: a caller checks that this hub owns
    // the token it holds before sending it. The reply is the proof and nothing else.
    let url
    try { url = new URL(req.url, 'http://127.0.0.1') } catch { return reply(400, { error: 'malformed URL' }) }
    if (req.method === 'GET' && url.pathname === '/health' && url.searchParams.has('nonce')) {
      const nonce = url.searchParams.get('nonce')
      if (!NONCE.test(nonce)) return reply(400, { error: 'nonce must be hex' })
      return reply(200, { proof: createHmac('sha256', token).update(nonce).digest('hex') })
    }
    if (!authorized(req)) return reply(401, { error: 'unauthorized' })
    try {
      const out = await handle(req, res)
      if (out !== undefined) reply(200, out)
    } catch (err) {
      reply(err instanceof HttpError ? err.status : 500, { error: err.message })
    }
  })

  return {
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          if (board.size === 0) startIdle()
          resolve({ port: server.address().port })
        })
      })
    },
    close() {
      cancelIdle()
      for (const timer of graceTimers.values()) clearTimeout(timer)
      graceTimers.clear()
      player.stop()
      for (const res of streams.values()) res.end()
      streams.clear()
      return new Promise(resolve => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
    hear,
    reportError,
    broadcast,
    resumePlayer: () => player.resume(),
    getConfig: () => ({ ...config }),
    onConfigChange: cb => { configListeners.push(cb) },
    isPlaying: () => player.isPlaying(),
    mutedUntil: () => player.mutedUntil(),
  }
}
