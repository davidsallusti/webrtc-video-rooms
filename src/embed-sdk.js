export const EMBED_MESSAGE_VERSION = 1
export const EMBED_MAX_MESSAGE_BYTES = 4096

const parentToFrameTypes = new Set([
  'webrtc.embed.init',
  'webrtc.embed.join',
  'webrtc.embed.leave',
  'webrtc.embed.setDisplayName',
  'webrtc.embed.setTheme',
])

const frameToParentTypes = new Set([
  'webrtc.embed.ready',
  'webrtc.embed.joined',
  'webrtc.embed.left',
  'webrtc.embed.error',
  'webrtc.embed.roomStatus',
  'webrtc.embed.heightChanged',
])

function serializedSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

function boundedString(value, max = 160) {
  return typeof value === 'string' && value.length <= max
}

function emptyPayload(payload) {
  return Object.keys(payload).length === 0
}

function safeMessageString(value, max = 160) {
  if (!boundedString(value, max)) return false
  return !/(<\s*script|<\s*iframe|javascript:|on\w+\s*=)/i.test(value)
}

function hasOnlyKeys(payload, keys) {
  return Object.keys(payload).every((key) => keys.includes(key))
}

function payloadIsValid(type, payload) {
  if (Object.keys(payload).some((key) => /token|secret|cookie|hash|credential/i.test(key))) return false
  switch (type) {
    case 'webrtc.embed.init':
    case 'webrtc.embed.setTheme':
      return hasOnlyKeys(payload, ['theme']) && ['system', 'light', 'dark'].includes(payload.theme)
    case 'webrtc.embed.join':
    case 'webrtc.embed.setDisplayName':
      return hasOnlyKeys(payload, ['displayName']) && safeMessageString(payload.displayName, 80)
    case 'webrtc.embed.leave':
    case 'webrtc.embed.ready':
      return emptyPayload(payload)
    case 'webrtc.embed.joined':
      return hasOnlyKeys(payload, ['participantId', 'status'])
        && safeMessageString(payload.participantId, 120)
        && ['waiting', 'admitted'].includes(payload.status)
    case 'webrtc.embed.left':
      return hasOnlyKeys(payload, ['reason'])
        && ['left', 'room_ended', 'access_revoked'].includes(payload.reason)
    case 'webrtc.embed.error':
      return hasOnlyKeys(payload, ['code', 'message'])
        && safeMessageString(payload.code, 80)
        && (payload.message === undefined || safeMessageString(payload.message, 160))
    case 'webrtc.embed.roomStatus':
      return hasOnlyKeys(payload, ['displayName', 'status', 'waitingRoomEnabled'])
        && safeMessageString(payload.displayName, 160)
        && ['active', 'locked', 'expired', 'disabled', 'ended'].includes(payload.status)
        && typeof payload.waitingRoomEnabled === 'boolean'
    case 'webrtc.embed.heightChanged':
      return hasOnlyKeys(payload, ['height'])
        && Number.isInteger(payload.height)
        && payload.height >= 0
        && payload.height <= 4000
    default:
      return false
  }
}

export function validateEmbedMessage(message, {
  allowedOrigin,
  eventOrigin,
  expectedSource,
  eventSource,
  roomId,
  sessionId,
  direction = 'parent-to-frame',
} = {}) {
  if (eventOrigin !== allowedOrigin) return { ok: false, error: 'invalid_origin' }
  if (expectedSource && eventSource !== expectedSource) return { ok: false, error: 'invalid_source' }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { ok: false, error: 'invalid_schema' }
  if (serializedSize(message) > EMBED_MAX_MESSAGE_BYTES) return { ok: false, error: 'message_too_large' }
  const types = direction === 'frame-to-parent' ? frameToParentTypes : parentToFrameTypes
  if (!types.has(message.type)) return { ok: false, error: 'invalid_type' }
  if (message.version !== EMBED_MESSAGE_VERSION) return { ok: false, error: 'invalid_version' }
  if (message.roomId !== roomId || message.sessionId !== sessionId) return { ok: false, error: 'invalid_binding' }
  if (message.requestId !== undefined && !boundedString(message.requestId, 80)) return { ok: false, error: 'invalid_request_id' }
  if (message.payload !== undefined && (typeof message.payload !== 'object' || Array.isArray(message.payload))) {
    return { ok: false, error: 'invalid_payload' }
  }
  const payload = message.payload || {}
  if (!payloadIsValid(message.type, payload)) return { ok: false, error: 'invalid_payload' }
  return { ok: true, message }
}

export function createEmbedMessage({ type, roomId, sessionId, requestId, payload = {} }) {
  return {
    type,
    version: EMBED_MESSAGE_VERSION,
    requestId,
    roomId,
    sessionId,
    payload,
  }
}

export function postEmbedMessage(targetWindow, message, targetOrigin) {
  if (!targetOrigin || targetOrigin === '*') throw new Error('Embed targetOrigin must be exact.')
  targetWindow.postMessage(message, targetOrigin)
}

export function createWebRtcEmbedFrame({ roomId, src, title = 'WebRTC room embed' }) {
  const iframe = document.createElement('iframe')
  iframe.src = src || `/embed/rooms/${encodeURIComponent(roomId)}`
  iframe.title = title
  iframe.referrerPolicy = 'no-referrer'
  iframe.allow = 'camera; microphone'
  iframe.dataset.webrtcEmbed = 'local'
  return iframe
}
