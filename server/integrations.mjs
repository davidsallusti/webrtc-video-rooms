import express from 'express'
import {
  authenticateIntegrationClient,
  integrationCreateRoom,
  recordAuditEvent,
  requireIntegrationScope,
} from './store.mjs'
import { createRateLimiter, readLimit } from './rate-limit.mjs'

const authLimiter = createRateLimiter({
  limit: readLimit('WEBRTC_INTEGRATION_AUTH_LIMIT', 20),
  windowMs: readLimit('WEBRTC_INTEGRATION_AUTH_WINDOW_MS', 60_000),
  message: 'Too many integration authentication attempts. Try again shortly.',
})

function bearerToken(req) {
  const [scheme, token] = String(req.get('authorization') || '').split(/\s+/, 2)
  return scheme?.toLowerCase() === 'bearer' ? token : ''
}

function requestOrigin(req) {
  return req.get('origin') || ''
}

function requireIntegration(clientIp) {
  return (req, res, next) => {
    try {
      const token = bearerToken(req)
      if (!token) {
        authLimiter.check(`missing:${clientIp(req)}`)
        res.status(401).json({ error: 'invalid_integration_credentials', message: 'Invalid integration credentials.' })
        return
      }
      const client = authenticateIntegrationClient({ apiKey: token, origin: requestOrigin(req) })
      req.integration = { client }
      next()
    } catch (error) {
      if (error.status === 401) authLimiter.check(`invalid:${clientIp(req)}`)
      recordAuditEvent({
        actorType: 'integration',
        action: 'integration.auth_failed',
        resourceType: 'integration_client',
        ip: clientIp(req),
        userAgent: req.get('user-agent'),
        metadata: { code: error.code || 'integration_auth_failed' },
      })
      next(error)
    }
  }
}

export function createIntegrationRouter({ clientIp }) {
  const router = express.Router()
  router.use(express.json({ limit: '32kb' }))
  router.use(requireIntegration(clientIp))

  router.get('/session', (req, res) => {
    res.json({ client: req.integration.client })
  })

  router.post('/rooms', (req, res, next) => {
    try {
      requireIntegrationScope(req.integration.client, 'rooms:create')
      const result = integrationCreateRoom({
        client: req.integration.client,
        displayName: req.body?.displayName,
        password: req.body?.password,
        metadata: req.body?.metadata,
        externalLink: req.body?.externalLink,
        externalIdentity: req.body?.externalIdentity,
        origin: '',
        ip: clientIp(req),
        userAgent: req.get('user-agent'),
      })
      res.status(201).json(result)
    } catch (error) {
      next(error)
    }
  })

  return router
}
