import express from 'express'
import { randomBytes } from 'node:crypto'
import swaggerUiDist from 'swagger-ui-dist'
import { openApiSpec } from './openapi.mjs'
import {
  authenticateAccess,
  admissionStatus as roomAdmissionStatus,
  adminCreateRoom,
  adminRoomEmbed,
  adminRecordingSettings,
  adminTranscriptSettings,
  appendMockTranscriptSegment,
  adminRoomChat,
  configureRoomChatRetention,
  configureRoomEmbedSettings,
  configureRecordingSettings,
  configureTranscriptSettings,
  createAdminUser,
  createParticipantChatMessage,
  db,
  decideWaitingParticipant,
  findRoomInvitee,
  listAdminUsers,
  listRoomInvitees,
  deleteRoomChatMessage,
  deleteRecordingArtifact,
  deleteTranscriptArtifact,
  deleteTranscriptSegment,
  endRoomForAll,
  exportRoomChat,
  exportRoomTranscript,
  failMockRecording,
  finalizeMockRecording,
  createIntegrationClient,
  finalizeMockTranscript,
  getRoomRecording,
  getRoomTranscript,
  hashAuditValue,
  hashForStorage,
  issueEmbedSession,
  lifecycleEventsForRoom,
  listAllRecordings,
  listAllTranscripts,
  listIntegrationOverview,
  listRoomRecordings,
  listRoomTranscripts,
  listWaitingParticipants,
  participantLiveCaptions,
  participantChat,
  participantRecordingStatus,
  participantTranscriptStatus,
  recordAuditEvent,
  recordParticipantRecordingConsent,
  recordingStorageCoordinates,
  redactRoomChatMessage,
  redactTranscriptSegment,
  recordParticipantTranscriptConsent,
  revokeEmbedSession,
  revokeIntegrationClient,
  startMockRecording,
  startMockTranscript,
  tokenHash,
  transitionRoomLifecycle,
  updateRoomInterviewConfig,
  updateRoomPolicy,
  verifyStoredHash,
} from './store.mjs'
import { retryTranscription, startRecording, stopRecording } from './recordings.mjs'
import { emailStatus, listRoomEmails, sendAdminWelcome, sendRoomInvitations } from './email.mjs'
import { openRecordingMedia } from './storage.mjs'
import { createRateLimiter, readLimit } from './rate-limit.mjs'

const SESSION_COOKIE = 'webrtc_admin_session'
const SESSION_COOKIE_PATH = '/api/admin'
const LOCAL_BOOTSTRAP_EMAIL = 'admin@webrtc.local'
const LOCAL_BOOTSTRAP_PASSWORD = 'ChangeMe-Admin-0086!'
const sessionTtlMs = readLimit('WEBRTC_ADMIN_SESSION_TTL_MS', 8 * 60 * 60 * 1000)
const idleTtlMs = readLimit('WEBRTC_ADMIN_IDLE_TTL_MS', 45 * 60 * 1000)
const loginLimiter = createRateLimiter({
  limit: readLimit('WEBRTC_ADMIN_LOGIN_LIMIT', 8),
  windowMs: readLimit('WEBRTC_ADMIN_LOGIN_WINDOW_MS', 60_000),
  message: 'Too many admin login attempts. Try again shortly.',
})

const permissions = [
  ['rooms:create', 'Create rooms from the admin console'],
  ['rooms:view_all', 'View every room and room metadata'],
  ['rooms:disable', 'Disable rooms'],
  ['rooms:expire', 'Expire rooms immediately'],
  ['rooms:extend', 'Extend room expiry'],
  ['rooms:lock', 'Lock rooms against new joins'],
  ['rooms:unlock', 'Unlock rooms'],
  ['rooms:end_any', 'End any room for all participants'],
  ['rooms:end_own', 'End rooms owned by the actor'],
  ['rooms:update_metadata', 'Update room metadata'],
  ['rooms:update_policy', 'Update local room policies'],
  ['rooms:view_lifecycle', 'View room lifecycle history'],
  ['waiting_room:configure', 'Configure waiting-room policy'],
  ['waiting_room:view', 'View waiting-room participants'],
  ['waiting_room:admit', 'Admit waiting participants'],
  ['waiting_room:reject', 'Reject waiting participants'],
  ['participants:remove', 'Remove participants from rooms'],
  ['audit:view', 'View audit events'],
  ['admin_users:manage', 'Manage admin users'],
  ['settings:update', 'Update platform settings'],
  ['integrations:view', 'View integration clients and linked records'],
  ['integrations:manage', 'Manage integration clients and origins'],
  ['chat:view', 'View retained room chat'],
  ['chat:export', 'Export retained room chat'],
  ['chat:redact', 'Redact retained chat messages'],
  ['chat:delete', 'Delete retained chat messages'],
  ['chat:configure_retention', 'Configure retained chat policy'],
  ['transcripts:configure', 'Configure local mock transcripts'],
  ['transcripts:manage_mock', 'Manage local mock transcript sessions'],
  ['transcripts:view', 'View local mock transcript bodies'],
  ['transcripts:export', 'Export local mock transcripts'],
  ['transcripts:redact', 'Redact local mock transcript segments'],
  ['transcripts:delete', 'Delete local mock transcript artifacts or segments'],
  ['recordings:configure', 'Configure local mock recording metadata'],
  ['recordings:manage_mock', 'Manage local mock recording metadata artifacts'],
  ['recordings:manage', 'Start and stop real room recordings'],
  ['recordings:view', 'View recording artifacts'],
  ['recordings:playback', 'Play back and download recording media'],
  ['recordings:delete', 'Delete recording artifacts'],
  ['embed:view', 'View local embed metadata'],
  ['embed:configure', 'Configure local embed origins'],
  ['embed:issue_token', 'Issue local embed sessions'],
  ['embed:revoke', 'Revoke local embed sessions'],
]

const roles = [
  ['platform_admin', 'Platform Admin', permissions.map(([key]) => key)],
  ['operator', 'Operator', [
    'rooms:create',
    'rooms:view_all',
    'rooms:disable',
    'rooms:expire',
    'rooms:extend',
    'rooms:lock',
    'rooms:unlock',
    'rooms:end_any',
    'rooms:update_metadata',
    'rooms:update_policy',
    'rooms:view_lifecycle',
    'waiting_room:configure',
    'waiting_room:view',
    'waiting_room:admit',
    'waiting_room:reject',
    'participants:remove',
    'audit:view',
    'integrations:view',
    'integrations:manage',
    'chat:view',
    'chat:configure_retention',
    'transcripts:configure',
    'transcripts:manage_mock',
    'transcripts:view',
    'recordings:manage',
    'recordings:view',
    'embed:view',
  ]],
  ['support_reviewer', 'Support Reviewer', ['rooms:view_all', 'audit:view']],
  ['auditor', 'Auditor', ['audit:view']],
]

function nowIso() {
  return new Date().toISOString()
}

function futureIso(ms) {
  return new Date(Date.now() + ms).toISOString()
}

function randomId(bytes = 12) {
  return randomBytes(bytes).toString('base64url')
}

// Origin used in outgoing email links: explicit public origin in production,
// the request's own origin otherwise (dev).
function emailOrigin(req) {
  if (process.env.WEBRTC_PUBLIC_ORIGIN) return process.env.WEBRTC_PUBLIC_ORIGIN
  return `${req.protocol}://${req.get('host') || ''}`
}

function genericAuthError() {
  const error = new Error('Invalid admin credentials.')
  error.code = 'invalid_admin_credentials'
  error.status = 401
  return error
}

function parseCookies(header) {
  const cookies = {}
  for (const chunk of String(header || '').split(';')) {
    const [name, ...rest] = chunk.trim().split('=')
    if (!name || !rest.length) continue
    cookies[name] = decodeURIComponent(rest.join('='))
  }
  return cookies
}

function cookieOptions({ clear = false, isProduction }) {
  return [
    `${SESSION_COOKIE}=${clear ? '' : '%TOKEN%'}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${SESSION_COOKIE_PATH}`,
    isProduction ? 'Secure' : '',
    clear ? 'Max-Age=0' : `Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
  ].filter(Boolean)
}

function setSessionCookie(res, token, isProduction) {
  res.setHeader('Set-Cookie', cookieOptions({ isProduction }).join('; ').replace('%TOKEN%', encodeURIComponent(token)))
}

function clearSessionCookie(res, isProduction) {
  res.setHeader('Set-Cookie', cookieOptions({ clear: true, isProduction }).join('; '))
}

function bootstrapConfig(isProduction) {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL || (!isProduction ? LOCAL_BOOTSTRAP_EMAIL : '')
  const plainPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD || (!isProduction ? LOCAL_BOOTSTRAP_PASSWORD : '')
  const passwordHash = process.env.ADMIN_BOOTSTRAP_PASSWORD_HASH || ''
  if (!email || (!plainPassword && !passwordHash)) {
    return {
      available: false,
      email: '',
      reason: 'Admin bootstrap requires ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD or ADMIN_BOOTSTRAP_PASSWORD_HASH.',
    }
  }
  if (isProduction && plainPassword === LOCAL_BOOTSTRAP_PASSWORD) {
    return {
      available: false,
      email,
      reason: 'The local default admin password is refused in production.',
    }
  }
  return {
    available: true,
    email: String(email).trim().toLowerCase(),
    passwordHash: passwordHash || hashForStorage(plainPassword),
  }
}

function seedRbac() {
  for (const [key, description] of permissions) {
    db.prepare(`
      insert into permissions (id, key, description)
      values (?, ?, ?)
      on conflict(key) do update set description = excluded.description
    `).run(`perm_${key.replace(/[^a-z0-9]+/g, '_')}`, key, description)
  }
  for (const [key, name, rolePermissions] of roles) {
    const roleId = `role_${key}`
    db.prepare(`
      insert into roles (id, key, name)
      values (?, ?, ?)
      on conflict(key) do update set name = excluded.name
    `).run(roleId, key, name)
    for (const permissionKey of rolePermissions) {
      const permission = db.prepare('select id from permissions where key = ?').get(permissionKey)
      if (permission) {
        db.prepare(`
          insert into role_permissions (role_id, permission_id)
          values (?, ?)
          on conflict(role_id, permission_id) do nothing
        `).run(roleId, permission.id)
      }
    }
  }
}

function adminCount() {
  return db.prepare('select count(*) as count from admin_users').get().count
}

function ensureBootstrapAdmin({ isProduction, ip, userAgent }) {
  seedRbac()
  if (adminCount() > 0) return { available: true }
  const config = bootstrapConfig(isProduction)
  if (!config.available) {
    recordAuditEvent({
      actorType: 'system',
      action: 'admin.bootstrap_unavailable',
      resourceType: 'admin_user',
      ip,
      userAgent,
      metadata: { reason: config.reason },
    })
    return config
  }
  const adminId = randomId()
  db.prepare(`
    insert into admin_users (id, email, password_hash, display_name, status, requires_password_change, created_at)
    values (?, ?, ?, ?, 'bootstrap_required', 1, ?)
  `).run(adminId, config.email, config.passwordHash, 'Bootstrap Admin', nowIso())
  const role = db.prepare('select id from roles where key = ?').get('platform_admin')
  db.prepare('insert into admin_user_roles (admin_user_id, role_id) values (?, ?)').run(adminId, role.id)
  recordAuditEvent({
    actorType: 'system',
    action: 'admin.bootstrap_initialized',
    resourceType: 'admin_user',
    resourceId: adminId,
    ip,
    userAgent,
    metadata: { email: config.email, production: isProduction },
  })
  return { available: true }
}

function adminUserByEmail(email) {
  return db.prepare('select * from admin_users where lower(email) = lower(?)').get(String(email || '').trim())
}

function permissionsForAdmin(adminUserId) {
  return db.prepare(`
    select distinct permissions.key
    from permissions
    join role_permissions on role_permissions.permission_id = permissions.id
    join admin_user_roles on admin_user_roles.role_id = role_permissions.role_id
    where admin_user_roles.admin_user_id = ?
    order by permissions.key
  `).all(adminUserId).map((row) => row.key)
}

function rolesForAdmin(adminUserId) {
  return db.prepare(`
    select roles.key, roles.name
    from roles
    join admin_user_roles on admin_user_roles.role_id = roles.id
    where admin_user_roles.admin_user_id = ?
    order by roles.key
  `).all(adminUserId)
}

function publicAdminUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    status: user.status,
    setupRequired: Boolean(user.requires_password_change),
    roles: rolesForAdmin(user.id),
    permissions: permissionsForAdmin(user.id),
  }
}

function createSession({ user, req, res, isProduction }) {
  const sessionId = randomId(14)
  const token = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(32).toString('base64url')
  const ts = nowIso()
  db.prepare(`
    insert into admin_sessions (
      id, admin_user_id, session_hash, csrf_hash, created_at, last_seen_at,
      expires_at, ip_hash, user_agent_hash
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    user.id,
    tokenHash(token),
    tokenHash(csrfToken),
    ts,
    ts,
    futureIso(sessionTtlMs),
    hashAuditValue(req.ip || req.socket.remoteAddress),
    hashAuditValue(req.get('user-agent')),
  )
  setSessionCookie(res, token, isProduction)
  return { csrfToken, sessionId }
}

function rotateCsrf(sessionId) {
  const csrfToken = randomBytes(32).toString('base64url')
  db.prepare('update admin_sessions set csrf_hash = ?, last_seen_at = ? where id = ?').run(tokenHash(csrfToken), nowIso(), sessionId)
  return csrfToken
}

function revokeSession(sessionId) {
  db.prepare('update admin_sessions set revoked_at = ? where id = ? and revoked_at is null').run(nowIso(), sessionId)
}

function authContext(req) {
  const token = parseCookies(req.get('cookie'))[SESSION_COOKIE]
  if (!token) return null
  const row = db.prepare(`
    select admin_sessions.*, admin_users.email, admin_users.display_name, admin_users.status, admin_users.requires_password_change
    from admin_sessions
    join admin_users on admin_users.id = admin_sessions.admin_user_id
    where admin_sessions.session_hash = ?
  `).get(tokenHash(token))
  if (!row || row.revoked_at || row.status === 'disabled') return null
  if (Date.parse(row.expires_at) <= Date.now()) return null
  if (Date.now() - Date.parse(row.last_seen_at) > idleTtlMs) {
    revokeSession(row.id)
    return null
  }
  db.prepare('update admin_sessions set last_seen_at = ? where id = ?').run(nowIso(), row.id)
  return {
    session: row,
    user: {
      id: row.admin_user_id,
      email: row.email,
      display_name: row.display_name,
      status: row.status,
      requires_password_change: row.requires_password_change,
    },
    permissions: new Set(permissionsForAdmin(row.admin_user_id)),
  }
}

function requireAdmin(permission) {
  return (req, res, next) => {
    const context = authContext(req)
    if (!context) {
      res.status(401).json({ error: 'admin_auth_required', message: 'Admin login required.' })
      return
    }
    req.admin = context
    if (context.user.requires_password_change && req.path !== '/setup/password' && req.path !== '/logout') {
      res.status(403).json({ error: 'admin_setup_required', message: 'Admin password rotation is required first.' })
      return
    }
    if (permission && !context.permissions.has(permission)) {
      recordAuditEvent({
        actorType: 'admin',
        actorId: context.user.id,
        action: 'admin.permission_denied',
        resourceType: 'admin_route',
        resourceId: permission,
        ip: req.ip || req.socket.remoteAddress,
        userAgent: req.get('user-agent'),
      })
      res.status(403).json({ error: 'permission_denied', message: 'Permission denied.' })
      return
    }
    next()
  }
}

function requireCsrf(req, res, next) {
  const token = req.get('x-csrf-token') || ''
  if (!req.admin?.session?.csrf_hash || tokenHash(token) !== req.admin.session.csrf_hash) {
    recordAuditEvent({
      actorType: 'admin',
      actorId: req.admin?.user?.id,
      action: 'admin.csrf_denied',
      resourceType: 'admin_route',
      resourceId: req.path,
      ip: req.ip || req.socket.remoteAddress,
      userAgent: req.get('user-agent'),
    })
    res.status(403).json({ error: 'csrf_required', message: 'Admin CSRF check failed.' })
    return
  }
  next()
}

function roomSummary(row) {
  const metadata = JSON.parse(row.metadata_json || '{}')
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    disabledAt: row.disabled_at,
    lockedAt: row.locked_at,
    lastLifecycleReason: row.last_lifecycle_reason,
    maxParticipants: row.max_participants,
    waitingRoomEnabled: Boolean(row.waiting_room_enabled),
    autoAdmitFirstGuest: Boolean(row.auto_admit_first_guest),
    chatRetentionPending: Boolean(row.chat_retention_pending),
    transcriptPending: Boolean(row.transcript_pending),
    recordingPending: Boolean(row.recording_pending),
    scheduledStartAt: row.scheduled_start_at,
    scheduledEndAt: row.scheduled_end_at,
    joinWindowMinutes: row.join_window_minutes,
    candidateId: row.candidate_id,
    recruiterId: row.recruiter_id,
    livekitRoomName: row.livekit_room_name,
    metadata,
    presenceCount: row.presence_count || 0,
  }
}

function boundedLimit(value) {
  const next = Number(value || 50)
  if (!Number.isFinite(next)) return 50
  return Math.max(1, Math.min(100, Math.trunc(next)))
}

function boundedOffset(value) {
  const next = Number(value || 0)
  if (!Number.isFinite(next)) return 0
  return Math.max(0, Math.trunc(next))
}

function listRooms({ status, query, limit, offset } = {}) {
  const where = []
  const params = []
  if (status) {
    where.push('rooms.status = ?')
    params.push(String(status).slice(0, 32))
  }
  if (query) {
    where.push(`(
      rooms.id like ?
      or rooms.display_name like ?
      or rooms.metadata_text_index like ?
      or rooms.candidate_id like ?
      or rooms.recruiter_id like ?
    )`)
    const like = `%${String(query).slice(0, 80).replaceAll('%', '').replaceAll('_', '')}%`
    params.push(like, like, like, like, like)
  }
  const whereSql = where.length ? `where ${where.join(' and ')}` : ''
  const pageLimit = boundedLimit(limit)
  const pageOffset = boundedOffset(offset)
  return db.prepare(`
    select rooms.*, count(room_presence.participant_id) as presence_count
    from rooms
    left join room_presence on room_presence.room_id = rooms.id and room_presence.disconnected_at is null
    ${whereSql}
    group by rooms.id
    order by rooms.created_at desc
    limit ? offset ?
  `).all(...params, pageLimit, pageOffset).map(roomSummary)
}

function roomDetail(roomId, { includeLifecycle = false, includeWaiting = false, includeIntegrations = false } = {}) {
  const room = db.prepare(`
    select rooms.*, count(room_presence.participant_id) as presence_count
    from rooms
    left join room_presence on room_presence.room_id = rooms.id and room_presence.disconnected_at is null
    where rooms.id = ?
    group by rooms.id
  `).get(roomId)
  if (!room) return null
  return {
    ...roomSummary(room),
    participants: db.prepare(`
      select participant_id as participantId, role, connected_at as connectedAt,
        last_seen_at as lastSeenAt, disconnected_at as disconnectedAt
      from room_presence
      where room_id = ?
      order by connected_at desc
    `).all(roomId),
    invitees: db.prepare(`
      select email, display_name as displayName, invitee_role as inviteeRole
      from room_invitees
      where room_id = ?
      order by created_at asc
    `).all(roomId),
    ...(includeWaiting ? { waitingParticipants: db.prepare(`
      select participant_id as participantId, role, admission_status as admissionStatus,
        issued_at as issuedAt, admission_decided_at as admissionDecidedAt
      from room_access_tokens
      where room_id = ? and role = 'guest' and admission_status = 'waiting' and revoked_at is null
      order by issued_at asc
    `).all(roomId) } : {}),
    ...(includeIntegrations ? { externalLinks: db.prepare(`
      select id, room_id as roomId, system_key as systemKey, object_type as objectType,
        object_id as objectId, external_identity_id as externalIdentityId,
        metadata_json as metadataJson, created_at as createdAt
      from room_external_links
      where room_id = ?
      order by created_at desc
    `).all(roomId).map((link) => ({
      ...link,
      metadata: JSON.parse(link.metadataJson || '{}'),
      metadataJson: undefined,
    })) } : {}),
    metadataRows: db.prepare(`
      select key, value_json as valueJson, value_text_index as valueTextIndex, updated_at as updatedAt
      from room_metadata
      where room_id = ?
      order by key
    `).all(roomId),
    lifecycle: includeLifecycle ? lifecycleEventsForRoom(roomId) : [],
  }
}

function recentAudit(roomId = null) {
  const rows = roomId
    ? db.prepare(`
      select actor_type as actorType, actor_id as actorId, action, resource_type as resourceType,
        resource_id as resourceId, room_id as roomId, metadata_json as metadataJson, created_at as createdAt
      from audit_events
      where room_id = ?
      order by created_at desc
      limit 40
    `).all(roomId)
    : db.prepare(`
      select actor_type as actorType, actor_id as actorId, action, resource_type as resourceType,
        resource_id as resourceId, room_id as roomId, metadata_json as metadataJson, created_at as createdAt
      from audit_events
      order by created_at desc
      limit 40
    `).all()
  return rows.map((row) => ({ ...row, metadata: JSON.parse(row.metadataJson || '{}'), metadataJson: undefined }))
}

export function createAdminRouter({ isProduction, clientIp, onRoomEnded }) {
  const router = express.Router()
  router.use(express.json({ limit: '32kb' }))

  router.get('/bootstrap/status', (req, res) => {
    seedRbac()
    const hasAdmins = adminCount() > 0
    const config = bootstrapConfig(isProduction)
    res.json({
      hasAdmins,
      bootstrapRequired: !hasAdmins,
      bootstrapAvailable: hasAdmins || config.available,
      bootstrapEmail: hasAdmins || isProduction ? '' : config.email,
      setupMode: !hasAdmins ? 'bootstrap' : 'login',
      production: isProduction,
      reason: !hasAdmins && !config.available ? config.reason : '',
    })
  })

  router.post('/bootstrap/login', (req, res) => {
    loginLimiter.check(`bootstrap:${clientIp(req)}`)
    const ensured = ensureBootstrapAdmin({ isProduction, ip: clientIp(req), userAgent: req.get('user-agent') })
    if (!ensured.available) {
      res.status(409).json({ error: 'bootstrap_unavailable', message: ensured.reason })
      return
    }
    const user = adminUserByEmail(req.body?.email)
    if (!user || user.status !== 'bootstrap_required' || !verifyStoredHash(req.body?.password, user.password_hash)) {
      recordAuditEvent({
        actorType: 'system',
        action: 'admin.bootstrap_login_failed',
        resourceType: 'admin_user',
        ip: clientIp(req),
        userAgent: req.get('user-agent'),
      })
      throw genericAuthError()
    }
    db.prepare('update admin_users set last_login_at = ? where id = ?').run(nowIso(), user.id)
    const session = createSession({ user, req, res, isProduction })
    recordAuditEvent({
      actorType: 'admin',
      actorId: user.id,
      action: 'admin.bootstrap_login_succeeded',
      resourceType: 'admin_user',
      resourceId: user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ user: publicAdminUser(user), csrfToken: session.csrfToken })
  })

  router.post('/login', (req, res) => {
    loginLimiter.check(`login:${clientIp(req)}`)
    seedRbac()
    const user = adminUserByEmail(req.body?.email)
    if (!user || user.status !== 'active' || !verifyStoredHash(req.body?.password, user.password_hash)) {
      recordAuditEvent({
        actorType: 'system',
        action: 'admin.login_failed',
        resourceType: 'admin_user',
        ip: clientIp(req),
        userAgent: req.get('user-agent'),
      })
      throw genericAuthError()
    }
    db.prepare('update admin_users set last_login_at = ? where id = ?').run(nowIso(), user.id)
    const session = createSession({ user, req, res, isProduction })
    recordAuditEvent({
      actorType: 'admin',
      actorId: user.id,
      action: 'admin.login_succeeded',
      resourceType: 'admin_user',
      resourceId: user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ user: publicAdminUser(user), csrfToken: session.csrfToken })
  })

  router.get('/session', (req, res) => {
    const context = authContext(req)
    if (!context) {
      res.json({ user: null, csrfToken: '' })
      return
    }
    res.json({ user: publicAdminUser(context.user), csrfToken: rotateCsrf(context.session.id) })
  })

  router.post('/setup/password', requireAdmin(), requireCsrf, (req, res) => {
    const nextPassword = String(req.body?.newPassword || '')
    if (nextPassword.length < 12 || nextPassword === LOCAL_BOOTSTRAP_PASSWORD) {
      res.status(400).json({ error: 'weak_admin_password', message: 'Choose a new admin password with at least 12 characters.' })
      return
    }
    const ts = nowIso()
    db.prepare(`
      update admin_users
      set password_hash = ?, status = 'active', requires_password_change = 0,
        password_changed_at = ?, bootstrap_consumed_at = ?
      where id = ?
    `).run(hashForStorage(nextPassword), ts, ts, req.admin.user.id)
    revokeSession(req.admin.session.id)
    const user = db.prepare('select * from admin_users where id = ?').get(req.admin.user.id)
    const session = createSession({ user, req, res, isProduction })
    recordAuditEvent({
      actorType: 'admin',
      actorId: user.id,
      action: 'admin.bootstrap_consumed',
      resourceType: 'admin_user',
      resourceId: user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ user: publicAdminUser(user), csrfToken: session.csrfToken })
  })

  router.post('/logout', requireAdmin(), requireCsrf, (req, res) => {
    revokeSession(req.admin.session.id)
    clearSessionCookie(res, isProduction)
    recordAuditEvent({
      actorType: 'admin',
      actorId: req.admin.user.id,
      action: 'admin.logout',
      resourceType: 'admin_session',
      resourceId: req.admin.session.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ ok: true })
  })

  router.get('/rooms', requireAdmin('rooms:view_all'), (req, res) => {
    recordAuditEvent({
      actorType: 'admin',
      actorId: req.admin.user.id,
      action: 'rooms.view_all',
      resourceType: 'room',
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      metadata: {
        status: req.query.status ? String(req.query.status).slice(0, 32) : '',
        hasQuery: Boolean(req.query.q),
        limit: boundedLimit(req.query.limit),
        offset: boundedOffset(req.query.offset),
      },
    })
    res.json({
      rooms: listRooms({
        status: req.query.status,
        query: req.query.q,
        limit: req.query.limit,
        offset: req.query.offset,
      }),
    })
  })

  router.post('/rooms', requireAdmin('rooms:create'), requireCsrf, (req, res) => {
    const { displayName, password, metadata, schedule, invitees, candidateId, recruiterId, maxParticipants } = req.body || {}
    const result = adminCreateRoom({
      displayName,
      password,
      metadata,
      schedule,
      invitees,
      candidateId,
      recruiterId,
      maxParticipants,
      origin: '',
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    // Invitation emails go out at creation time — the only moment the room
    // password exists in plaintext to include.
    if (result.room.invitees?.length) {
      sendRoomInvitations({ room: result.room, invitees: result.room.invitees, origin: emailOrigin(req), password })
    }
    res.status(201).json(result)
  })

  router.patch('/rooms/:roomId/interview-config', requireAdmin('rooms:update_policy'), requireCsrf, (req, res) => {
    const { schedule, invitees, candidateId, recruiterId, maxParticipants } = req.body || {}
    const priorEmails = new Set(listRoomInvitees(req.params.roomId).map((invitee) => invitee.email))
    const room = updateRoomInterviewConfig({
      roomId: req.params.roomId,
      schedule,
      invitees,
      candidateId,
      recruiterId,
      maxParticipants,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    // Only newly added invitees get an email (no password — it is not stored).
    const added = (room.invitees || []).filter((invitee) => !priorEmails.has(invitee.email))
    if (added.length) sendRoomInvitations({ room, invitees: added, origin: emailOrigin(req) })
    res.json({ room })
  })

  router.post('/rooms/:roomId/invitees/:inviteeEmail/resend-invite', requireAdmin('rooms:update_policy'), requireCsrf, (req, res) => {
    const invitee = findRoomInvitee(req.params.roomId, req.params.inviteeEmail)
    if (!invitee) {
      res.status(404).json({ error: 'invitee_not_found', message: 'No such invitee on this room.' })
      return
    }
    const detail = roomDetail(req.params.roomId)
    sendRoomInvitations({ room: detail, invitees: [invitee], origin: emailOrigin(req) })
    recordAuditEvent({
      actorType: 'admin',
      actorId: req.admin.user.id,
      action: 'room.invite_resent',
      resourceType: 'room',
      resourceId: req.params.roomId,
      roomId: req.params.roomId,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      metadata: { inviteeEmailHash: hashAuditValue(invitee.email) },
    })
    res.status(202).json({ queued: true, email: emailStatus() })
  })

  router.get('/rooms/:roomId/emails', requireAdmin('rooms:view_all'), (req, res) => {
    res.json({ emails: listRoomEmails(req.params.roomId, req.query.limit), email: emailStatus() })
  })

  // ---- Team (admin users) ----------------------------------------------------
  router.get('/users', requireAdmin('admin_users:manage'), (_req, res) => {
    res.json({ users: listAdminUsers(), email: emailStatus() })
  })

  router.post('/users', requireAdmin('admin_users:manage'), requireCsrf, (req, res) => {
    // One-time password: emailed (ses) or handed over manually (local mode —
    // it is returned in the response exactly once for that reason).
    const temporaryPassword = `Temp-${randomId(9)}-1!`
    const user = createAdminUser({
      email: req.body?.email,
      displayName: req.body?.displayName,
      roleKeys: req.body?.roleKeys,
      temporaryPassword,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    sendAdminWelcome({ user, temporaryPassword, origin: emailOrigin(req) })
    res.status(201).json({ user, temporaryPassword, email: emailStatus() })
  })

  router.get('/rooms/:roomId', requireAdmin('rooms:view_all'), (req, res) => {
    const room = roomDetail(req.params.roomId, {
      includeLifecycle: req.admin.permissions.has('rooms:view_lifecycle'),
      includeWaiting: req.admin.permissions.has('waiting_room:view'),
      includeIntegrations: req.admin.permissions.has('integrations:view'),
    })
    if (!room) {
      res.status(404).json({ error: 'room_not_found', message: 'Room not found.' })
      return
    }
    recordAuditEvent({
      actorType: 'admin',
      actorId: req.admin.user.id,
      action: 'rooms.view_detail',
      resourceType: 'room',
      resourceId: req.params.roomId,
      roomId: req.params.roomId,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ room, audit: recentAudit(req.params.roomId) })
  })

  router.get('/rooms/:roomId/chat', requireAdmin('chat:view'), (req, res) => {
    const chat = adminRoomChat({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      limit: req.query.limit,
    })
    res.json(chat)
  })

  router.get('/rooms/:roomId/chat/export', requireAdmin('chat:export'), (req, res) => {
    const exported = exportRoomChat({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      limit: req.query.limit,
    })
    res.json(exported)
  })

  router.post('/rooms/:roomId/chat/:messageId/redact', requireAdmin('chat:redact'), requireCsrf, (req, res) => {
    const message = redactRoomChatMessage({
      roomId: req.params.roomId,
      messageId: req.params.messageId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ message })
  })

  router.post('/rooms/:roomId/chat/:messageId/delete', requireAdmin('chat:delete'), requireCsrf, (req, res) => {
    const message = deleteRoomChatMessage({
      roomId: req.params.roomId,
      messageId: req.params.messageId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ message })
  })

  router.put('/rooms/:roomId/chat-settings', requireAdmin('chat:configure_retention'), requireCsrf, (req, res) => {
    const retention = configureRoomChatRetention({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      enabled: req.body?.retentionEnabled,
      notice: req.body?.participantNotice,
      retentionDays: req.body?.retentionDays,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ retention })
  })

  router.get('/rooms/:roomId/transcript-settings', requireAdmin('transcripts:configure'), (req, res) => {
    res.json({ settings: adminTranscriptSettings({ roomId: req.params.roomId }) })
  })

  router.put('/rooms/:roomId/transcript-settings', requireAdmin('transcripts:configure'), requireCsrf, (req, res) => {
    const settings = configureTranscriptSettings({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      transcriptEnabled: req.body?.transcriptEnabled,
      liveCaptionsEnabled: req.body?.liveCaptionsEnabled,
      mockProviderEnabled: req.body?.mockProviderEnabled,
      notice: req.body?.participantNotice,
      retentionDays: req.body?.retentionDays,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ settings })
  })

  router.post('/rooms/:roomId/transcripts/mock/start', requireAdmin('transcripts:manage_mock'), requireCsrf, (req, res) => {
    const artifact = startMockTranscript({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      providerKey: req.body?.providerKey || 'mock_local',
      language: req.body?.language,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.status(201).json({ artifact })
  })

  router.post('/rooms/:roomId/transcripts/:artifactId/mock-segments', requireAdmin('transcripts:manage_mock'), requireCsrf, (req, res) => {
    const segment = appendMockTranscriptSegment({
      roomId: req.params.roomId,
      artifactId: req.params.artifactId,
      actorId: req.admin.user.id,
      participantId: req.body?.participantId,
      speakerLabel: req.body?.speakerLabel,
      text: req.body?.text,
      startMs: req.body?.startMs,
      endMs: req.body?.endMs,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.status(201).json({ segment })
  })

  router.post('/rooms/:roomId/transcripts/:artifactId/finalize', requireAdmin('transcripts:manage_mock'), requireCsrf, (req, res) => {
    const artifact = finalizeMockTranscript({
      roomId: req.params.roomId,
      artifactId: req.params.artifactId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ artifact })
  })

  router.get('/rooms/:roomId/transcripts', requireAdmin('transcripts:view'), (req, res) => {
    res.json(listRoomTranscripts({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      limit: req.query.limit,
    }))
  })

  router.get('/rooms/:roomId/transcripts/:artifactId', requireAdmin('transcripts:view'), (req, res) => {
    res.json(getRoomTranscript({
      roomId: req.params.roomId,
      artifactId: req.params.artifactId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      limit: req.query.limit,
    }))
  })

  router.get('/rooms/:roomId/transcripts/:artifactId/export', requireAdmin('transcripts:export'), (req, res) => {
    res.json(exportRoomTranscript({
      roomId: req.params.roomId,
      artifactId: req.params.artifactId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      limit: req.query.limit,
    }))
  })

  router.post('/rooms/:roomId/transcripts/:artifactId/segments/:segmentId/redact', requireAdmin('transcripts:redact'), requireCsrf, (req, res) => {
    const segment = redactTranscriptSegment({
      roomId: req.params.roomId,
      artifactId: req.params.artifactId,
      segmentId: req.params.segmentId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ segment })
  })

  router.post('/rooms/:roomId/transcripts/:artifactId/segments/:segmentId/delete', requireAdmin('transcripts:delete'), requireCsrf, (req, res) => {
    const segment = deleteTranscriptSegment({
      roomId: req.params.roomId,
      artifactId: req.params.artifactId,
      segmentId: req.params.segmentId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ segment })
  })

  router.post('/rooms/:roomId/transcripts/:artifactId/delete', requireAdmin('transcripts:delete'), requireCsrf, (req, res) => {
    res.json(deleteTranscriptArtifact({
      roomId: req.params.roomId,
      artifactId: req.params.artifactId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    }))
  })

  router.get('/rooms/:roomId/recording-settings', requireAdmin('recordings:configure'), (req, res) => {
    res.json({ settings: adminRecordingSettings({ roomId: req.params.roomId }) })
  })

  router.put('/rooms/:roomId/recording-settings', requireAdmin('recordings:configure'), requireCsrf, (req, res) => {
    const settings = configureRecordingSettings({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      recordingEnabled: req.body?.recordingEnabled,
      mockRecordingEnabled: req.body?.mockRecordingEnabled,
      notice: req.body?.participantNotice,
      retentionDays: req.body?.retentionDays,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ settings })
  })

  router.post('/rooms/:roomId/recordings/mock/start', requireAdmin('recordings:manage_mock'), requireCsrf, (req, res) => {
    const artifact = startMockRecording({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.status(201).json({ artifact })
  })

  router.post('/rooms/:roomId/recordings/:recordingId/mock-finalize', requireAdmin('recordings:manage_mock'), requireCsrf, (req, res) => {
    const artifact = finalizeMockRecording({
      roomId: req.params.roomId,
      recordingId: req.params.recordingId,
      actorId: req.admin.user.id,
      durationMs: req.body?.durationMs,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ artifact })
  })

  router.post('/rooms/:roomId/recordings/:recordingId/mock-fail', requireAdmin('recordings:manage_mock'), requireCsrf, (req, res) => {
    const artifact = failMockRecording({
      roomId: req.params.roomId,
      recordingId: req.params.recordingId,
      actorId: req.admin.user.id,
      reason: req.body?.reason,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ artifact })
  })

  // Real recordings: start/stop LiveKit egress, stream media, re-run STT.
  router.post('/rooms/:roomId/recordings/start', requireAdmin('recordings:manage'), requireCsrf, (req, res, next) => {
    startRecording({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    }).then((artifact) => res.status(201).json({ artifact })).catch(next)
  })

  router.post('/rooms/:roomId/recordings/:recordingId/stop', requireAdmin('recordings:manage'), requireCsrf, (req, res, next) => {
    stopRecording({
      roomId: req.params.roomId,
      recordingId: req.params.recordingId,
    }).then((result) => res.json(result)).catch(next)
  })

  router.get('/rooms/:roomId/recordings/:recordingId/media', requireAdmin('recordings:playback'), (req, res, next) => {
    const coordinates = recordingStorageCoordinates(req.params.roomId, req.params.recordingId)
    if (coordinates.source !== 'livekit_egress' || coordinates.status !== 'finalized' || !coordinates.storageKey) {
      res.status(404).json({ error: 'recording_media_not_found', message: 'Recording media is not available.' })
      return
    }
    recordAuditEvent({
      actorType: 'admin',
      actorId: req.admin.user.id,
      action: 'recording.media_accessed',
      resourceType: 'recording_artifact',
      resourceId: req.params.recordingId,
      roomId: req.params.roomId,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    openRecordingMedia(coordinates.storageKey).then((media) => {
      if (media.redirectUrl) {
        res.redirect(302, media.redirectUrl)
        return
      }
      res.setHeader('Content-Type', 'video/mp4')
      if (media.byteSize) res.setHeader('Content-Length', media.byteSize)
      media.stream.pipe(res)
    }).catch(next)
  })

  router.post('/rooms/:roomId/recordings/:recordingId/transcribe', requireAdmin('recordings:manage'), requireCsrf, (req, res, next) => {
    retryTranscription({
      roomId: req.params.roomId,
      recordingId: req.params.recordingId,
    }).then((artifactId) => res.status(202).json({ transcriptArtifactId: artifactId })).catch(next)
  })

  router.get('/rooms/:roomId/recordings', requireAdmin('recordings:view'), (req, res) => {
    res.json(listRoomRecordings({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      limit: req.query.limit,
    }))
  })

  router.get('/rooms/:roomId/recordings/:recordingId', requireAdmin('recordings:view'), (req, res) => {
    res.json(getRoomRecording({
      roomId: req.params.roomId,
      recordingId: req.params.recordingId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    }))
  })

  router.post('/rooms/:roomId/recordings/:recordingId/delete', requireAdmin('recordings:delete'), requireCsrf, (req, res) => {
    res.json(deleteRecordingArtifact({
      roomId: req.params.roomId,
      recordingId: req.params.recordingId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    }))
  })

  router.get('/rooms/:roomId/embed', requireAdmin('embed:view'), (req, res) => {
    res.json(adminRoomEmbed({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      limit: req.query.limit,
    }))
  })

  router.put('/rooms/:roomId/embed', requireAdmin('embed:configure'), requireCsrf, (req, res) => {
    const settings = configureRoomEmbedSettings({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      enabled: req.body?.embedEnabled,
      allowedOrigins: req.body?.allowedOrigins,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ settings })
  })

  router.post('/rooms/:roomId/embed/sessions', requireAdmin('embed:issue_token'), requireCsrf, (req, res) => {
    const result = issueEmbedSession({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      allowedOrigin: req.body?.allowedOrigin,
      scope: req.body?.scope,
      ttlMs: req.body?.ttlMs,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.status(201).json(result)
  })

  router.post('/rooms/:roomId/embed/sessions/:sessionId/revoke', requireAdmin('embed:revoke'), requireCsrf, (req, res) => {
    res.json(revokeEmbedSession({
      roomId: req.params.roomId,
      sessionId: req.params.sessionId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    }))
  })

  router.get('/integrations', requireAdmin('integrations:view'), (req, res) => {
    recordAuditEvent({
      actorType: 'admin',
      actorId: req.admin.user.id,
      action: 'integrations.view',
      resourceType: 'integration_client',
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json(listIntegrationOverview())
  })

  router.post('/integrations/clients', requireAdmin('integrations:manage'), requireCsrf, (req, res) => {
    const result = createIntegrationClient({
      name: req.body?.name,
      systemKey: req.body?.systemKey,
      permissionScope: req.body?.permissionScope,
      allowedOrigins: req.body?.allowedOrigins,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.status(201).json(result)
  })

  router.post('/integrations/clients/:clientId/revoke', requireAdmin('integrations:manage'), requireCsrf, (req, res) => {
    const client = revokeIntegrationClient({
      clientId: req.params.clientId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.json({ client })
  })

  router.post('/rooms/:roomId/end', requireAdmin('rooms:end_any'), requireCsrf, (req, res) => {
    if (req.body?.confirm !== true) {
      res.status(400).json({ error: 'confirmation_required', message: 'Confirm before ending this room.' })
      return
    }
    const room = endRoomForAll({
      roomId: req.params.roomId,
      actorType: 'admin',
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      reason: req.body?.reason,
    })
    onRoomEnded?.(req.params.roomId, { reason: 'ended_by_admin' })
    res.json({ room })
  })

  router.post('/rooms/:roomId/lifecycle/:command', (req, res, next) => {
    const permissionByCommand = {
      disable: 'rooms:disable',
      expire: 'rooms:expire',
      extend: 'rooms:extend',
      lock: 'rooms:lock',
      unlock: 'rooms:unlock',
    }
    const permission = permissionByCommand[req.params.command]
    if (!permission) {
      res.status(404).json({ error: 'not_found', message: 'Not found' })
      return
    }
    requireAdmin(permission)(req, res, () => {
      requireCsrf(req, res, () => {
        try {
          const room = transitionRoomLifecycle({
            roomId: req.params.roomId,
            command: req.params.command,
            actorType: 'admin',
            actorId: req.admin.user.id,
            ip: clientIp(req),
            userAgent: req.get('user-agent'),
            reason: req.body?.reason,
            expiresAt: req.body?.expiresAt,
          })
          if (['disable', 'expire'].includes(req.params.command)) {
            onRoomEnded?.(req.params.roomId, { reason: `room_${req.params.command}d_by_admin` })
          }
          res.json({ room })
        } catch (error) {
          next(error)
        }
      })
    })
  })

  router.patch('/rooms/:roomId/policy', requireAdmin('rooms:update_policy'), requireCsrf, (req, res) => {
    const room = updateRoomPolicy({
      roomId: req.params.roomId,
      actorId: req.admin.user.id,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      patch: req.body || {},
    })
    res.json({ room })
  })

  router.post('/rooms/:roomId/waiting/:participantId/:decision', (req, res, next) => {
    const permissionByDecision = {
      admit: 'waiting_room:admit',
      reject: 'waiting_room:reject',
      remove: 'participants:remove',
    }
    const admissionByDecision = {
      admit: 'admitted',
      reject: 'rejected',
      remove: 'removed',
    }
    const permission = permissionByDecision[req.params.decision]
    if (!permission) {
      res.status(404).json({ error: 'not_found', message: 'Not found' })
      return
    }
    requireAdmin(permission)(req, res, () => {
      requireCsrf(req, res, () => {
        try {
          const result = decideWaitingParticipant({
            roomId: req.params.roomId,
            participantId: req.params.participantId,
            decision: admissionByDecision[req.params.decision],
            actorType: 'admin',
            actorId: req.admin.user.id,
            ip: clientIp(req),
            userAgent: req.get('user-agent'),
          })
          res.json({ participant: result, waitingParticipants: listWaitingParticipants(req.params.roomId) })
        } catch (error) {
          next(error)
        }
      })
    })
  })

  // Cross-room artifact lists for the global admin pages.
  router.get('/recordings', requireAdmin('recordings:view'), (req, res) => {
    recordAuditEvent({
      actorType: 'admin',
      actorId: req.admin.user.id,
      action: 'recording.viewed',
      resourceType: 'recording_artifact',
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      metadata: { scope: 'global', limit: boundedLimit(req.query.limit) },
    })
    res.json({ recordings: listAllRecordings({ limit: req.query.limit }) })
  })

  router.get('/transcripts', requireAdmin('transcripts:view'), (req, res) => {
    recordAuditEvent({
      actorType: 'admin',
      actorId: req.admin.user.id,
      action: 'transcript.viewed',
      resourceType: 'transcript_artifact',
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      metadata: { scope: 'global', limit: boundedLimit(req.query.limit) },
    })
    res.json({ transcripts: listAllTranscripts({ limit: req.query.limit }) })
  })

  // ---- Interactive API docs (TASK-0090) ------------------------------------
  // Admin-gated Swagger UI served from the local swagger-ui-dist package (no
  // CDN — CSP allows only 'self' scripts). The stock inline initializer is
  // replaced by /docs/swagger-initializer.js below, registered BEFORE the
  // static middleware so it shadows the file inside the package.
  const swaggerInitializer = `window.onload = () => {
  window.ui = SwaggerUIBundle({
    url: '/api/admin/docs/openapi.json',
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: 'StandaloneLayout',
    docExpansion: 'none',
    tryItOutEnabled: true,
    persistAuthorization: true,
    withCredentials: true,
    displayRequestDuration: true,
  })
}
`

  router.get('/docs', requireAdmin(), (req, res, next) => {
    // Trailing slash keeps the UI's relative asset URLs working. This route
    // also matches '/docs/' (non-strict routing), so fall through to the
    // static index in that case instead of redirect-looping.
    if (req.originalUrl.split('?')[0].endsWith('/')) {
      next()
      return
    }
    res.redirect(302, '/api/admin/docs/')
  })

  router.get('/docs/openapi.json', requireAdmin(), (_req, res) => {
    res.json(openApiSpec)
  })

  router.get('/docs/swagger-initializer.js', requireAdmin(), (_req, res) => {
    res.type('application/javascript').send(swaggerInitializer)
  })

  router.use('/docs', requireAdmin(), express.static(swaggerUiDist.getAbsoluteFSPath()))

  router.get('/audit', requireAdmin('audit:view'), (req, res) => {
    recordAuditEvent({
      actorType: 'admin',
      actorId: req.admin.user.id,
      action: 'audit.view',
      resourceType: 'audit_event',
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      metadata: { scope: 'global', limit: 40 },
    })
    res.json({ audit: recentAudit() })
  })

  return router
}

export function createParticipantControlRouter({ clientIp, onRoomEnded }) {
  const router = express.Router()

  function participantHeaders(req) {
    return {
      participantId: req.get('x-participant-id') || req.body?.participantId,
      accessToken: req.get('x-room-access-token') || req.body?.accessToken,
    }
  }

  router.get('/:roomId/access-status', (req, res) => {
    const participantId = req.get('x-participant-id')
    const accessToken = req.get('x-room-access-token')
    if (!participantId || !accessToken) {
      res.status(401).json({ error: 'invalid_access', message: 'Room access expired or invalid.' })
      return
    }
    const status = roomAdmissionStatus({
      roomId: req.params.roomId,
      participantId,
      accessToken,
    })
    res.json(status)
  })

  router.get('/:roomId/chat', (req, res) => {
    const participantId = req.get('x-participant-id')
    const accessToken = req.get('x-room-access-token')
    if (!participantId || !accessToken) {
      res.status(401).json({ error: 'invalid_access', message: 'Room access expired or invalid.' })
      return
    }
    const chat = participantChat({
      roomId: req.params.roomId,
      participantId,
      accessToken,
      limit: req.query.limit,
    })
    res.json(chat)
  })

  router.post('/:roomId/chat', (req, res) => {
    const { participantId, accessToken } = participantHeaders(req)
    const result = createParticipantChatMessage({
      roomId: req.params.roomId,
      participantId,
      accessToken,
      body: req.body?.body,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    })
    res.status(result.retained ? 201 : 202).json(result)
  })

  router.get('/:roomId/transcript/status', (req, res) => {
    const participantId = req.get('x-participant-id')
    const accessToken = req.get('x-room-access-token')
    if (!participantId || !accessToken) {
      res.status(401).json({ error: 'invalid_access', message: 'Room access expired or invalid.' })
      return
    }
    res.json(participantTranscriptStatus({
      roomId: req.params.roomId,
      participantId,
      accessToken,
    }))
  })

  router.post('/:roomId/transcript/consent', (req, res) => {
    const participantId = req.get('x-participant-id')
    const accessToken = req.get('x-room-access-token')
    if (!participantId || !accessToken) {
      res.status(401).json({ error: 'invalid_access', message: 'Room access expired or invalid.' })
      return
    }
    res.json(recordParticipantTranscriptConsent({
      roomId: req.params.roomId,
      participantId,
      accessToken,
      status: req.body?.status,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    }))
  })

  router.get('/:roomId/recording/status', (req, res) => {
    const participantId = req.get('x-participant-id')
    const accessToken = req.get('x-room-access-token')
    if (!participantId || !accessToken) {
      res.status(401).json({ error: 'invalid_access', message: 'Room access expired or invalid.' })
      return
    }
    res.json(participantRecordingStatus({
      roomId: req.params.roomId,
      participantId,
      accessToken,
    }))
  })

  router.post('/:roomId/recording/consent', (req, res) => {
    const participantId = req.get('x-participant-id')
    const accessToken = req.get('x-room-access-token')
    if (!participantId || !accessToken) {
      res.status(401).json({ error: 'invalid_access', message: 'Room access expired or invalid.' })
      return
    }
    res.json(recordParticipantRecordingConsent({
      roomId: req.params.roomId,
      participantId,
      accessToken,
      status: req.body?.status,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    }))
  })

  router.get('/:roomId/live-captions', (req, res) => {
    const participantId = req.get('x-participant-id')
    const accessToken = req.get('x-room-access-token')
    if (!participantId || !accessToken) {
      res.status(401).json({ error: 'invalid_access', message: 'Room access expired or invalid.' })
      return
    }
    res.json(participantLiveCaptions({
      roomId: req.params.roomId,
      participantId,
      accessToken,
      afterMs: req.query.afterMs,
      limit: req.query.limit,
    }))
  })

  router.get('/:roomId/waiting', (req, res) => {
    const auth = authenticateAccess({ roomId: req.params.roomId, ...participantHeaders(req) })
    if (auth.access.role !== 'host') {
      res.status(403).json({ error: 'host_required', message: 'Only the host can view waiting participants.' })
      return
    }
    res.json({ waitingParticipants: listWaitingParticipants(req.params.roomId) })
  })

  router.post('/:roomId/waiting/:participantId/:decision', (req, res, next) => {
    const auth = authenticateAccess({ roomId: req.params.roomId, ...participantHeaders(req) })
    if (auth.access.role !== 'host') {
      res.status(403).json({ error: 'host_required', message: 'Only the host can manage waiting participants.' })
      return
    }
    const admissionByDecision = { admit: 'admitted', reject: 'rejected', remove: 'removed' }
    const decision = admissionByDecision[req.params.decision]
    if (!decision) {
      res.status(404).json({ error: 'not_found', message: 'Not found' })
      return
    }
    try {
      const result = decideWaitingParticipant({
        roomId: req.params.roomId,
        participantId: req.params.participantId,
        decision,
        actorType: 'participant',
        actorId: auth.access.participant_id,
        ip: clientIp(req),
        userAgent: req.get('user-agent'),
      })
      res.json({ participant: result, waitingParticipants: listWaitingParticipants(req.params.roomId) })
    } catch (error) {
      next(error)
    }
  })

  router.post('/:roomId/end', (req, res) => {
    const { participantId, accessToken } = participantHeaders(req)
    const auth = authenticateAccess({ roomId: req.params.roomId, participantId, accessToken })
    if (auth.access.role !== 'host') {
      recordAuditEvent({
        actorType: 'participant',
        actorId: participantId || null,
        action: 'room.end_denied',
        resourceType: 'room',
        resourceId: req.params.roomId,
        roomId: req.params.roomId,
        ip: clientIp(req),
        userAgent: req.get('user-agent'),
      })
      res.status(403).json({ error: 'host_required', message: 'Only the host can end this room.' })
      return
    }
    const room = endRoomForAll({
      roomId: req.params.roomId,
      actorType: 'participant',
      actorId: participantId,
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
      reason: req.body?.reason,
    })
    onRoomEnded?.(req.params.roomId, { reason: 'ended_by_host' })
    res.json({ room })
  })

  return router
}

export const adminTestHooks = {
  bootstrapConfig,
  cookieOptions,
  localDefaultPassword: LOCAL_BOOTSTRAP_PASSWORD,
  sessionCookie: SESSION_COOKIE,
}
