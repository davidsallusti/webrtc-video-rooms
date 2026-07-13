import { AccessToken, TokenVerifier, RoomServiceClient, EgressClient, WebhookReceiver, EncodedFileType } from 'livekit-server-sdk'
import { readLimit } from './rate-limit.mjs'

// LiveKit is the media plane; this app remains the control plane. Token minting
// is pure local JWT signing (works offline); RoomServiceClient/EgressClient need
// a reachable LiveKit server and are no-ops in unconfigured local runs.
const livekitUrl = process.env.WEBRTC_LIVEKIT_URL || ''
const apiKey = process.env.WEBRTC_LIVEKIT_API_KEY || ''
const apiSecret = process.env.WEBRTC_LIVEKIT_API_SECRET || ''
// HirePortal's own LiveKit keypair. The portal mints HS256 tokens in the browser
// with this pair; we accept them as proof the user is authenticated in the portal.
const portalApiKey = process.env.WEBRTC_PORTAL_API_KEY || ''
const portalApiSecret = process.env.WEBRTC_PORTAL_API_SECRET || ''
const participantTokenTtlSeconds = readLimit('WEBRTC_LIVEKIT_TOKEN_TTL_SECONDS', 6 * 60 * 60)

const httpUrl = livekitUrl.replace(/^ws/, 'http')
const roomService = livekitUrl && apiKey && apiSecret ? new RoomServiceClient(httpUrl, apiKey, apiSecret) : null
const egressService = livekitUrl && apiKey && apiSecret ? new EgressClient(httpUrl, apiKey, apiSecret) : null
const webhookReceiver = apiKey && apiSecret ? new WebhookReceiver(apiKey, apiSecret) : null
const portalVerifier = portalApiKey && portalApiSecret ? new TokenVerifier(portalApiKey, portalApiSecret) : null

export function livekitConfigured() {
  return Boolean(livekitUrl && apiKey && apiSecret)
}

export function livekitClientUrl() {
  return livekitUrl
}

export function portalTokensConfigured() {
  return Boolean(portalVerifier)
}

function configError(message, code) {
  const error = new Error(message)
  error.code = code
  error.status = 503
  return error
}

// Mint a participant token for OUR LiveKit keypair after all control-plane
// gates (password, allowlist, join window, admission, occupancy) have passed.
export async function issueLivekitToken({ room, participantId, role, displayName, email }) {
  if (!livekitConfigured()) throw configError('Media server is not configured.', 'livekit_not_configured')
  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantId,
    name: displayName || (role === 'host' ? 'Host' : 'Guest'),
    ttl: participantTokenTtlSeconds,
    metadata: JSON.stringify({ role, email: email || null, appRoomId: room.id }),
  })
  token.addGrant({
    room: room.livekit_room_name || room.livekitRoomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  })
  return {
    url: livekitUrl,
    roomName: room.livekit_room_name || room.livekitRoomName,
    token: await token.toJwt(),
  }
}

// Verify a HirePortal-minted LiveKit JWT and return its identity claims.
// Signature proof = the holder is logged in to the portal; the video grant's
// room name ties the token to a specific interview room.
export async function verifyPortalToken(token) {
  if (!portalVerifier) throw configError('Portal tokens are not configured.', 'portal_tokens_not_configured')
  try {
    const claims = await portalVerifier.verify(String(token || ''))
    const grant = claims.video || {}
    if (!grant.roomJoin || !grant.room) throw new Error('missing room grant')
    return {
      identity: String(claims.sub || '').slice(0, 96),
      name: String(claims.name || '').slice(0, 120),
      livekitRoomName: String(grant.room).slice(0, 64),
      metadata: String(claims.metadata || '').slice(0, 512),
    }
  } catch {
    const error = new Error('Invalid portal token.')
    error.code = 'invalid_portal_token'
    error.status = 401
    throw error
  }
}

// Server-side occupancy from the media plane. Falls back to null when LiveKit
// is unreachable so callers can use presence-table counts instead.
export async function livekitParticipantCount(livekitRoomName) {
  if (!roomService) return null
  try {
    const participants = await roomService.listParticipants(livekitRoomName)
    return participants.length
  } catch {
    return null
  }
}

// Ending a room in the control plane tears down the LiveKit room, which
// disconnects every connected client (portal-token holders included).
export async function deleteLivekitRoom(livekitRoomName) {
  if (!roomService) return false
  try {
    await roomService.deleteRoom(livekitRoomName)
    return true
  } catch {
    return false
  }
}

// Start a composite (all participants, single file) room recording. Output goes
// to the storage adapter's target: a mounted folder locally, S3 in production.
export async function startRoomEgress({ livekitRoomName, fileOutput }) {
  if (!egressService) throw configError('Recording requires a configured LiveKit egress.', 'egress_not_configured')
  const info = await egressService.startRoomCompositeEgress(livekitRoomName, {
    file: {
      fileType: EncodedFileType.MP4,
      ...fileOutput,
    },
  }, { layout: 'grid' })
  return { egressId: info.egressId, startedAt: nowFromNanos(info.startedAt) }
}

export async function stopRoomEgress(egressId) {
  if (!egressService) return null
  try {
    const info = await egressService.stopEgress(egressId)
    return info
  } catch {
    return null
  }
}

// LiveKit reports timestamps as nanosecond epoch values (bigint).
export function nowFromNanos(nanos) {
  const value = Number(nanos || 0)
  if (!value) return null
  return new Date(Math.floor(value / 1e6)).toISOString()
}

// Validates a signed LiveKit webhook request and returns the decoded event.
export async function receiveWebhookEvent(rawBody, authHeader) {
  if (!webhookReceiver) throw configError('LiveKit webhooks are not configured.', 'livekit_not_configured')
  return webhookReceiver.receive(rawBody, authHeader)
}
