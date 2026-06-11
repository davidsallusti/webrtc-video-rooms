import express from 'express'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createRoom,
  getPublicRoom,
  validatePasswordAndIssueAccess,
} from './store.mjs'
import { activeParticipantCount, attachSignaling } from './signaling.mjs'
import { createRateLimiter, readLimit } from './rate-limit.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const server = createServer(app)
const isProduction = process.env.NODE_ENV === 'production'
const publicOrigin = normalizeOrigin(process.env.WEBRTC_PUBLIC_ORIGIN)
const roomCreateLimiter = createRateLimiter({
  limit: readLimit('WEBRTC_ROOM_CREATE_LIMIT', 12),
  windowMs: readLimit('WEBRTC_ROOM_CREATE_WINDOW_MS', 5 * 60_000),
  message: 'Too many rooms created from this network. Try again shortly.',
})
const accessAttemptLimiter = createRateLimiter({
  limit: readLimit('WEBRTC_ACCESS_ATTEMPT_LIMIT', 30),
  windowMs: readLimit('WEBRTC_ACCESS_ATTEMPT_WINDOW_MS', 60_000),
  message: 'Too many room access attempts. Try again shortly.',
})

app.disable('x-powered-by')
app.set('trust proxy', isProduction || process.env.WEBRTC_TRUST_PROXY === '1' ? 1 : false)
app.use(securityHeaders)
app.use(validateRequestHost)
app.use(express.json({ limit: '32kb' }))

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'local'
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

function normalizeOrigin(value) {
  if (!value) return ''
  try {
    const url = new URL(value)
    return url.origin
  } catch {
    return ''
  }
}

function requestOrigin(req) {
  return normalizeOrigin(`${req.protocol}://${req.get('host') || ''}`)
}

function originFor(req) {
  return publicOrigin || requestOrigin(req)
}

function validateRequestHost(req, res, next) {
  const host = req.get('host') || ''
  const requestUrlOrigin = requestOrigin(req)
  if (!host || !requestUrlOrigin || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) {
    res.status(400).json({ error: 'bad_host', message: 'Invalid request host.' })
    return
  }
  if (publicOrigin && requestUrlOrigin !== publicOrigin) {
    res.status(403).json({ error: 'origin_not_allowed', message: 'Request origin is not allowed.' })
    return
  }
  next()
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join('; '))
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: 'local-first', transport: 'webrtc-p2p' })
})

app.post('/api/rooms', asyncRoute(async (req, res) => {
  roomCreateLimiter.check(clientIp(req))
  const { displayName, password } = req.body || {}
  const result = createRoom({ displayName, password, origin: originFor(req) })
  res.status(201).json(result)
}))

app.get('/api/rooms/:roomId', asyncRoute(async (req, res) => {
  const room = getPublicRoom(req.params.roomId)
  res.json({ room, activeParticipants: activeParticipantCount(room.id) })
}))

app.post('/api/rooms/:roomId/access', asyncRoute(async (req, res) => {
  accessAttemptLimiter.check(`${req.params.roomId}:${clientIp(req)}`)
  const result = validatePasswordAndIssueAccess({
    roomId: req.params.roomId,
    password: req.body?.password,
    ip: clientIp(req),
    activeCount: activeParticipantCount(req.params.roomId),
  })
  res.json(result)
}))

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Not found' })
})

app.use((error, _req, res, _next) => {
  const status = error.status || 500
  res.status(status).json({
    error: error.code || 'server_error',
    message: status >= 500 ? 'Something went wrong.' : error.message,
  })
})

if (isProduction) {
  const publicDir = join(__dirname, '..', 'dist')
  app.use(express.static(publicDir))
  app.get('*', (_req, res) => res.sendFile(join(publicDir, 'index.html')))
}

attachSignaling(server)

const port = Number(process.env.PORT || 4321)
const host = process.env.HOST || (isProduction ? '0.0.0.0' : '127.0.0.1')

export { app, server }

export function startServer({ port: listenPort = port, host: listenHost = host, log = true } = {}) {
  return server.listen(listenPort, listenHost, () => {
    if (log) console.log(`WebRTC API listening on http://${listenHost}:${listenPort}`)
  })
}

if (process.env.WEBRTC_NO_LISTEN !== '1') {
  startServer()
}
