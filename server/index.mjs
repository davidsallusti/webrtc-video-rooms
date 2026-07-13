import express from 'express'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertRecordingConsentForJoin,
  authenticateAccess,
  connectedParticipantCount,
  createRoom,
  findRoomByLivekitName,
  frameAncestorsForEmbedRoom,
  getPublicRoom,
  getRoom,
  issuePortalAccess,
  markAllDisconnected,
  markConnected,
  markDisconnected,
  recordConsentDirect,
  validatePasswordAndIssueAccess,
} from './store.mjs'
import { createAdminRouter, createParticipantControlRouter } from './admin.mjs'
import { createEmbedRouter } from './embed.mjs'
import { createIntegrationRouter } from './integrations.mjs'
import {
  deleteLivekitRoom,
  issueLivekitToken,
  livekitClientUrl,
  receiveWebhookEvent,
  verifyPortalToken,
} from './livekit.mjs'
import { handleEgressEnded, stopActiveRecordingForRoom } from './recordings.mjs'
import { createRateLimiter, readLimit } from './rate-limit.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const server = createServer(app)
const isProduction = process.env.NODE_ENV === 'production'
const publicOrigin = normalizeOrigin(process.env.WEBRTC_PUBLIC_ORIGIN)
const livekitHttpOrigin = normalizeOrigin(livekitClientUrl().replace(/^ws/, 'http'))
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

// Browser origins allowed to call the participant/portal/integration APIs
// cross-origin (HirePortal runs in the browser and has no backend of its own).
const corsOrigins = new Set(String(process.env.WEBRTC_CORS_ORIGINS || '')
  .split(',')
  .map((origin) => normalizeOrigin(origin.trim()))
  .filter(Boolean))

app.disable('x-powered-by')
app.set('trust proxy', isProduction || process.env.WEBRTC_TRUST_PROXY === '1' ? 1 : false)
app.use(securityHeaders)
app.use(corsForAllowedOrigins)
app.use(validateRequestHost)
// LiveKit signs webhook bodies; the receiver needs the raw payload.
app.use('/api/livekit/webhooks', express.text({ type: '*/*', limit: '256kb' }))
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

// Minimal CORS: reflect only allowlisted origins, credentials stay disallowed.
// Participant/portal auth rides in explicit headers, never cookies.
function corsForAllowedOrigins(req, res, next) {
  const origin = normalizeOrigin(req.get('origin'))
  if (origin && corsOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-participant-id,x-room-access-token')
    res.setHeader('Access-Control-Max-Age', '600')
  }
  if (req.method === 'OPTIONS' && req.path.startsWith('/api/')) {
    res.status(204).end()
    return
  }
  next()
}

function securityHeaders(req, res, next) {
  const embedAncestors = embedFrameAncestors(req)
  // Swagger UI (admin API docs) injects inline styles; scope the relaxation
  // to that route alone — everywhere else stays style-src 'self'.
  const isApiDocs = req.path.startsWith('/api/admin/docs')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    // ws:/wss: cover the LiveKit signal socket; the https origin is needed for
    // the client SDK's non-websocket calls when a media server is configured.
    `connect-src 'self' ws: wss:${livekitHttpOrigin ? ` ${livekitHttpOrigin}` : ''}`,
    embedAncestors.length ? `frame-ancestors 'self' ${embedAncestors.join(' ')}` : "frame-ancestors 'none'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "script-src 'self'",
    isApiDocs ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
  ].join('; '))
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
}

function embedFrameAncestors(req) {
  const match = req.path.match(/^\/embed\/rooms\/([^/?#]+)/)
  if (!match) return []
  return frameAncestorsForEmbedRoom(decodeURIComponent(match[1]))
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: 'local-first', transport: 'livekit-sfu' })
})

app.post('/api/rooms', asyncRoute(async (req, res) => {
  roomCreateLimiter.check(clientIp(req))
  const { displayName, password, metadata } = req.body || {}
  const result = createRoom({ displayName, password, metadata, origin: originFor(req) })
  res.status(201).json(result)
}))

app.get('/api/rooms/:roomId', asyncRoute(async (req, res) => {
  const room = getPublicRoom(req.params.roomId)
  res.json({ room, activeParticipants: connectedParticipantCount(room.id) })
}))

app.post('/api/rooms/:roomId/access', asyncRoute(async (req, res) => {
  accessAttemptLimiter.check(`${req.params.roomId}:${clientIp(req)}`)
  const result = validatePasswordAndIssueAccess({
    roomId: req.params.roomId,
    password: req.body?.password,
    email: req.body?.email,
    displayName: req.body?.displayName,
    ip: clientIp(req),
    activeCount: connectedParticipantCount(req.params.roomId),
  })
  res.json(result)
}))

// Media credentials. Every control-plane gate has to pass first: valid access
// token (password/allowlist/join window happened at issuance), admitted status,
// occupancy, and — for recorded rooms — acknowledged consent.
app.post('/api/rooms/:roomId/livekit-token', asyncRoute(async (req, res) => {
  const participantId = req.get('x-participant-id')
  const accessToken = req.get('x-room-access-token')
  const auth = authenticateAccess({ roomId: req.params.roomId, participantId, accessToken })
  assertRecordingConsentForJoin(req.params.roomId, auth.access.participant_id)
  if (connectedParticipantCount(req.params.roomId) >= auth.room.maxParticipants) {
    res.status(409).json({ error: 'room_full', message: 'This room is already full.' })
    return
  }
  const livekit = await issueLivekitToken({
    room: getRoom(req.params.roomId),
    participantId: auth.access.participant_id,
    role: auth.access.role,
    displayName: auth.access.display_name,
    email: auth.access.email,
  })
  res.json({ livekit })
}))

// Portal join: a HirePortal-minted LiveKit JWT is proof of portal login.
// Resolves the room via the token's LiveKit room grant and auto-admits.
// Recorded rooms require an explicit acknowledgeRecording flag (no notice UI
// exists on the portal side; the contract doc covers this).
app.post('/api/portal/access', asyncRoute(async (req, res) => {
  accessAttemptLimiter.check(`portal:${clientIp(req)}`)
  const claims = await verifyPortalToken(bearerToken(req) || req.body?.token)
  const room = findRoomByLivekitName(claims.livekitRoomName)
  if (!room) {
    res.status(404).json({ error: 'room_not_found', message: 'No active room matches this token.' })
    return
  }
  const access = issuePortalAccess({
    room,
    identity: claims.identity,
    name: claims.name,
    ip: clientIp(req),
    activeCount: connectedParticipantCount(room.id),
  })
  if (req.body?.acknowledgeRecording === true) {
    recordConsentDirect({ roomId: room.id, participantId: access.participantId, accessTokenValue: access.accessToken, status: 'acknowledged' })
  }
  assertRecordingConsentForJoin(room.id, access.participantId)
  const livekit = await issueLivekitToken({
    room,
    participantId: access.participantId,
    role: access.role,
    displayName: claims.name,
  })
  res.json({ room: getPublicRoom(room.id), access, livekit })
}))

// LiveKit event ingestion: presence bookkeeping + recording lifecycle.
app.post('/api/livekit/webhooks', asyncRoute(async (req, res) => {
  const event = await receiveWebhookEvent(req.body, req.get('authorization'))
  const room = event.room?.name ? findRoomByLivekitName(event.room.name) : null
  if (event.event === 'participant_joined' && room) {
    const metadata = safeParticipantMetadata(event.participant)
    markConnected({ roomId: room.id, participantId: event.participant.identity, role: metadata.role || 'guest' })
  } else if (event.event === 'participant_left' && room) {
    markDisconnected({ roomId: room.id, participantId: event.participant.identity })
  } else if (event.event === 'room_finished' && room) {
    markAllDisconnected(room.id)
  } else if (event.event === 'egress_ended') {
    await handleEgressEnded(event.egressInfo)
  }
  res.json({ ok: true })
}))

function bearerToken(req) {
  const [scheme, token] = String(req.get('authorization') || '').split(/\s+/, 2)
  return scheme?.toLowerCase() === 'bearer' ? token : ''
}

function safeParticipantMetadata(participant) {
  try {
    return JSON.parse(participant?.metadata || '{}') || {}
  } catch {
    return {}
  }
}

// Room end from any surface: stop recording, tear down the LiveKit room
// (disconnects all clients), close out presence.
function onRoomEnded(roomId) {
  const room = getRoom(roomId)
  stopActiveRecordingForRoom(roomId)
  if (room?.livekit_room_name) deleteLivekitRoom(room.livekit_room_name).catch(() => {})
  markAllDisconnected(roomId)
}

app.use('/api/rooms', createParticipantControlRouter({
  clientIp,
  onRoomEnded,
}))

app.use('/api/embed', createEmbedRouter({
  clientIp,
  activeParticipantCount: connectedParticipantCount,
}))

app.use('/api/admin', createAdminRouter({
  isProduction,
  clientIp,
  onRoomEnded,
}))

app.use('/api/integrations', createIntegrationRouter({
  clientIp,
}))

app.get('/embed/rooms/:roomId', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>WebRTC Local Embed</title>
  </head>
  <body>
    <main id="root" data-embed-room="${String(_req.params.roomId || '').replace(/"/g, '&quot;')}">
      <h1>WebRTC local embed</h1>
      <p>This local iframe surface uses a scoped embed session. No admin or integration credentials are present.</p>
    </main>
  </body>
</html>`)
})

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
