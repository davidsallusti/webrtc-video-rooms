import express from 'express'
import {
  embedRoomAccess,
  embedRoomStatus,
  exchangeEmbedSession,
  recordAuditEvent,
} from './store.mjs'

function originFromHeader(req) {
  return req.get('origin') || ''
}

function embedHeaders(req) {
  return {
    sessionId: req.get('x-embed-session-id'),
    sessionToken: req.get('x-embed-session-token'),
    origin: originFromHeader(req),
  }
}

export function createEmbedRouter({ clientIp, activeParticipantCount }) {
  const router = express.Router()

  router.post('/sessions/exchange', (req, res) => {
    if (req.body?.bootstrapToken) {
      res.status(401).json({ error: 'invalid_embed_session', message: 'Embed bootstrap credentials must be sent in headers.' })
      return
    }
    const bootstrapToken = req.get('x-embed-bootstrap-token')
    if (!bootstrapToken) {
      res.status(401).json({ error: 'invalid_embed_session', message: 'Embed session is invalid or expired.' })
      return
    }
    const result = exchangeEmbedSession({
      bootstrapToken,
      origin: originFromHeader(req),
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json(result)
  })

  router.get('/rooms/:roomId/status', (req, res) => {
    if (req.query.sessionId || req.query.sessionToken) {
      res.status(401).json({ error: 'invalid_embed_session', message: 'Embed session is invalid or expired.' })
      return
    }
    res.json(embedRoomStatus({
      roomId: req.params.roomId,
      ...embedHeaders(req),
    }))
  })

  router.post('/rooms/:roomId/access', (req, res) => {
    if (req.query.sessionId || req.query.sessionToken || req.body?.sessionId || req.body?.sessionToken) {
      res.status(401).json({ error: 'invalid_embed_session', message: 'Embed session credentials must be sent in headers.' })
      return
    }
    const result = embedRoomAccess({
      roomId: req.params.roomId,
      ...embedHeaders(req),
      password: req.body?.password,
      activeCount: activeParticipantCount(req.params.roomId),
      ip: clientIp(req),
    })
    res.json(result)
  })

  router.use((req, res) => {
    recordAuditEvent({
      actorType: 'embed',
      action: 'embed.route_denied',
      resourceType: 'embed_session',
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      metadata: { path: req.path.slice(0, 120) },
    })
    res.status(404).json({ error: 'not_found', message: 'Not found' })
  })

  return router
}
