import { WebSocketServer } from 'ws'
import { authenticateAccess, markConnected, markDisconnected, revokeAccess } from './store.mjs'
import { createRateLimiter, readLimit } from './rate-limit.mjs'

const rooms = new Map()
const wsMaxPayloadBytes = readLimit('WEBRTC_WS_MAX_PAYLOAD_BYTES', 32 * 1024)
const wsAuthTimeoutMs = readLimit('WEBRTC_WS_AUTH_TIMEOUT_MS', 10_000)
const publicOrigin = normalizeOrigin(process.env.WEBRTC_PUBLIC_ORIGIN)
const wsMessageLimiter = createRateLimiter({
  limit: readLimit('WEBRTC_WS_MESSAGE_LIMIT', 120),
  windowMs: readLimit('WEBRTC_WS_MESSAGE_WINDOW_MS', 60_000),
  message: 'Too many signaling messages. Try again shortly.',
})
const wsConnectLimiter = createRateLimiter({
  limit: readLimit('WEBRTC_WS_CONNECT_LIMIT', 60),
  windowMs: readLimit('WEBRTC_WS_CONNECT_WINDOW_MS', 60_000),
  message: 'Too many signaling connections. Try again shortly.',
})
const wsAuthFailureLimiter = createRateLimiter({
  limit: readLimit('WEBRTC_WS_AUTH_FAILURE_LIMIT', 12),
  windowMs: readLimit('WEBRTC_WS_AUTH_FAILURE_WINDOW_MS', 60_000),
  message: 'Too many signaling authentication failures. Try again shortly.',
})

function peersFor(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map())
  return rooms.get(roomId)
}

function safeSend(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
}

function errorPayload(code, message) {
  return { type: 'error', code, message }
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function publicPeer(peer) {
  return { participantId: peer.participantId, role: peer.role }
}

export function activeParticipantCount(roomId) {
  return rooms.get(roomId)?.size || 0
}

export function endSignalingRoom(roomId, payload = {}) {
  const roomPeers = rooms.get(roomId)
  if (!roomPeers) return
  for (const peer of roomPeers.values()) {
    safeSend(peer.ws, { type: 'room-ended', ...payload })
    peer.ws.close(4000, 'room_ended')
  }
  rooms.delete(roomId)
}

function socketIp(req) {
  const trustedProxy = process.env.NODE_ENV === 'production' || process.env.WEBRTC_TRUST_PROXY === '1'
  if (trustedProxy) {
    const forwarded = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    if (forwarded) return forwarded
  }
  return req.socket.remoteAddress || 'local'
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

function socketOrigin(req) {
  const trustedProxy = process.env.NODE_ENV === 'production' || process.env.WEBRTC_TRUST_PROXY === '1'
  const protocol = trustedProxy && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http'
  return normalizeOrigin(`${protocol}://${req.headers.host || ''}`)
}

function socketHostAllowed(req) {
  const host = req.headers.host || ''
  if (!host || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) return false
  return !publicOrigin || socketOrigin(req) === publicOrigin
}

function rawSize(raw) {
  return typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength
}

export function attachSignaling(server) {
  const wss = new WebSocketServer({ server, path: '/ws/signaling', maxPayload: wsMaxPayloadBytes })

  wss.on('connection', (ws, req) => {
    let peer = null
    const ip = socketIp(req)
    ws.on('error', () => {
      // Keep malformed WebSocket frames from becoming uncaught process errors.
    })
    if (!socketHostAllowed(req)) {
      safeSend(ws, errorPayload('origin_not_allowed', 'Request origin is not allowed.'))
      ws.close(1008, 'origin_not_allowed')
      return
    }
    try {
      wsConnectLimiter.check(ip)
    } catch (error) {
      safeSend(ws, errorPayload(error.code || 'rate_limited', error.message))
      ws.close(1008, 'rate_limited')
      return
    }

    const authTimer = setTimeout(() => {
      if (!peer) {
        safeSend(ws, errorPayload('auth_timeout', 'Signaling authentication timed out.'))
        ws.close(4001, 'auth_timeout')
      }
    }, wsAuthTimeoutMs)

    ws.on('message', (raw) => {
      if (rawSize(raw) > wsMaxPayloadBytes) {
        safeSend(ws, errorPayload('message_too_large', 'Signaling message is too large.'))
        ws.close(1009, 'message_too_large')
        return
      }
      try {
        wsMessageLimiter.check(peer?.participantId || ip)
      } catch (error) {
        safeSend(ws, errorPayload(error.code || 'rate_limited', error.message))
        ws.close(1008, 'rate_limited')
        return
      }
      const message = parseMessage(raw)
      if (!message?.type) {
        safeSend(ws, errorPayload('bad_message', 'Invalid signaling message.'))
        return
      }

      if (message.type === 'auth') {
        if (peer) {
          safeSend(ws, errorPayload('already_authenticated', 'Signaling is already authenticated.'))
          return
        }
        try {
          const auth = authenticateAccess(message)
          const roomPeers = peersFor(message.roomId)
          if (!roomPeers.has(message.participantId) && roomPeers.size >= auth.room.maxParticipants) {
            safeSend(ws, errorPayload('room_full', 'This room already has two participants.'))
            ws.close(4009, 'room_full')
            return
          }
          peer = {
            roomId: message.roomId,
            participantId: message.participantId,
            accessToken: message.accessToken,
            role: auth.access.role,
            ws,
          }
          roomPeers.set(peer.participantId, peer)
          markConnected(peer)
          clearTimeout(authTimer)
          const others = [...roomPeers.values()].filter((item) => item.participantId !== peer.participantId)
          safeSend(ws, { type: 'authenticated', self: publicPeer(peer), peers: others.map(publicPeer) })
          for (const other of others) {
            safeSend(other.ws, { type: 'peer-joined', peer: publicPeer(peer) })
          }
        } catch (error) {
          try {
            wsAuthFailureLimiter.check(ip)
          } catch (limitError) {
            safeSend(ws, errorPayload(limitError.code || 'rate_limited', limitError.message))
            ws.close(1008, 'rate_limited')
            return
          }
          safeSend(ws, errorPayload(error.code || 'auth_failed', error.message || 'Could not authenticate signaling.'))
          ws.close(4001, 'auth_failed')
        }
        return
      }

      if (!peer) {
        safeSend(ws, errorPayload('auth_required', 'Authenticate before signaling.'))
        return
      }

      if (message.type === 'leave') {
        ws.close(1000, 'leave')
        return
      }

      if (!['ready', 'offer', 'answer', 'ice-candidate', 'chat-message'].includes(message.type)) {
        safeSend(ws, errorPayload('unsupported_message', 'Unsupported signaling message.'))
        return
      }

      const roomPeers = peersFor(peer.roomId)
      const outbound = message.type === 'chat-message'
        ? {
            type: 'chat-message',
            id: message.id,
            text: String(message.text || '').trim().slice(0, 500),
            sentAt: new Date().toISOString(),
          }
        : message
      if (message.type === 'chat-message' && !outbound.text) {
        safeSend(ws, errorPayload('empty_message', 'Chat message cannot be empty.'))
        return
      }
      for (const target of roomPeers.values()) {
        if (target.participantId === peer.participantId) continue
        safeSend(target.ws, {
          ...outbound,
          from: peer.participantId,
          fromRole: peer.role,
        })
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimer)
      if (!peer) return
      const roomPeers = peersFor(peer.roomId)
      roomPeers.delete(peer.participantId)
      if (roomPeers.size === 0) rooms.delete(peer.roomId)
      markDisconnected(peer)
      revokeAccess(peer)
      for (const other of roomPeers.values()) {
        safeSend(other.ws, { type: 'peer-left', participantId: peer.participantId })
      }
    })
  })

  return wss
}
