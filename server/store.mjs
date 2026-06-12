import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readLimit } from './rate-limit.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const defaultDataDir = join(__dirname, '..', 'data')
const dbPath = process.env.WEBRTC_DB_PATH || join(defaultDataDir, 'webrtc.sqlite')
mkdirSync(dirname(dbPath), { recursive: true })

export const db = new DatabaseSync(dbPath)
db.exec(`
  create table if not exists rooms (
    id text primary key,
    display_name text,
    password_hash text not null,
    password_salt text not null,
    created_at text not null,
    expires_at text not null,
    max_participants integer not null default 2,
    status text not null default 'active'
  );

  create table if not exists room_access_tokens (
    token_hash text primary key,
    room_id text not null references rooms(id),
    participant_id text not null,
    role text not null check(role in ('host','guest')),
    issued_at text not null,
    expires_at text not null,
    consumed_at text,
    revoked_at text
  );

  create table if not exists room_presence (
    room_id text not null references rooms(id),
    participant_id text not null,
    role text not null,
    connected_at text not null,
    last_seen_at text not null,
    disconnected_at text,
    primary key(room_id, participant_id)
  );
`)

function columnNames(tableName) {
  return new Set(db.prepare(`pragma table_info(${tableName})`).all().map((column) => column.name))
}

function addColumnIfMissing(tableName, columnName, definition) {
  const names = columnNames(tableName)
  if (!names.has(columnName)) db.exec(`alter table ${tableName} add column ${columnName} ${definition}`)
}

addColumnIfMissing('rooms', 'ended_at', 'text')
addColumnIfMissing('rooms', 'ended_by_admin_user_id', 'text')
addColumnIfMissing('rooms', 'waiting_room_enabled', 'integer not null default 0')
addColumnIfMissing('rooms', 'auto_admit_first_guest', 'integer not null default 1')
addColumnIfMissing('rooms', 'metadata_json', "text not null default '{}'")
addColumnIfMissing('rooms', 'metadata_text_index', 'text')
addColumnIfMissing('rooms', 'disabled_at', 'text')
addColumnIfMissing('rooms', 'locked_at', 'text')
addColumnIfMissing('rooms', 'last_lifecycle_reason', 'text')
addColumnIfMissing('rooms', 'chat_retention_pending', 'integer not null default 0')
addColumnIfMissing('rooms', 'transcript_pending', 'integer not null default 0')
addColumnIfMissing('rooms', 'recording_pending', 'integer not null default 0')
addColumnIfMissing('room_access_tokens', 'admission_status', "text not null default 'admitted'")
addColumnIfMissing('room_access_tokens', 'admission_decided_at', 'text')
addColumnIfMissing('room_access_tokens', 'admission_decided_by', 'text')

db.exec(`
  create table if not exists admin_users (
    id text primary key,
    email text not null unique,
    password_hash text not null,
    display_name text not null,
    status text not null check(status in ('bootstrap_required','active','disabled')),
    requires_password_change integer not null default 0,
    created_at text not null,
    last_login_at text,
    password_changed_at text,
    bootstrap_consumed_at text
  );

  create table if not exists admin_sessions (
    id text primary key,
    admin_user_id text not null references admin_users(id),
    session_hash text not null unique,
    csrf_hash text not null,
    created_at text not null,
    last_seen_at text not null,
    expires_at text not null,
    revoked_at text,
    ip_hash text,
    user_agent_hash text
  );

  create table if not exists roles (
    id text primary key,
    key text not null unique,
    name text not null
  );

  create table if not exists permissions (
    id text primary key,
    key text not null unique,
    description text not null
  );

  create table if not exists role_permissions (
    role_id text not null references roles(id),
    permission_id text not null references permissions(id),
    primary key(role_id, permission_id)
  );

  create table if not exists admin_user_roles (
    admin_user_id text not null references admin_users(id),
    role_id text not null references roles(id),
    primary key(admin_user_id, role_id)
  );

  create table if not exists room_metadata (
    room_id text not null references rooms(id),
    key text not null,
    value_json text not null,
    value_text_index text,
    created_at text not null,
    updated_at text not null,
    primary key(room_id, key)
  );

  create table if not exists audit_events (
    id text primary key,
    actor_type text not null,
    actor_id text,
    action text not null,
    resource_type text not null,
    resource_id text,
    room_id text,
    ip_hash text,
    user_agent_hash text,
    metadata_json text not null default '{}',
    created_at text not null
  );

  create table if not exists integration_clients (
    id text primary key,
    name text not null,
    system_key text,
    key_hash text not null unique,
    key_prefix text not null unique,
    status text not null,
    allowed_origins_json text not null default '[]',
    permission_scope_json text not null default '[]',
    created_at text not null,
    rotated_at text
  );

  create table if not exists external_systems (
    system_key text primary key,
    name text not null,
    status text not null default 'active',
    metadata_schema_json text not null default '{}',
    created_at text not null,
    updated_at text not null
  );

  create table if not exists external_identities (
    id text primary key,
    system_key text not null references external_systems(system_key),
    external_user_id text not null,
    display_name text,
    email_hash text,
    metadata_json text not null default '{}',
    created_at text not null,
    updated_at text not null,
    unique(system_key, external_user_id)
  );

  create table if not exists room_external_links (
    id text primary key,
    room_id text not null references rooms(id),
    system_key text not null references external_systems(system_key),
    object_type text not null,
    object_id text not null,
    external_identity_id text references external_identities(id),
    metadata_json text not null default '{}',
    created_at text not null
  );

  create table if not exists agents (
    id text primary key,
    key text not null unique,
    display_name text not null,
    status text not null default 'active',
    metadata_json text not null default '{}',
    created_at text not null,
    updated_at text not null
  );

  create table if not exists agent_room_links (
    id text primary key,
    room_id text not null references rooms(id),
    agent_id text not null references agents(id),
    permission_scope_json text not null default '[]',
    created_at text not null,
    unique(room_id, agent_id)
  );

  create table if not exists webhook_subscriptions (
    id text primary key,
    system_key text not null references external_systems(system_key),
    event_types_json text not null default '[]',
    status text not null default 'local_mock',
    created_at text not null,
    updated_at text not null
  );

  create table if not exists webhook_delivery_attempts (
    id text primary key,
    subscription_id text references webhook_subscriptions(id),
    event_type text not null,
    room_id text references rooms(id),
    status text not null,
    payload_digest text not null,
    signature_preview text not null,
    created_at text not null
  );

  create table if not exists room_lifecycle_events (
    id text primary key,
    room_id text not null references rooms(id),
    from_status text,
    to_status text not null,
    actor_type text not null,
    actor_id text,
    reason text,
    metadata_json text not null default '{}',
    created_at text not null
  );

  create table if not exists retention_policies (
    id text primary key,
    key text not null unique,
    name text not null,
    chat_retention_enabled integer not null default 0,
    chat_retention_days integer,
    chat_export_enabled integer not null default 0,
    created_at text not null,
    updated_at text not null
  );

  create table if not exists room_chat_settings (
    room_id text primary key references rooms(id),
    retention_policy_id text references retention_policies(id),
    retention_enabled integer not null default 0,
    retention_days integer not null default 7,
    participant_notice text not null,
    created_at text not null,
    updated_at text not null
  );

  create table if not exists chat_messages (
    id text primary key,
    room_id text not null references rooms(id),
    participant_id text,
    admin_user_id text,
    sender_role text not null check(sender_role in ('host','guest','admin','system')),
    body text not null,
    body_text_index text,
    created_at text not null,
    redacted_at text,
    redacted_by_admin_user_id text,
    deleted_at text,
    deleted_by_admin_user_id text,
    retention_expires_at text
  );

  create table if not exists room_transcript_settings (
    room_id text primary key references rooms(id),
    transcript_enabled integer not null default 0,
    live_captions_enabled integer not null default 0,
    mock_provider_enabled integer not null default 0,
    participant_notice text not null,
    notice_version text not null default 'local-v1',
    retention_days integer not null default 7,
    created_at text not null,
    updated_at text not null
  );

  create table if not exists participant_transcript_consents (
    id text primary key,
    room_id text not null references rooms(id),
    participant_id text not null,
    access_token_hash text,
    status text not null check(status in ('acknowledged','declined','revoked')),
    notice_version text not null,
    created_at text not null,
    updated_at text not null,
    unique(room_id, participant_id, notice_version)
  );

  create table if not exists transcript_artifacts (
    id text primary key,
    room_id text not null references rooms(id),
    provider_key text not null,
    source text not null check(source in ('mock')),
    status text not null check(status in ('draft','active','finalized','failed','deleted')),
    language text not null default 'en',
    started_at text,
    finalized_at text,
    retention_expires_at text,
    deleted_at text,
    deleted_by_admin_user_id text,
    metadata_json text not null default '{}',
    created_at text not null,
    updated_at text not null
  );

  create table if not exists transcript_segments (
    id text primary key,
    artifact_id text not null references transcript_artifacts(id),
    room_id text not null references rooms(id),
    participant_id text,
    speaker_label text,
    start_ms integer not null,
    end_ms integer not null,
    text text not null,
    confidence real,
    is_final integer not null default 1,
    created_at text not null,
    redacted_at text,
    redacted_by_admin_user_id text,
    deleted_at text,
    deleted_by_admin_user_id text
  );

  create table if not exists room_recording_settings (
    room_id text primary key references rooms(id),
    recording_enabled integer not null default 0,
    mock_recording_enabled integer not null default 0,
    participant_notice text not null,
    notice_version text not null default 'local-v1',
    retention_days integer not null default 7,
    created_at text not null,
    updated_at text not null
  );

  create table if not exists participant_recording_consents (
    id text primary key,
    room_id text not null references rooms(id),
    participant_id text not null,
    access_token_hash text,
    status text not null check(status in ('acknowledged','declined','revoked')),
    notice_version text not null,
    created_at text not null,
    updated_at text not null,
    unique(room_id, participant_id, notice_version)
  );

  create table if not exists recording_artifacts (
    id text primary key,
    room_id text not null references rooms(id),
    source text not null check(source in ('mock_metadata')),
    status text not null check(status in ('mock_active','mock_finalized','mock_failed','deleted')),
    storage_provider text not null default 'none',
    storage_key text,
    byte_size integer not null default 0,
    duration_ms integer,
    started_at text,
    finalized_at text,
    retention_expires_at text,
    deleted_at text,
    deleted_by_admin_user_id text,
    failure_reason text,
    metadata_json text not null default '{}',
    created_at text not null,
    updated_at text not null
  );

  create table if not exists recording_artifact_events (
    id text primary key,
    recording_artifact_id text not null references recording_artifacts(id),
    room_id text not null references rooms(id),
    action text not null,
    actor_type text not null,
    actor_id text,
    metadata_json text not null default '{}',
    created_at text not null
  );

  create table if not exists room_embed_settings (
    room_id text primary key references rooms(id),
    embed_enabled integer not null default 0,
    allowed_origins_json text not null default '[]',
    created_at text not null,
    updated_at text not null
  );

  create table if not exists embed_sessions (
    id text primary key,
    room_id text not null references rooms(id),
    participant_id text,
    bootstrap_token_hash text not null unique,
    session_token_hash text unique,
    scope_json text not null default '[]',
    allowed_origin text not null,
    expires_at text not null,
    exchanged_at text,
    revoked_at text,
    created_by_type text not null,
    created_by_id text,
    created_at text not null
  );

  create table if not exists embed_origin_events (
    id text primary key,
    room_id text,
    embed_session_id text,
    origin_hash text,
    event_type text not null,
    reason text not null,
    created_at text not null
  );

  create index if not exists chat_messages_room_created_idx on chat_messages(room_id, created_at);
  create index if not exists chat_messages_room_expiry_idx on chat_messages(room_id, retention_expires_at);
  create index if not exists room_chat_settings_enabled_idx on room_chat_settings(retention_enabled);
  create index if not exists transcript_artifacts_room_created_idx on transcript_artifacts(room_id, created_at);
  create index if not exists transcript_artifacts_room_status_idx on transcript_artifacts(room_id, status);
  create index if not exists transcript_segments_room_start_idx on transcript_segments(room_id, start_ms);
  create index if not exists transcript_segments_artifact_start_idx on transcript_segments(artifact_id, start_ms);
  create index if not exists participant_transcript_consents_room_participant_idx on participant_transcript_consents(room_id, participant_id);
  create index if not exists recording_artifacts_room_created_idx on recording_artifacts(room_id, created_at);
  create index if not exists recording_artifacts_room_status_idx on recording_artifacts(room_id, status);
  create index if not exists participant_recording_consents_room_participant_idx on participant_recording_consents(room_id, participant_id);
  create index if not exists embed_sessions_room_created_idx on embed_sessions(room_id, created_at);
  create index if not exists embed_sessions_room_origin_idx on embed_sessions(room_id, allowed_origin);
  create index if not exists embed_origin_events_room_created_idx on embed_origin_events(room_id, created_at);
`)

addColumnIfMissing('integration_clients', 'system_key', 'text')
addColumnIfMissing('room_chat_settings', 'retention_days', 'integer not null default 7')

const passwordAttempts = new Map()
const chatAttempts = new Map()
const transcriptAttempts = new Map()
const passwordAttemptLimit = readLimit('WEBRTC_PASSWORD_ATTEMPT_LIMIT', 8)
const passwordAttemptWindowMs = readLimit('WEBRTC_PASSWORD_ATTEMPT_WINDOW_MS', 60_000)
const chatAttemptLimit = readLimit('WEBRTC_CHAT_MESSAGE_LIMIT', 20)
const chatAttemptWindowMs = readLimit('WEBRTC_CHAT_MESSAGE_WINDOW_MS', 60_000)
const transcriptAttemptLimit = readLimit('WEBRTC_TRANSCRIPT_SEGMENT_LIMIT', 20)
const transcriptAttemptWindowMs = readLimit('WEBRTC_TRANSCRIPT_SEGMENT_WINDOW_MS', 60_000)
const roomTtlHours = readLimit('WEBRTC_ROOM_TTL_HOURS', 24)

function nowIso() {
  return new Date().toISOString()
}

function futureIso(ms) {
  return new Date(Date.now() + ms).toISOString()
}

function randomId(bytes = 9) {
  return randomBytes(bytes).toString('base64url')
}

export function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('base64url')
}

export function tokenHash(token) {
  return createHash('sha256').update(token).digest('base64url')
}

export function constantEqual(a, b) {
  const left = Buffer.from(a || '')
  const right = Buffer.from(b || '')
  return left.length === right.length && timingSafeEqual(left, right)
}

export function hashForStorage(secret) {
  const salt = randomBytes(16).toString('base64url')
  return `scrypt$${salt}$${hashPassword(secret, salt)}`
}

export function verifyStoredHash(secret, storedHash) {
  const [scheme, salt, hash] = String(storedHash || '').split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  return constantEqual(hashPassword(secret || '', salt), hash)
}

export function hashAuditValue(value) {
  if (!value) return null
  return createHash('sha256').update(String(value)).digest('base64url').slice(0, 24)
}

function publicRoomView(room) {
  if (!room) return null
  return {
    id: room.id,
    displayName: room.display_name,
    createdAt: room.created_at,
    expiresAt: room.expires_at,
    maxParticipants: room.max_participants,
    status: room.status,
    endedAt: room.ended_at,
    waitingRoomEnabled: Boolean(room.waiting_room_enabled),
    autoAdmitFirstGuest: Boolean(room.auto_admit_first_guest),
  }
}

function adminRoomView(room) {
  if (!room) return null
  const metadata = parseJsonObject(room.metadata_json, {})
  return {
    id: room.id,
    displayName: room.display_name,
    createdAt: room.created_at,
    expiresAt: room.expires_at,
    maxParticipants: room.max_participants,
    status: room.status,
    endedAt: room.ended_at,
    disabledAt: room.disabled_at,
    lockedAt: room.locked_at,
    lastLifecycleReason: room.last_lifecycle_reason,
    waitingRoomEnabled: Boolean(room.waiting_room_enabled),
    autoAdmitFirstGuest: Boolean(room.auto_admit_first_guest),
    chatRetentionPending: Boolean(room.chat_retention_pending),
    transcriptPending: Boolean(room.transcript_pending),
    recordingPending: Boolean(room.recording_pending),
    metadata,
  }
}

function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function parseJsonArray(value, fallback = []) {
  try {
    const parsed = JSON.parse(value || '')
    return Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

export function getRoom(roomId) {
  return db.prepare('select * from rooms where id = ?').get(roomId)
}

function assertRoomJoinable(room) {
  if (!room) {
    const error = new Error('Room not found')
    error.code = 'room_not_found'
    error.status = 404
    throw error
  }
  if (room.status === 'locked') {
    const error = new Error('Room is locked')
    error.code = 'room_locked'
    error.status = 423
    throw error
  }
  if (room.status !== 'active' || Date.parse(room.expires_at) <= Date.now()) {
    const error = new Error('Room expired')
    error.code = 'room_expired'
    error.status = 410
    throw error
  }
}

function rateLimitKey(roomId, ip) {
  return `${roomId}:${ip || 'local'}`
}

function checkRateLimit(roomId, ip) {
  const key = rateLimitKey(roomId, ip)
  const current = passwordAttempts.get(key) || { count: 0, resetAt: Date.now() + passwordAttemptWindowMs }
  if (current.resetAt < Date.now()) {
    passwordAttempts.set(key, { count: 0, resetAt: Date.now() + passwordAttemptWindowMs })
    return
  }
  if (current.count >= passwordAttemptLimit) {
    const error = new Error('Too many password attempts. Try again shortly.')
    error.code = 'rate_limited'
    error.status = 429
    throw error
  }
}

function recordPasswordFailure(roomId, ip) {
  const key = rateLimitKey(roomId, ip)
  const current = passwordAttempts.get(key) || { count: 0, resetAt: Date.now() + passwordAttemptWindowMs }
  passwordAttempts.set(key, { ...current, count: current.count + 1 })
}

function clearPasswordFailures(roomId, ip) {
  passwordAttempts.delete(rateLimitKey(roomId, ip))
}

function checkChatRateLimit(roomId, participantId, ip) {
  const key = `${roomId}:${participantId || 'unknown'}:${ip || 'local'}`
  const current = chatAttempts.get(key) || { count: 0, resetAt: Date.now() + chatAttemptWindowMs }
  if (current.resetAt < Date.now()) {
    chatAttempts.set(key, { count: 0, resetAt: Date.now() + chatAttemptWindowMs })
    return
  }
  if (current.count >= chatAttemptLimit) {
    const error = new Error('Too many chat messages. Try again shortly.')
    error.code = 'rate_limited'
    error.status = 429
    throw error
  }
  chatAttempts.set(key, { ...current, count: current.count + 1 })
}

function seedRetentionPolicies() {
  const ts = nowIso()
  db.prepare(`
    insert into retention_policies (
      id, key, name, chat_retention_enabled, chat_retention_days, chat_export_enabled, created_at, updated_at
    )
    values ('policy_local_disabled', 'local_disabled', 'Local disabled', 0, null, 0, ?, ?)
    on conflict(key) do nothing
  `).run(ts, ts)
  db.prepare(`
    insert into retention_policies (
      id, key, name, chat_retention_enabled, chat_retention_days, chat_export_enabled, created_at, updated_at
    )
    values ('policy_local_enabled_7d', 'local_enabled_7d', 'Local retained chat 7 days', 1, 7, 1, ?, ?)
    on conflict(key) do nothing
  `).run(ts, ts)
}

function ensureRoomChatSettings(roomId) {
  seedRetentionPolicies()
  requireRoom(roomId)
  const existing = db.prepare('select * from room_chat_settings where room_id = ?').get(roomId)
  if (existing) return existing
  const ts = nowIso()
  db.prepare(`
    insert into room_chat_settings (
      room_id, retention_policy_id, retention_enabled, retention_days, participant_notice, created_at, updated_at
    )
    values (?, 'policy_local_disabled', 0, 7, ?, ?, ?)
  `).run(roomId, 'Chat retention is off for this room.', ts, ts)
  return db.prepare('select * from room_chat_settings where room_id = ?').get(roomId)
}

function chatSettingsView(row) {
  return {
    retentionEnabled: Boolean(row.retention_enabled),
    retentionDays: Number(row.retention_days || 7),
    participantNotice: row.participant_notice,
    updatedAt: row.updated_at,
  }
}

function retentionExpiry(settings) {
  if (!settings?.retention_enabled) return null
  const days = Number(settings.retention_days || 0)
  return days > 0 ? futureIso(days * 24 * 60 * 60 * 1000) : null
}

function normalizeChatBody(body) {
  const text = String(body || '').trim()
  if (!text) {
    const error = new Error('Chat message cannot be empty.')
    error.code = 'empty_message'
    error.status = 400
    throw error
  }
  if (text.length > 2000) {
    const error = new Error('Chat message is too long.')
    error.code = 'message_too_large'
    error.status = 413
    throw error
  }
  return text
}

function chatMessageProjection(row, { admin = false } = {}) {
  const redacted = Boolean(row.redacted_at)
  const deleted = Boolean(row.deleted_at)
  const hidden = redacted || deleted
  return {
    id: row.id,
    roomId: row.room_id,
    senderRole: row.sender_role,
    participantId: row.participant_id,
    createdAt: row.created_at,
    body: hidden ? (deleted ? '[deleted]' : '[redacted]') : row.body,
    redacted,
    deleted,
    ...(admin ? {
      retentionExpiresAt: row.retention_expires_at,
      redactedAt: row.redacted_at,
      deletedAt: row.deleted_at,
    } : {}),
  }
}

function chatMessagesForRoom(roomId, limit = 50, { admin = false } = {}) {
  const capped = Math.max(1, Math.min(200, Number(limit || 50)))
  return db.prepare(`
    select * from chat_messages
    where room_id = ?
    order by created_at asc
    limit ?
  `).all(roomId, capped).map((row) => chatMessageProjection(row, { admin }))
}

export function participantChat({ roomId, participantId, accessToken, limit }) {
  const auth = authenticateAccess({ roomId, participantId, accessToken })
  const settings = ensureRoomChatSettings(roomId)
  return {
    retention: chatSettingsView(settings),
    messages: settings.retention_enabled ? chatMessagesForRoom(roomId, limit, { admin: false }) : [],
    participant: { participantId: auth.access.participant_id, role: auth.access.role },
  }
}

export function createParticipantChatMessage({ roomId, participantId, accessToken, body, ip, userAgent }) {
  const auth = authenticateAccess({ roomId, participantId, accessToken })
  const text = normalizeChatBody(body)
  checkChatRateLimit(roomId, participantId, ip)
  const settings = ensureRoomChatSettings(roomId)
  if (!settings.retention_enabled) {
    return {
      retained: false,
      retention: chatSettingsView(settings),
      message: null,
    }
  }
  const id = randomId(12)
  const createdAt = nowIso()
  db.prepare(`
    insert into chat_messages (
      id, room_id, participant_id, admin_user_id, sender_role, body, body_text_index,
      created_at, retention_expires_at
    )
    values (?, ?, ?, null, ?, ?, ?, ?, ?)
  `).run(
    id,
    roomId,
    auth.access.participant_id,
    auth.access.role,
    text,
    text.slice(0, 500),
    createdAt,
    retentionExpiry(settings),
  )
  recordAuditEvent({
    actorType: 'participant',
    actorId: auth.access.participant_id,
    action: 'chat.message_created',
    resourceType: 'chat_message',
    resourceId: id,
    roomId,
    ip,
    userAgent,
    metadata: { senderRole: auth.access.role },
  })
  return {
    retained: true,
    retention: chatSettingsView(settings),
    message: chatMessageProjection(db.prepare('select * from chat_messages where id = ?').get(id)),
  }
}

export function configureRoomChatRetention({ roomId, actorId, enabled, notice, retentionDays, ip, userAgent }) {
  return withTransaction(() => {
    ensureRoomChatSettings(roomId)
    const ts = nowIso()
    const retentionEnabled = Boolean(enabled)
    const days = Math.max(1, Math.min(30, Number(retentionDays || 7)))
    const policyKey = retentionEnabled ? 'local_enabled_7d' : 'local_disabled'
    const policy = db.prepare('select id from retention_policies where key = ?').get(policyKey)
    const participantNotice = String(notice || (retentionEnabled
      ? 'Chat retention is enabled for this room.'
      : 'Chat retention is off for this room.')).slice(0, 240)
    db.prepare(`
      update room_chat_settings
      set retention_policy_id = ?, retention_enabled = ?, retention_days = ?, participant_notice = ?, updated_at = ?
      where room_id = ?
    `).run(policy.id, retentionEnabled ? 1 : 0, days, participantNotice, ts, roomId)
    recordAuditEvent({
      actorType: 'admin',
      actorId,
      action: 'chat.retention_configured',
      resourceType: 'room_chat_settings',
      resourceId: roomId,
      roomId,
      ip,
      userAgent,
      metadata: { retentionEnabled },
    })
    return chatSettingsView(ensureRoomChatSettings(roomId))
  })
}

export function adminRoomChat({ roomId, actorId, ip, userAgent, limit = 100 }) {
  const settings = ensureRoomChatSettings(roomId)
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'chat.viewed',
    resourceType: 'chat_message',
    roomId,
    ip,
    userAgent,
    metadata: { limit: Math.max(1, Math.min(200, Number(limit || 100))) },
  })
  return {
    retention: chatSettingsView(settings),
    messages: settings.retention_enabled ? chatMessagesForRoom(roomId, limit, { admin: true }) : [],
  }
}

export function exportRoomChat({ roomId, actorId, ip, userAgent, limit = 200 }) {
  const settings = ensureRoomChatSettings(roomId)
  if (!settings.retention_enabled) {
    const error = new Error('Chat retention is disabled for this room.')
    error.code = 'chat_retention_disabled'
    error.status = 409
    throw error
  }
  const messages = chatMessagesForRoom(roomId, limit, { admin: true })
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'chat.exported',
    resourceType: 'chat_message',
    roomId,
    ip,
    userAgent,
    metadata: { count: messages.length },
  })
  return { retention: chatSettingsView(settings), messages }
}

function requireChatMessage(roomId, messageId) {
  const row = db.prepare('select * from chat_messages where room_id = ? and id = ?').get(roomId, messageId)
  if (!row) {
    const error = new Error('Chat message not found.')
    error.code = 'chat_message_not_found'
    error.status = 404
    throw error
  }
  return row
}

export function redactRoomChatMessage({ roomId, messageId, actorId, ip, userAgent }) {
  requireChatMessage(roomId, messageId)
  const ts = nowIso()
  db.prepare(`
    update chat_messages
    set redacted_at = ?, redacted_by_admin_user_id = ?, body = ''
    where room_id = ? and id = ?
  `).run(ts, actorId, roomId, messageId)
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'chat.redacted',
    resourceType: 'chat_message',
    resourceId: messageId,
    roomId,
    ip,
    userAgent,
  })
  return chatMessageProjection(requireChatMessage(roomId, messageId), { admin: true })
}

export function deleteRoomChatMessage({ roomId, messageId, actorId, ip, userAgent }) {
  requireChatMessage(roomId, messageId)
  const ts = nowIso()
  db.prepare(`
    update chat_messages
    set deleted_at = ?, deleted_by_admin_user_id = ?, body = ''
    where room_id = ? and id = ?
  `).run(ts, actorId, roomId, messageId)
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'chat.deleted',
    resourceType: 'chat_message',
    resourceId: messageId,
    roomId,
    ip,
    userAgent,
  })
  return chatMessageProjection(requireChatMessage(roomId, messageId), { admin: true })
}

function checkTranscriptRateLimit(roomId, artifactId, ip) {
  const key = `${roomId}:${artifactId || 'unknown'}:${ip || 'local'}`
  const current = transcriptAttempts.get(key) || { count: 0, resetAt: Date.now() + transcriptAttemptWindowMs }
  if (current.resetAt < Date.now()) {
    transcriptAttempts.set(key, { count: 0, resetAt: Date.now() + transcriptAttemptWindowMs })
    return
  }
  if (current.count >= transcriptAttemptLimit) {
    const error = new Error('Too many mock transcript segments. Try again shortly.')
    error.code = 'rate_limited'
    error.status = 429
    throw error
  }
  transcriptAttempts.set(key, { ...current, count: current.count + 1 })
}

function ensureRoomTranscriptSettings(roomId) {
  requireRoom(roomId)
  const existing = db.prepare('select * from room_transcript_settings where room_id = ?').get(roomId)
  if (existing) return existing
  const ts = nowIso()
  db.prepare(`
    insert into room_transcript_settings (
      room_id, transcript_enabled, live_captions_enabled, mock_provider_enabled,
      participant_notice, notice_version, retention_days, created_at, updated_at
    )
    values (?, 0, 0, 0, ?, 'local-v1', 7, ?, ?)
  `).run(roomId, 'Local mock transcripts and live captions are off for this room.', ts, ts)
  return db.prepare('select * from room_transcript_settings where room_id = ?').get(roomId)
}

function transcriptSettingsView(row) {
  return {
    transcriptEnabled: Boolean(row.transcript_enabled),
    liveCaptionsEnabled: Boolean(row.live_captions_enabled),
    mockProviderEnabled: Boolean(row.mock_provider_enabled),
    participantNotice: row.participant_notice,
    noticeVersion: row.notice_version,
    retentionDays: Number(row.retention_days || 7),
    updatedAt: row.updated_at,
  }
}

function transcriptRetentionExpiry(settings) {
  const days = Number(settings?.retention_days || 0)
  return days > 0 ? futureIso(days * 24 * 60 * 60 * 1000) : null
}

function requireTranscriptEnabled(settings) {
  if (!settings.transcript_enabled) {
    const error = new Error('Transcripts are disabled for this room.')
    error.code = 'transcripts_disabled'
    error.status = 409
    throw error
  }
}

function requireLiveCaptionsEnabled(settings) {
  if (!settings.live_captions_enabled) {
    const error = new Error('Live captions are disabled for this room.')
    error.code = 'live_captions_disabled'
    error.status = 409
    throw error
  }
}

function requireMockProvider(providerKey = 'mock_local') {
  if (providerKey !== 'mock_local') {
    const error = new Error('Only the local mock transcript provider is available.')
    error.code = 'invalid_transcript_provider'
    error.status = 400
    throw error
  }
}

function normalizeTranscriptText(text) {
  const normalized = String(text || '').trim()
  if (!normalized) {
    const error = new Error('Transcript segment text cannot be empty.')
    error.code = 'empty_transcript_segment'
    error.status = 400
    throw error
  }
  if (normalized.length > 2000) {
    const error = new Error('Transcript segment text is too long.')
    error.code = 'transcript_segment_too_large'
    error.status = 413
    throw error
  }
  return normalized
}

function transcriptConsentFor(roomId, participantId, noticeVersion) {
  return db.prepare(`
    select * from participant_transcript_consents
    where room_id = ? and participant_id = ? and notice_version = ?
  `).get(roomId, participantId, noticeVersion)
}

function transcriptConsentState(settings, participantId) {
  if (!settings.transcript_enabled && !settings.live_captions_enabled) return 'not_required'
  const consent = transcriptConsentFor(settings.room_id, participantId, settings.notice_version)
  return consent?.status || 'notice_required'
}

function requireTranscriptConsent(settings, participantId) {
  const state = transcriptConsentState(settings, participantId)
  if (state === 'acknowledged') return
  const error = new Error(state === 'declined'
    ? 'Transcript and live-caption notice was declined.'
    : 'Transcript and live-caption notice acknowledgement is required.')
  error.code = state === 'declined' ? 'transcript_consent_declined' : 'transcript_consent_required'
  error.status = 403
  throw error
}

function transcriptSegmentProjection(row, { admin = false } = {}) {
  const redacted = Boolean(row.redacted_at)
  const deleted = Boolean(row.deleted_at)
  const hidden = redacted || deleted
  return {
    id: row.id,
    artifactId: row.artifact_id,
    roomId: row.room_id,
    participantId: row.participant_id,
    speakerLabel: row.speaker_label,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: hidden ? (deleted ? '[deleted]' : '[redacted]') : row.text,
    confidence: row.confidence,
    final: Boolean(row.is_final),
    createdAt: row.created_at,
    redacted,
    deleted,
    ...(admin ? {
      redactedAt: row.redacted_at,
      deletedAt: row.deleted_at,
    } : {}),
  }
}

function transcriptArtifactProjection(row, { includeMetadata = false } = {}) {
  return {
    id: row.id,
    roomId: row.room_id,
    providerKey: row.provider_key,
    source: row.source,
    status: row.status,
    language: row.language,
    startedAt: row.started_at,
    finalizedAt: row.finalized_at,
    retentionExpiresAt: row.retention_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    ...(includeMetadata ? { metadata: parseJsonObject(row.metadata_json, {}) } : {}),
  }
}

function transcriptSegmentsForArtifact(roomId, artifactId, { afterMs = 0, limit = 100, admin = false } = {}) {
  const capped = Math.max(1, Math.min(200, Number(limit || 100)))
  const after = Math.max(0, Number(afterMs || 0))
  return db.prepare(`
    select * from transcript_segments
    where room_id = ? and artifact_id = ? and start_ms >= ?
    order by start_ms asc, created_at asc
    limit ?
  `).all(roomId, artifactId, after, capped).map((row) => transcriptSegmentProjection(row, { admin }))
}

function requireTranscriptArtifact(roomId, artifactId) {
  const row = db.prepare('select * from transcript_artifacts where room_id = ? and id = ?').get(roomId, artifactId)
  if (!row || row.status === 'deleted') {
    const error = new Error('Transcript artifact not found.')
    error.code = 'transcript_artifact_not_found'
    error.status = 404
    throw error
  }
  return row
}

function requireTranscriptSegment(roomId, artifactId, segmentId) {
  const row = db.prepare(`
    select * from transcript_segments
    where room_id = ? and artifact_id = ? and id = ?
  `).get(roomId, artifactId, segmentId)
  if (!row) {
    const error = new Error('Transcript segment not found.')
    error.code = 'transcript_segment_not_found'
    error.status = 404
    throw error
  }
  return row
}

export function participantTranscriptStatus({ roomId, participantId, accessToken }) {
  const auth = authenticateAccess({ roomId, participantId, accessToken })
  const settings = ensureRoomTranscriptSettings(roomId)
  return {
    settings: transcriptSettingsView(settings),
    consent: {
      status: transcriptConsentState(settings, auth.access.participant_id),
      noticeVersion: settings.notice_version,
    },
  }
}

export function recordParticipantTranscriptConsent({ roomId, participantId, accessToken, status, ip, userAgent }) {
  const auth = authenticateAccess({ roomId, participantId, accessToken })
  const settings = ensureRoomTranscriptSettings(roomId)
  if (!settings.transcript_enabled && !settings.live_captions_enabled) {
    const error = new Error('Transcript and live-caption notice is not required for this room.')
    error.code = 'transcripts_disabled'
    error.status = 409
    throw error
  }
  const normalized = String(status || '').trim()
  if (!['acknowledged', 'declined'].includes(normalized)) {
    const error = new Error('Transcript consent status must be acknowledged or declined.')
    error.code = 'invalid_transcript_consent'
    error.status = 400
    throw error
  }
  const ts = nowIso()
  const id = randomId(12)
  db.prepare(`
    insert into participant_transcript_consents (
      id, room_id, participant_id, access_token_hash, status, notice_version, created_at, updated_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(room_id, participant_id, notice_version) do update set
      status = excluded.status,
      access_token_hash = excluded.access_token_hash,
      updated_at = excluded.updated_at
  `).run(id, roomId, auth.access.participant_id, tokenHash(accessToken), normalized, settings.notice_version, ts, ts)
  recordAuditEvent({
    actorType: 'participant',
    actorId: auth.access.participant_id,
    action: 'transcript.consent_recorded',
    resourceType: 'transcript_consent',
    resourceId: auth.access.participant_id,
    roomId,
    ip,
    userAgent,
    metadata: { status: normalized, noticeVersion: settings.notice_version },
  })
  return participantTranscriptStatus({ roomId, participantId, accessToken })
}

export function participantLiveCaptions({ roomId, participantId, accessToken, afterMs = 0, limit = 100 }) {
  const auth = authenticateAccess({ roomId, participantId, accessToken })
  const settings = ensureRoomTranscriptSettings(roomId)
  requireTranscriptEnabled(settings)
  requireLiveCaptionsEnabled(settings)
  requireTranscriptConsent(settings, auth.access.participant_id)
  const artifact = db.prepare(`
    select * from transcript_artifacts
    where room_id = ? and status in ('active','finalized') and deleted_at is null
    order by created_at desc
    limit 1
  `).get(roomId)
  return {
    settings: transcriptSettingsView(settings),
    artifact: artifact ? transcriptArtifactProjection(artifact) : null,
    segments: artifact ? transcriptSegmentsForArtifact(roomId, artifact.id, { afterMs, limit, admin: false }) : [],
  }
}

export function configureTranscriptSettings({ roomId, actorId, transcriptEnabled, liveCaptionsEnabled, mockProviderEnabled, notice, retentionDays, ip, userAgent }) {
  return withTransaction(() => {
    ensureRoomTranscriptSettings(roomId)
    const ts = nowIso()
    const nextTranscriptEnabled = Boolean(transcriptEnabled)
    const nextLiveCaptionsEnabled = Boolean(liveCaptionsEnabled) && nextTranscriptEnabled
    const nextMockProviderEnabled = Boolean(mockProviderEnabled) && nextTranscriptEnabled
    const nextNotice = String(notice || (nextTranscriptEnabled
      ? 'Local mock transcripts and live captions are enabled for this room.'
      : 'Local mock transcripts and live captions are off for this room.')).slice(0, 360)
    const days = Math.max(1, Math.min(30, Number(retentionDays || 7)))
    const noticeVersion = `local-v${createHash('sha256').update(`${nextNotice}:${nextTranscriptEnabled}:${nextLiveCaptionsEnabled}`).digest('hex').slice(0, 12)}`
    db.prepare(`
      update room_transcript_settings
      set transcript_enabled = ?, live_captions_enabled = ?, mock_provider_enabled = ?,
        participant_notice = ?, notice_version = ?, retention_days = ?, updated_at = ?
      where room_id = ?
    `).run(
      nextTranscriptEnabled ? 1 : 0,
      nextLiveCaptionsEnabled ? 1 : 0,
      nextMockProviderEnabled ? 1 : 0,
      nextNotice,
      noticeVersion,
      days,
      ts,
      roomId,
    )
    recordAuditEvent({
      actorType: 'admin',
      actorId,
      action: 'transcript.settings_configured',
      resourceType: 'transcript_settings',
      resourceId: roomId,
      roomId,
      ip,
      userAgent,
      metadata: {
        transcriptEnabled: nextTranscriptEnabled,
        liveCaptionsEnabled: nextLiveCaptionsEnabled,
        mockProviderEnabled: nextMockProviderEnabled,
      },
    })
    return transcriptSettingsView(ensureRoomTranscriptSettings(roomId))
  })
}

export function adminTranscriptSettings({ roomId }) {
  return transcriptSettingsView(ensureRoomTranscriptSettings(roomId))
}

function assertRoomCanCreateTranscript(roomId) {
  const room = requireRoom(roomId)
  assertRoomJoinable(room)
}

export function startMockTranscript({ roomId, actorId, providerKey = 'mock_local', language = 'en', ip, userAgent }) {
  requireMockProvider(providerKey)
  assertRoomCanCreateTranscript(roomId)
  const settings = ensureRoomTranscriptSettings(roomId)
  requireTranscriptEnabled(settings)
  if (!settings.mock_provider_enabled) {
    const error = new Error('Local mock transcript provider is disabled for this room.')
    error.code = 'mock_provider_disabled'
    error.status = 409
    throw error
  }
  const id = randomId(12)
  const ts = nowIso()
  const normalizedLanguage = String(language || 'en').trim().slice(0, 16) || 'en'
  db.prepare(`
    insert into transcript_artifacts (
      id, room_id, provider_key, source, status, language, started_at, retention_expires_at,
      metadata_json, created_at, updated_at
    )
    values (?, ?, 'mock_local', 'mock', 'active', ?, ?, ?, '{}', ?, ?)
  `).run(id, roomId, normalizedLanguage, ts, transcriptRetentionExpiry(settings), ts, ts)
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'transcript.mock_started',
    resourceType: 'transcript_artifact',
    resourceId: id,
    roomId,
    ip,
    userAgent,
    metadata: { providerKey: 'mock_local', language: normalizedLanguage },
  })
  return transcriptArtifactProjection(requireTranscriptArtifact(roomId, id), { includeMetadata: true })
}

export function appendMockTranscriptSegment({ roomId, artifactId, actorId, participantId, speakerLabel, text, startMs, endMs, ip, userAgent }) {
  assertRoomCanCreateTranscript(roomId)
  const artifact = requireTranscriptArtifact(roomId, artifactId)
  if (artifact.provider_key !== 'mock_local' || artifact.source !== 'mock') requireMockProvider(artifact.provider_key)
  if (artifact.status !== 'active') {
    const error = new Error('Mock transcript is not active.')
    error.code = 'transcript_not_active'
    error.status = 409
    throw error
  }
  checkTranscriptRateLimit(roomId, artifactId, ip)
  const segmentText = normalizeTranscriptText(text)
  const id = randomId(12)
  const start = Math.max(0, Number(startMs || 0))
  const end = Math.max(start, Number(endMs || start + 1000))
  const label = String(speakerLabel || 'Mock speaker').trim().slice(0, 80)
  const ts = nowIso()
  db.prepare(`
    insert into transcript_segments (
      id, artifact_id, room_id, participant_id, speaker_label, start_ms, end_ms,
      text, confidence, is_final, created_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, 1.0, 1, ?)
  `).run(id, artifactId, roomId, participantId ? String(participantId).slice(0, 80) : null, label, start, end, segmentText, ts)
  db.prepare('update transcript_artifacts set updated_at = ? where id = ?').run(ts, artifactId)
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'transcript.mock_segment_created',
    resourceType: 'transcript_segment',
    resourceId: id,
    roomId,
    ip,
    userAgent,
    metadata: { artifactId, segmentId: id, providerKey: 'mock_local' },
  })
  return transcriptSegmentProjection(requireTranscriptSegment(roomId, artifactId, id), { admin: true })
}

export function finalizeMockTranscript({ roomId, artifactId, actorId, ip, userAgent }) {
  const artifact = requireTranscriptArtifact(roomId, artifactId)
  if (artifact.status !== 'active') {
    const error = new Error('Mock transcript is not active.')
    error.code = 'transcript_not_active'
    error.status = 409
    throw error
  }
  const ts = nowIso()
  db.prepare(`
    update transcript_artifacts
    set status = 'finalized', finalized_at = ?, updated_at = ?
    where room_id = ? and id = ?
  `).run(ts, ts, roomId, artifactId)
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'transcript.finalized',
    resourceType: 'transcript_artifact',
    resourceId: artifactId,
    roomId,
    ip,
    userAgent,
  })
  return transcriptArtifactProjection(requireTranscriptArtifact(roomId, artifactId), { includeMetadata: true })
}

export function listRoomTranscripts({ roomId, actorId, ip, userAgent, limit = 50 }) {
  ensureRoomTranscriptSettings(roomId)
  const capped = Math.max(1, Math.min(100, Number(limit || 50)))
  const artifacts = db.prepare(`
    select * from transcript_artifacts
    where room_id = ? and status != 'deleted'
    order by created_at desc
    limit ?
  `).all(roomId, capped).map((row) => transcriptArtifactProjection(row, { includeMetadata: true }))
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'transcript.viewed',
    resourceType: 'transcript_artifact',
    roomId,
    ip,
    userAgent,
    metadata: { count: artifacts.length },
  })
  return { settings: transcriptSettingsView(ensureRoomTranscriptSettings(roomId)), artifacts }
}

export function getRoomTranscript({ roomId, artifactId, actorId, ip, userAgent, limit = 100 }) {
  const artifact = requireTranscriptArtifact(roomId, artifactId)
  const segments = transcriptSegmentsForArtifact(roomId, artifactId, { limit, admin: true })
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'transcript.viewed',
    resourceType: 'transcript_artifact',
    resourceId: artifactId,
    roomId,
    ip,
    userAgent,
    metadata: { segmentCount: segments.length },
  })
  return { artifact: transcriptArtifactProjection(artifact, { includeMetadata: true }), segments }
}

export function exportRoomTranscript({ roomId, artifactId, actorId, ip, userAgent, limit = 200 }) {
  const artifact = requireTranscriptArtifact(roomId, artifactId)
  const segments = transcriptSegmentsForArtifact(roomId, artifactId, { limit, admin: true })
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'transcript.exported',
    resourceType: 'transcript_artifact',
    resourceId: artifactId,
    roomId,
    ip,
    userAgent,
    metadata: { segmentCount: segments.length },
  })
  return { artifact: transcriptArtifactProjection(artifact), segments }
}

export function redactTranscriptSegment({ roomId, artifactId, segmentId, actorId, ip, userAgent }) {
  requireTranscriptArtifact(roomId, artifactId)
  requireTranscriptSegment(roomId, artifactId, segmentId)
  const ts = nowIso()
  db.prepare(`
    update transcript_segments
    set redacted_at = ?, redacted_by_admin_user_id = ?, text = ''
    where room_id = ? and artifact_id = ? and id = ?
  `).run(ts, actorId, roomId, artifactId, segmentId)
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'transcript.segment_redacted',
    resourceType: 'transcript_segment',
    resourceId: segmentId,
    roomId,
    ip,
    userAgent,
    metadata: { artifactId, segmentId },
  })
  return transcriptSegmentProjection(requireTranscriptSegment(roomId, artifactId, segmentId), { admin: true })
}

export function deleteTranscriptSegment({ roomId, artifactId, segmentId, actorId, ip, userAgent }) {
  requireTranscriptArtifact(roomId, artifactId)
  requireTranscriptSegment(roomId, artifactId, segmentId)
  const ts = nowIso()
  db.prepare(`
    update transcript_segments
    set deleted_at = ?, deleted_by_admin_user_id = ?, text = ''
    where room_id = ? and artifact_id = ? and id = ?
  `).run(ts, actorId, roomId, artifactId, segmentId)
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'transcript.segment_deleted',
    resourceType: 'transcript_segment',
    resourceId: segmentId,
    roomId,
    ip,
    userAgent,
    metadata: { artifactId, segmentId },
  })
  return transcriptSegmentProjection(requireTranscriptSegment(roomId, artifactId, segmentId), { admin: true })
}

export function deleteTranscriptArtifact({ roomId, artifactId, actorId, ip, userAgent }) {
  requireTranscriptArtifact(roomId, artifactId)
  const ts = nowIso()
  db.prepare(`
    update transcript_artifacts
    set status = 'deleted', deleted_at = ?, deleted_by_admin_user_id = ?, updated_at = ?
    where room_id = ? and id = ?
  `).run(ts, actorId, ts, roomId, artifactId)
  db.prepare(`
    update transcript_segments
    set deleted_at = coalesce(deleted_at, ?), deleted_by_admin_user_id = coalesce(deleted_by_admin_user_id, ?), text = ''
    where room_id = ? and artifact_id = ?
  `).run(ts, actorId, roomId, artifactId)
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'transcript.artifact_deleted',
    resourceType: 'transcript_artifact',
    resourceId: artifactId,
    roomId,
    ip,
    userAgent,
  })
  return { deleted: true, artifactId }
}

function ensureRoomRecordingSettings(roomId) {
  requireRoom(roomId)
  const existing = db.prepare('select * from room_recording_settings where room_id = ?').get(roomId)
  if (existing) return existing
  const ts = nowIso()
  db.prepare(`
    insert into room_recording_settings (
      room_id, recording_enabled, mock_recording_enabled,
      participant_notice, notice_version, retention_days, created_at, updated_at
    )
    values (?, 0, 0, ?, 'local-v1', 7, ?, ?)
  `).run(roomId, 'Local mock recording metadata is off for this room. No audio or video is captured or stored.', ts, ts)
  return db.prepare('select * from room_recording_settings where room_id = ?').get(roomId)
}

function recordingSettingsView(row) {
  return {
    recordingEnabled: Boolean(row.recording_enabled),
    mockRecordingEnabled: Boolean(row.mock_recording_enabled),
    participantNotice: row.participant_notice,
    noticeVersion: row.notice_version,
    retentionDays: Number(row.retention_days || 7),
    updatedAt: row.updated_at,
    mediaCaptured: false,
    storageProvider: 'none',
  }
}

function participantRecordingSettingsView(row) {
  return {
    recordingEnabled: Boolean(row.recording_enabled),
    participantNotice: row.participant_notice,
    statusLabel: row.recording_enabled ? 'local_mock_metadata_notice' : 'recording_metadata_disabled',
  }
}

function recordingRetentionExpiry(settings) {
  const days = Number(settings?.retention_days || 0)
  return days > 0 ? futureIso(days * 24 * 60 * 60 * 1000) : null
}

function recordingConsentFor(roomId, participantId, noticeVersion) {
  return db.prepare(`
    select * from participant_recording_consents
    where room_id = ? and participant_id = ? and notice_version = ?
  `).get(roomId, participantId, noticeVersion)
}

function recordingConsentState(settings, participantId) {
  if (!settings.recording_enabled) return 'not_required'
  const consent = recordingConsentFor(settings.room_id, participantId, settings.notice_version)
  return consent?.status || 'notice_required'
}

function requireRecordingEnabled(settings) {
  if (!settings.recording_enabled) {
    const error = new Error('Recording metadata is disabled for this room.')
    error.code = 'recording_disabled'
    error.status = 409
    throw error
  }
}

function requireMockRecordingEnabled(settings) {
  if (!settings.mock_recording_enabled) {
    const error = new Error('Local mock recording metadata controls are disabled for this room.')
    error.code = 'mock_recording_disabled'
    error.status = 409
    throw error
  }
}

function requireRecordingArtifact(roomId, recordingId) {
  const row = db.prepare('select * from recording_artifacts where room_id = ? and id = ?').get(roomId, recordingId)
  if (!row || row.status === 'deleted') {
    const error = new Error('Recording metadata artifact not found.')
    error.code = 'recording_not_found'
    error.status = 404
    throw error
  }
  return row
}

function recordingArtifactProjection(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    source: row.source,
    status: row.status,
    storageProvider: 'none',
    byteSize: Number(row.byte_size || 0),
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    finalizedAt: row.finalized_at,
    retentionExpiresAt: row.retention_expires_at,
    deletedAt: row.deleted_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mediaCaptured: false,
  }
}

function recordRecordingArtifactEvent({ artifactId, roomId, action, actorType, actorId = null, metadata = {} }) {
  db.prepare(`
    insert into recording_artifact_events (
      id, recording_artifact_id, room_id, action, actor_type, actor_id, metadata_json, created_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomId(12), artifactId, roomId, action, actorType, actorId, JSON.stringify(metadata || {}), nowIso())
}

export function participantRecordingStatus({ roomId, participantId, accessToken }) {
  const auth = authenticateAccess({ roomId, participantId, accessToken })
  const settings = ensureRoomRecordingSettings(roomId)
  return {
    settings: participantRecordingSettingsView(settings),
    consent: {
      status: recordingConsentState(settings, auth.access.participant_id),
      noticeVersion: settings.notice_version,
    },
  }
}

export function recordParticipantRecordingConsent({ roomId, participantId, accessToken, status, ip, userAgent }) {
  const auth = authenticateAccess({ roomId, participantId, accessToken })
  const settings = ensureRoomRecordingSettings(roomId)
  requireRecordingEnabled(settings)
  const normalized = String(status || '').trim()
  if (!['acknowledged', 'declined'].includes(normalized)) {
    const error = new Error('Recording consent status must be acknowledged or declined.')
    error.code = 'invalid_recording_consent'
    error.status = 400
    throw error
  }
  const ts = nowIso()
  const id = randomId(12)
  db.prepare(`
    insert into participant_recording_consents (
      id, room_id, participant_id, access_token_hash, status, notice_version, created_at, updated_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(room_id, participant_id, notice_version) do update set
      status = excluded.status,
      access_token_hash = excluded.access_token_hash,
      updated_at = excluded.updated_at
  `).run(id, roomId, auth.access.participant_id, tokenHash(accessToken), normalized, settings.notice_version, ts, ts)
  recordAuditEvent({
    actorType: 'participant',
    actorId: auth.access.participant_id,
    action: 'recording.consent_recorded',
    resourceType: 'recording_consent',
    resourceId: auth.access.participant_id,
    roomId,
    ip,
    userAgent,
    metadata: { status: normalized, noticeVersion: settings.notice_version },
  })
  return participantRecordingStatus({ roomId, participantId, accessToken })
}

export function configureRecordingSettings({ roomId, actorId, recordingEnabled, mockRecordingEnabled, notice, retentionDays, ip, userAgent }) {
  return withTransaction(() => {
    ensureRoomRecordingSettings(roomId)
    const ts = nowIso()
    const nextRecordingEnabled = Boolean(recordingEnabled)
    const nextMockRecordingEnabled = Boolean(mockRecordingEnabled) && nextRecordingEnabled
    const nextNotice = String(notice || (nextRecordingEnabled
      ? 'Local mock recording metadata is enabled for this room. No audio or video is captured or stored.'
      : 'Local mock recording metadata is off for this room. No audio or video is captured or stored.')).slice(0, 360)
    const days = Math.max(1, Math.min(30, Number(retentionDays || 7)))
    const noticeVersion = `local-v${createHash('sha256').update(`${nextNotice}:${nextRecordingEnabled}:${nextMockRecordingEnabled}`).digest('hex').slice(0, 12)}`
    db.prepare(`
      update room_recording_settings
      set recording_enabled = ?, mock_recording_enabled = ?,
        participant_notice = ?, notice_version = ?, retention_days = ?, updated_at = ?
      where room_id = ?
    `).run(
      nextRecordingEnabled ? 1 : 0,
      nextMockRecordingEnabled ? 1 : 0,
      nextNotice,
      noticeVersion,
      days,
      ts,
      roomId,
    )
    recordAuditEvent({
      actorType: 'admin',
      actorId,
      action: 'recording.settings_configured',
      resourceType: 'recording_settings',
      resourceId: roomId,
      roomId,
      ip,
      userAgent,
      metadata: {
        recordingEnabled: nextRecordingEnabled,
        mockRecordingEnabled: nextMockRecordingEnabled,
        storageProvider: 'none',
      },
    })
    return recordingSettingsView(ensureRoomRecordingSettings(roomId))
  })
}

export function adminRecordingSettings({ roomId }) {
  return recordingSettingsView(ensureRoomRecordingSettings(roomId))
}

function assertRoomCanRecord(roomId) {
  const room = requireRoom(roomId)
  assertRoomJoinable(room)
}

export function startMockRecording({ roomId, actorId, ip, userAgent }) {
  assertRoomCanRecord(roomId)
  const settings = ensureRoomRecordingSettings(roomId)
  requireRecordingEnabled(settings)
  requireMockRecordingEnabled(settings)
  const id = randomId(12)
  const ts = nowIso()
  db.prepare(`
    insert into recording_artifacts (
      id, room_id, source, status, storage_provider, storage_key, byte_size,
      started_at, retention_expires_at, metadata_json, created_at, updated_at
    )
    values (?, ?, 'mock_metadata', 'mock_active', 'none', null, 0, ?, ?, '{}', ?, ?)
  `).run(id, roomId, ts, recordingRetentionExpiry(settings), ts, ts)
  recordRecordingArtifactEvent({
    artifactId: id,
    roomId,
    action: 'recording.mock_started',
    actorType: 'admin',
    actorId,
    metadata: { storageProvider: 'none' },
  })
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'recording.mock_started',
    resourceType: 'recording_artifact',
    resourceId: id,
    roomId,
    ip,
    userAgent,
    metadata: { source: 'mock_metadata', storageProvider: 'none', mediaCaptured: false },
  })
  return recordingArtifactProjection(requireRecordingArtifact(roomId, id))
}

export function finalizeMockRecording({ roomId, recordingId, actorId, durationMs, ip, userAgent }) {
  assertRoomCanRecord(roomId)
  const artifact = requireRecordingArtifact(roomId, recordingId)
  if (artifact.status !== 'mock_active') {
    const error = new Error('Mock recording metadata artifact is not active.')
    error.code = 'recording_not_active'
    error.status = 409
    throw error
  }
  const ts = nowIso()
  const duration = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(durationMs || 0)))
  db.prepare(`
    update recording_artifacts
    set status = 'mock_finalized', finalized_at = ?, duration_ms = ?, storage_provider = 'none',
      storage_key = null, byte_size = 0, updated_at = ?
    where room_id = ? and id = ?
  `).run(ts, duration, ts, roomId, recordingId)
  recordRecordingArtifactEvent({ artifactId: recordingId, roomId, action: 'recording.mock_finalized', actorType: 'admin', actorId, metadata: { durationMs: duration } })
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'recording.mock_finalized',
    resourceType: 'recording_artifact',
    resourceId: recordingId,
    roomId,
    ip,
    userAgent,
    metadata: { durationMs: duration, storageProvider: 'none' },
  })
  return recordingArtifactProjection(requireRecordingArtifact(roomId, recordingId))
}

export function failMockRecording({ roomId, recordingId, actorId, reason, ip, userAgent }) {
  assertRoomCanRecord(roomId)
  const artifact = requireRecordingArtifact(roomId, recordingId)
  if (artifact.status !== 'mock_active') {
    const error = new Error('Mock recording metadata artifact is not active.')
    error.code = 'recording_not_active'
    error.status = 409
    throw error
  }
  const ts = nowIso()
  const failureReason = String(reason || 'mock_failure').trim().slice(0, 120) || 'mock_failure'
  db.prepare(`
    update recording_artifacts
    set status = 'mock_failed', failure_reason = ?, storage_provider = 'none',
      storage_key = null, byte_size = 0, updated_at = ?
    where room_id = ? and id = ?
  `).run(failureReason, ts, roomId, recordingId)
  recordRecordingArtifactEvent({ artifactId: recordingId, roomId, action: 'recording.mock_failed', actorType: 'admin', actorId, metadata: { reason: failureReason } })
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'recording.mock_failed',
    resourceType: 'recording_artifact',
    resourceId: recordingId,
    roomId,
    ip,
    userAgent,
    metadata: { reason: failureReason, storageProvider: 'none' },
  })
  return recordingArtifactProjection(requireRecordingArtifact(roomId, recordingId))
}

export function listRoomRecordings({ roomId, actorId, ip, userAgent, limit = 50 }) {
  ensureRoomRecordingSettings(roomId)
  const capped = Math.max(1, Math.min(100, Number(limit || 50)))
  const artifacts = db.prepare(`
    select * from recording_artifacts
    where room_id = ? and status != 'deleted'
    order by created_at desc
    limit ?
  `).all(roomId, capped).map((row) => recordingArtifactProjection(row))
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'recording.viewed',
    resourceType: 'recording_artifact',
    roomId,
    ip,
    userAgent,
    metadata: { count: artifacts.length, storageProvider: 'none' },
  })
  return { settings: recordingSettingsView(ensureRoomRecordingSettings(roomId)), artifacts }
}

export function getRoomRecording({ roomId, recordingId, actorId, ip, userAgent }) {
  const artifact = requireRecordingArtifact(roomId, recordingId)
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'recording.viewed',
    resourceType: 'recording_artifact',
    resourceId: recordingId,
    roomId,
    ip,
    userAgent,
    metadata: { storageProvider: 'none' },
  })
  return { artifact: recordingArtifactProjection(artifact) }
}

export function deleteRecordingArtifact({ roomId, recordingId, actorId, ip, userAgent }) {
  requireRecordingArtifact(roomId, recordingId)
  const ts = nowIso()
  db.prepare(`
    update recording_artifacts
    set status = 'deleted', storage_provider = 'none', storage_key = null, byte_size = 0,
      deleted_at = ?, deleted_by_admin_user_id = ?, updated_at = ?
    where room_id = ? and id = ?
  `).run(ts, actorId, ts, roomId, recordingId)
  recordRecordingArtifactEvent({ artifactId: recordingId, roomId, action: 'recording.deleted', actorType: 'admin', actorId })
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'recording.deleted',
    resourceType: 'recording_artifact',
    resourceId: recordingId,
    roomId,
    ip,
    userAgent,
    metadata: { storageProvider: 'none' },
  })
  return { deleted: true, recordingId }
}

const allowedEmbedScopes = new Set(['embed:status', 'embed:join'])
const embedSessionTtlMs = readLimit('WEBRTC_EMBED_SESSION_TTL_MS', 10 * 60_000)

function normalizeLocalEmbedOrigin(origin) {
  let parsed
  try {
    parsed = new URL(String(origin || '').trim())
  } catch {
    const error = new Error('Embed origin must be an exact local http(s) origin.')
    error.code = 'invalid_embed_origin'
    error.status = 400
    throw error
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    const error = new Error('Embed origin must be an exact local http(s) origin.')
    error.code = 'invalid_embed_origin'
    error.status = 400
    throw error
  }
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    const error = new Error('Only explicit local embed origins are approved in this slice.')
    error.code = 'invalid_embed_origin'
    error.status = 400
    throw error
  }
  return parsed.origin
}

function normalizeEmbedOrigins(origins) {
  if (!Array.isArray(origins)) return []
  const normalized = []
  for (const origin of origins) {
    const value = normalizeLocalEmbedOrigin(origin)
    if (!normalized.includes(value)) normalized.push(value)
  }
  return normalized.slice(0, 12)
}

function normalizeEmbedScopes(scope) {
  if (!Array.isArray(scope)) return ['embed:status']
  const normalized = [...new Set(scope.map((item) => String(item || '').trim()).filter((item) => allowedEmbedScopes.has(item)))]
  return normalized.length ? normalized : ['embed:status']
}

function ensureRoomEmbedSettings(roomId) {
  requireRoom(roomId)
  const existing = db.prepare('select * from room_embed_settings where room_id = ?').get(roomId)
  if (existing) return existing
  const ts = nowIso()
  db.prepare(`
    insert into room_embed_settings (room_id, embed_enabled, allowed_origins_json, created_at, updated_at)
    values (?, 0, '[]', ?, ?)
  `).run(roomId, ts, ts)
  return db.prepare('select * from room_embed_settings where room_id = ?').get(roomId)
}

function embedSettingsProjection(row) {
  return {
    embedEnabled: Boolean(row.embed_enabled),
    allowedOrigins: parseJsonArray(row.allowed_origins_json, []),
    updatedAt: row.updated_at,
  }
}

function embedSessionProjection(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    participantId: row.participant_id,
    allowedOrigin: row.allowed_origin,
    scope: parseJsonArray(row.scope_json, []),
    expiresAt: row.expires_at,
    exchangedAt: row.exchanged_at,
    revokedAt: row.revoked_at,
    createdByType: row.created_by_type,
    createdAt: row.created_at,
  }
}

function recordEmbedOriginEvent({ roomId = null, sessionId = null, origin = null, eventType, reason }) {
  db.prepare(`
    insert into embed_origin_events (id, room_id, embed_session_id, origin_hash, event_type, reason, created_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `).run(randomId(12), roomId, sessionId, hashAuditValue(origin), eventType, String(reason || '').slice(0, 80), nowIso())
}

function requireEmbedEnabled(roomId) {
  const settings = ensureRoomEmbedSettings(roomId)
  if (!settings.embed_enabled) {
    const error = new Error('Embed is disabled for this room.')
    error.code = 'embed_disabled'
    error.status = 409
    throw error
  }
  return settings
}

export function frameAncestorsForEmbedRoom(roomId) {
  try {
    const settings = ensureRoomEmbedSettings(roomId)
    if (!settings.embed_enabled) return []
    return parseJsonArray(settings.allowed_origins_json, [])
  } catch {
    return []
  }
}

export function configureRoomEmbedSettings({ roomId, actorId, enabled, allowedOrigins, ip, userAgent }) {
  return withTransaction(() => {
    ensureRoomEmbedSettings(roomId)
    const origins = normalizeEmbedOrigins(allowedOrigins)
    const nextEnabled = Boolean(enabled) && origins.length > 0
    const ts = nowIso()
    db.prepare(`
      update room_embed_settings
      set embed_enabled = ?, allowed_origins_json = ?, updated_at = ?
      where room_id = ?
    `).run(nextEnabled ? 1 : 0, JSON.stringify(origins), ts, roomId)
    recordAuditEvent({
      actorType: 'admin',
      actorId,
      action: 'embed.settings_configured',
      resourceType: 'embed_settings',
      resourceId: roomId,
      roomId,
      ip,
      userAgent,
      metadata: { embedEnabled: nextEnabled, originCount: origins.length },
    })
    return embedSettingsProjection(ensureRoomEmbedSettings(roomId))
  })
}

export function adminRoomEmbed({ roomId, actorId, ip, userAgent, limit = 50 }) {
  const settings = ensureRoomEmbedSettings(roomId)
  const capped = Math.max(1, Math.min(100, Number(limit || 50)))
  const sessions = db.prepare(`
    select * from embed_sessions
    where room_id = ?
    order by created_at desc
    limit ?
  `).all(roomId, capped).map(embedSessionProjection)
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'embed.viewed',
    resourceType: 'embed_session',
    roomId,
    ip,
    userAgent,
    metadata: { count: sessions.length },
  })
  return { settings: embedSettingsProjection(settings), sessions }
}

export function issueEmbedSession({ roomId, actorId, allowedOrigin, scope, ttlMs, ip, userAgent }) {
  return withTransaction(() => {
    const settings = requireEmbedEnabled(roomId)
    const origin = normalizeLocalEmbedOrigin(allowedOrigin)
    const allowedOrigins = parseJsonArray(settings.allowed_origins_json, [])
    if (!allowedOrigins.includes(origin)) {
      recordEmbedOriginEvent({ roomId, origin, eventType: 'embed.origin_denied', reason: 'origin_not_allowed' })
      const error = new Error('Embed origin is not allowed for this room.')
      error.code = 'origin_not_allowed'
      error.status = 403
      throw error
    }
    const id = randomId(12)
    const bootstrapToken = randomBytes(32).toString('base64url')
    const normalizedScope = normalizeEmbedScopes(scope)
    const ts = nowIso()
    const ttl = Math.max(60_000, Math.min(embedSessionTtlMs, Number(ttlMs || embedSessionTtlMs)))
    db.prepare(`
      insert into embed_sessions (
        id, room_id, bootstrap_token_hash, scope_json, allowed_origin, expires_at,
        created_by_type, created_by_id, created_at
      )
      values (?, ?, ?, ?, ?, ?, 'admin', ?, ?)
    `).run(id, roomId, tokenHash(bootstrapToken), JSON.stringify(normalizedScope), origin, futureIso(ttl), actorId, ts)
    recordAuditEvent({
      actorType: 'admin',
      actorId,
      action: 'embed.session_issued',
      resourceType: 'embed_session',
      resourceId: id,
      roomId,
      ip,
      userAgent,
      metadata: { originHash: hashAuditValue(origin), scope: normalizedScope, ttlMs: ttl },
    })
    return { session: embedSessionProjection(db.prepare('select * from embed_sessions where id = ?').get(id)), bootstrapToken }
  })
}

function embedAuthError(code = 'invalid_embed_session', status = 401, message = 'Embed session is invalid or expired.') {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

export function exchangeEmbedSession({ bootstrapToken, origin, ip, userAgent }) {
  const normalizedOrigin = normalizeLocalEmbedOrigin(origin)
  const row = db.prepare('select * from embed_sessions where bootstrap_token_hash = ?').get(tokenHash(bootstrapToken))
  if (!row) {
    recordEmbedOriginEvent({ origin: normalizedOrigin, eventType: 'embed.exchange_denied', reason: 'invalid_bootstrap' })
    throw embedAuthError()
  }
  if (row.allowed_origin !== normalizedOrigin) {
    recordEmbedOriginEvent({ roomId: row.room_id, sessionId: row.id, origin: normalizedOrigin, eventType: 'embed.origin_denied', reason: 'origin_not_allowed' })
    throw embedAuthError('origin_not_allowed', 403, 'Embed origin is not allowed for this session.')
  }
  if (row.revoked_at || row.exchanged_at || new Date(row.expires_at).getTime() <= Date.now()) {
    recordEmbedOriginEvent({ roomId: row.room_id, sessionId: row.id, origin: normalizedOrigin, eventType: 'embed.exchange_denied', reason: row.revoked_at ? 'revoked' : row.exchanged_at ? 'replayed' : 'expired' })
    throw embedAuthError()
  }
  requireEmbedEnabled(row.room_id)
  const sessionToken = randomBytes(32).toString('base64url')
  db.prepare('update embed_sessions set session_token_hash = ?, exchanged_at = ? where id = ?')
    .run(tokenHash(sessionToken), nowIso(), row.id)
  recordAuditEvent({
    actorType: 'embed',
    actorId: row.id,
    action: 'embed.session_exchanged',
    resourceType: 'embed_session',
    resourceId: row.id,
    roomId: row.room_id,
    ip,
    userAgent,
    metadata: { originHash: hashAuditValue(normalizedOrigin) },
  })
  const session = db.prepare('select * from embed_sessions where id = ?').get(row.id)
  return { session: embedSessionProjection(session), sessionToken }
}

function requireEmbedSession({ roomId, sessionId, sessionToken, origin, requiredScope = 'embed:status' }) {
  const normalizedOrigin = normalizeLocalEmbedOrigin(origin)
  const row = db.prepare('select * from embed_sessions where id = ?').get(String(sessionId || ''))
  if (!row || row.room_id !== roomId || !sessionToken || row.session_token_hash !== tokenHash(sessionToken)) {
    recordEmbedOriginEvent({ roomId, sessionId, origin: normalizedOrigin, eventType: 'embed.auth_denied', reason: 'invalid_session' })
    throw embedAuthError()
  }
  if (row.allowed_origin !== normalizedOrigin) {
    recordEmbedOriginEvent({ roomId, sessionId, origin: normalizedOrigin, eventType: 'embed.origin_denied', reason: 'origin_not_allowed' })
    throw embedAuthError('origin_not_allowed', 403, 'Embed origin is not allowed for this session.')
  }
  if (row.revoked_at || !row.exchanged_at || new Date(row.expires_at).getTime() <= Date.now()) {
    recordEmbedOriginEvent({ roomId, sessionId, origin: normalizedOrigin, eventType: 'embed.auth_denied', reason: row.revoked_at ? 'revoked' : !row.exchanged_at ? 'not_exchanged' : 'expired' })
    throw embedAuthError()
  }
  const scope = parseJsonArray(row.scope_json, [])
  if (!scope.includes(requiredScope)) {
    recordEmbedOriginEvent({ roomId, sessionId, origin: normalizedOrigin, eventType: 'embed.scope_denied', reason: requiredScope })
    throw embedAuthError('embed_scope_denied', 403, 'Embed session scope is not allowed.')
  }
  return row
}

function embedSafeRoomProjection(room) {
  return {
    id: room.id,
    displayName: room.display_name,
    status: room.status,
    waitingRoomEnabled: Boolean(room.waiting_room_enabled),
  }
}

export function embedRoomStatus({ roomId, sessionId, sessionToken, origin }) {
  requireEmbedSession({ roomId, sessionId, sessionToken, origin, requiredScope: 'embed:status' })
  const room = requireRoom(roomId)
  assertRoomJoinable(room)
  return { room: embedSafeRoomProjection(room), session: { id: sessionId } }
}

export function embedRoomAccess({ roomId, sessionId, sessionToken, origin, password, activeCount, ip }) {
  const session = requireEmbedSession({ roomId, sessionId, sessionToken, origin, requiredScope: 'embed:join' })
  const result = validatePasswordAndIssueAccess({ roomId, password, ip, activeCount })
  db.prepare('update embed_sessions set participant_id = ? where id = ?').run(result.access?.participantId || null, session.id)
  recordAuditEvent({
    actorType: 'embed',
    actorId: session.id,
    action: 'embed.join_bootstrap',
    resourceType: 'embed_session',
    resourceId: session.id,
    roomId,
    ip,
    metadata: { waiting: Boolean(result.waiting) },
  })
  return {
    room: embedSafeRoomProjection(getRoom(roomId)),
    access: result.access,
    waiting: result.waiting,
  }
}

export function revokeEmbedSession({ roomId, sessionId, actorId, ip, userAgent }) {
  const row = db.prepare('select * from embed_sessions where room_id = ? and id = ?').get(roomId, sessionId)
  if (!row) throw embedAuthError('embed_session_not_found', 404, 'Embed session not found.')
  db.prepare('update embed_sessions set revoked_at = ? where id = ? and revoked_at is null').run(nowIso(), sessionId)
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'embed.session_revoked',
    resourceType: 'embed_session',
    resourceId: sessionId,
    roomId,
    ip,
    userAgent,
  })
  return { revoked: true, sessionId }
}

const allowedMetadataKeys = new Set(['project', 'ticket', 'customer', 'sessionType', 'priority', 'tags'])

function normalizeRoomMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}
  const normalized = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (!allowedMetadataKeys.has(key)) continue
    if (Array.isArray(value)) {
      const items = value.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
      if (items.length) normalized[key] = items
      continue
    }
    const text = String(value || '').trim().slice(0, 160)
    if (text) normalized[key] = text
  }
  return normalized
}

function metadataTextIndex(metadata) {
  return Object.entries(metadata)
    .map(([key, value]) => `${key}:${Array.isArray(value) ? value.join(',') : value}`)
    .join(' ')
    .slice(0, 1000)
}

function normalizeKey(value, code = 'invalid_key') {
  const key = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(key)) {
    const error = new Error('Key must be 2-48 lowercase letters, numbers, dashes, or underscores.')
    error.code = code
    error.status = 400
    throw error
  }
  return key
}

function normalizeScope(scope, allowedScopes) {
  if (!Array.isArray(scope)) return []
  return [...new Set(scope.map((item) => String(item || '').trim()).filter((item) => allowedScopes.has(item)))]
}

function normalizeAllowedOrigins(origins) {
  if (!Array.isArray(origins)) return []
  return [...new Set(origins.map((origin) => {
    try {
      const url = new URL(String(origin || '').trim())
      if (!['http:', 'https:'].includes(url.protocol)) return ''
      return url.origin
    } catch {
      return ''
    }
  }).filter(Boolean))].slice(0, 12)
}

function normalizeExternalLink(link = {}) {
  const systemKey = normalizeKey(link.systemKey, 'invalid_system_key')
  const objectType = String(link.objectType || '').trim().slice(0, 48)
  const objectId = String(link.objectId || '').trim().slice(0, 96)
  if (!objectType || !/^[a-zA-Z0-9_.:-]+$/.test(objectType) || !objectId) {
    const error = new Error('External link requires objectType and objectId.')
    error.code = 'invalid_external_link'
    error.status = 400
    throw error
  }
  const metadata = normalizeRoomMetadata(link.metadata)
  return { systemKey, objectType, objectId, metadata }
}

function normalizeExternalIdentity(identity = {}, systemKey) {
  if (!identity || typeof identity !== 'object') return null
  const externalUserId = String(identity.externalUserId || '').trim().slice(0, 96)
  if (!externalUserId) return null
  return {
    systemKey,
    externalUserId,
    displayName: String(identity.displayName || '').trim().slice(0, 120),
    emailHash: String(identity.emailHash || '').trim().slice(0, 128),
    metadata: normalizeRoomMetadata(identity.metadata),
  }
}

export function recordAuditEvent({
  actorType,
  actorId = null,
  action,
  resourceType,
  resourceId = null,
  roomId = null,
  ip = null,
  userAgent = null,
  metadata = {},
}) {
  db.prepare(`
    insert into audit_events (id, actor_type, actor_id, action, resource_type, resource_id, room_id, ip_hash, user_agent_hash, metadata_json, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomId(12),
    actorType,
    actorId,
    action,
    resourceType,
    resourceId,
    roomId,
    hashAuditValue(ip),
    hashAuditValue(userAgent),
    JSON.stringify(metadata || {}),
    nowIso(),
  )
}

function recordLifecycleEvent({
  roomId,
  fromStatus,
  toStatus,
  actorType,
  actorId = null,
  reason = '',
  metadata = {},
  createdAt = nowIso(),
}) {
  db.prepare(`
    insert into room_lifecycle_events (
      id, room_id, from_status, to_status, actor_type, actor_id, reason, metadata_json, created_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomId(12),
    roomId,
    fromStatus,
    toStatus,
    actorType,
    actorId,
    String(reason || '').slice(0, 160),
    JSON.stringify(metadata || {}),
    createdAt,
  )
}

function withTransaction(fn) {
  db.exec('begin immediate')
  try {
    const result = fn()
    db.exec('commit')
    return result
  } catch (error) {
    db.exec('rollback')
    throw error
  }
}

function transitionError(message, code = 'invalid_room_transition') {
  const error = new Error(message)
  error.code = code
  error.status = 409
  return error
}

function requireRoom(roomId) {
  const room = getRoom(roomId)
  if (!room) {
    const error = new Error('Room not found')
    error.code = 'room_not_found'
    error.status = 404
    throw error
  }
  return room
}

function validateFutureIso(value, code = 'invalid_expiry') {
  const timestamp = Date.parse(value || '')
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    const error = new Error('Expiry must be a future timestamp.')
    error.code = code
    error.status = 400
    throw error
  }
  return new Date(timestamp).toISOString()
}

export function createRoom({ displayName, password, origin, metadata, actorType = 'participant', actorId = 'host-bootstrap' }) {
  if (!password || String(password).length < 4) {
    const error = new Error('Room password must be at least 4 characters.')
    error.code = 'weak_password'
    error.status = 400
    throw error
  }
  const id = randomId(8)
  const salt = randomBytes(16).toString('base64url')
  const createdAt = nowIso()
  const expiresAt = futureIso(roomTtlHours * 60 * 60 * 1000)
  const roomMetadata = normalizeRoomMetadata(metadata)
  db.prepare(`
    insert into rooms (
      id, display_name, password_hash, password_salt, created_at, expires_at,
      max_participants, status, waiting_room_enabled, auto_admit_first_guest,
      metadata_json, metadata_text_index
    )
    values (?, ?, ?, ?, ?, ?, 2, 'active', 0, 1, ?, ?)
  `).run(
    id,
    displayName || 'Untitled room',
    hashPassword(password, salt),
    salt,
    createdAt,
    expiresAt,
    JSON.stringify(roomMetadata),
    metadataTextIndex(roomMetadata),
  )
  for (const [key, value] of Object.entries(roomMetadata)) {
    db.prepare(`
      insert into room_metadata (room_id, key, value_json, value_text_index, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)
    `).run(id, key, JSON.stringify(value), Array.isArray(value) ? value.join(', ') : String(value), createdAt, createdAt)
  }
  recordAuditEvent({
    actorType,
    actorId,
    action: 'room.created',
    resourceType: 'room',
    resourceId: id,
    roomId: id,
    metadata: { hasMetadata: Object.keys(roomMetadata).length > 0 },
  })
  recordLifecycleEvent({
    roomId: id,
    fromStatus: null,
    toStatus: 'active',
    actorType,
    actorId,
    reason: 'created',
    createdAt,
  })
  const access = issueAccessToken({ roomId: id, role: 'host' })
  return {
    room: publicRoomView(getRoom(id)),
    shareUrl: `${origin || ''}/rooms/${id}`,
    access,
  }
}

export function getPublicRoom(roomId) {
  const room = getRoom(roomId)
  assertRoomJoinable(room)
  return publicRoomView(room)
}

export function issueAccessToken({ roomId, role, admissionStatus = 'admitted' }) {
  const token = randomBytes(32).toString('base64url')
  const participantId = randomId(10)
  const issuedAt = nowIso()
  const expiresAt = futureIso(15 * 60 * 1000)
  db.prepare(`
    insert into room_access_tokens (token_hash, room_id, participant_id, role, issued_at, expires_at, admission_status)
    values (?, ?, ?, ?, ?, ?, ?)
  `).run(tokenHash(token), roomId, participantId, role, issuedAt, expiresAt, admissionStatus)
  return { accessToken: token, participantId, role, expiresAt, admissionStatus }
}

export function validatePasswordAndIssueAccess({ roomId, password, ip, activeCount }) {
  const room = getRoom(roomId)
  assertRoomJoinable(room)
  if (activeCount >= room.max_participants) {
    const error = new Error('This room already has two participants.')
    error.code = 'room_full'
    error.status = 409
    throw error
  }
  checkRateLimit(roomId, ip)
  const candidate = hashPassword(password || '', room.password_salt)
  if (!constantEqual(candidate, room.password_hash)) {
    recordPasswordFailure(roomId, ip)
    const error = new Error('Incorrect room password.')
    error.code = 'wrong_password'
    error.status = 401
    throw error
  }
  clearPasswordFailures(roomId, ip)
  const admissionStatus = room.waiting_room_enabled && !room.auto_admit_first_guest ? 'waiting' : 'admitted'
  const access = issueAccessToken({ roomId, role: 'guest', admissionStatus })
  if (admissionStatus === 'waiting') {
    recordAuditEvent({
      actorType: 'participant',
      actorId: access.participantId,
      action: 'waiting_room.joined',
      resourceType: 'room_access_token',
      resourceId: access.participantId,
      roomId,
      ip,
    })
  }
  return {
    room: publicRoomView(room),
    access,
    waiting: admissionStatus === 'waiting',
  }
}

export function authenticateAccess({ roomId, participantId, accessToken }) {
  const room = getRoom(roomId)
  assertRoomJoinable(room)
  const row = db.prepare(`
    select * from room_access_tokens
    where token_hash = ? and room_id = ? and participant_id = ?
  `).get(tokenHash(accessToken || ''), roomId, participantId || '')
  if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) {
    const error = new Error('Room access expired or invalid.')
    error.code = 'invalid_access'
    error.status = 401
    throw error
  }
  if (row.admission_status === 'waiting') {
    const error = new Error('Waiting for host admission.')
    error.code = 'waiting_room_pending'
    error.status = 403
    throw error
  }
  if (row.admission_status === 'rejected' || row.admission_status === 'removed') {
    const error = new Error('Room access was not admitted.')
    error.code = 'access_not_admitted'
    error.status = 403
    throw error
  }
  return { room: publicRoomView(room), access: row }
}

export function admissionStatus({ roomId, participantId, accessToken }) {
  const room = getRoom(roomId)
  assertRoomJoinable(room)
  const row = db.prepare(`
    select role, admission_status as admissionStatus, revoked_at as revokedAt, expires_at as expiresAt
    from room_access_tokens
    where token_hash = ? and room_id = ? and participant_id = ?
  `).get(tokenHash(accessToken || ''), roomId, participantId)
  if (!row || row.revokedAt || Date.parse(row.expiresAt) <= Date.now()) {
    const error = new Error('Room access expired or invalid.')
    error.code = 'invalid_access'
    error.status = 401
    throw error
  }
  return { role: row.role, admissionStatus: row.admissionStatus }
}

export function listWaitingParticipants(roomId) {
  requireRoom(roomId)
  return db.prepare(`
    select participant_id as participantId, role, admission_status as admissionStatus,
      issued_at as issuedAt, admission_decided_at as admissionDecidedAt
    from room_access_tokens
    where room_id = ? and role = 'guest' and admission_status = 'waiting' and revoked_at is null
    order by issued_at asc
  `).all(roomId)
}

export function decideWaitingParticipant({ roomId, participantId, decision, actorType, actorId, ip, userAgent }) {
  return withTransaction(() => {
    requireRoom(roomId)
    if (!['admitted', 'rejected', 'removed'].includes(decision)) {
      const error = new Error('Unsupported waiting-room decision.')
      error.code = 'unsupported_waiting_room_decision'
      error.status = 400
      throw error
    }
    const row = db.prepare(`
      select * from room_access_tokens
      where room_id = ? and participant_id = ? and role = 'guest' and revoked_at is null
    `).get(roomId, participantId)
    if (!row) {
      const error = new Error('Participant not found.')
      error.code = 'participant_not_found'
      error.status = 404
      throw error
    }
    if (row.admission_status !== 'waiting') {
      throw transitionError('Participant is not waiting.')
    }
    const ts = nowIso()
    db.prepare(`
      update room_access_tokens
      set admission_status = ?, admission_decided_at = ?, admission_decided_by = ?,
        revoked_at = case when ? in ('rejected', 'removed') then ? else revoked_at end
      where token_hash = ?
    `).run(decision, ts, `${actorType}:${actorId || 'unknown'}`, decision, ts, row.token_hash)
    recordAuditEvent({
      actorType,
      actorId,
      action: decision === 'admitted' ? 'waiting_room.admitted' : `waiting_room.${decision}`,
      resourceType: 'room_access_token',
      resourceId: participantId,
      roomId,
      ip,
      userAgent,
      metadata: { decision },
    })
    return { participantId, admissionStatus: decision }
  })
}

export function endRoomForAll({ roomId, actorType, actorId, ip, userAgent, reason }) {
  return withTransaction(() => {
    const room = requireRoom(roomId)
    if (['ended', 'expired', 'disabled'].includes(room.status)) {
      throw transitionError('Room is already closed.')
    }
    const endedAt = nowIso()
    db.prepare(`
      update rooms
      set status = 'ended', ended_at = ?, ended_by_admin_user_id = ?, last_lifecycle_reason = ?
      where id = ?
    `).run(endedAt, actorType === 'admin' ? actorId : null, String(reason || '').slice(0, 160), roomId)
    db.prepare('update room_access_tokens set revoked_at = ? where room_id = ? and revoked_at is null').run(endedAt, roomId)
    recordLifecycleEvent({
      roomId,
      fromStatus: room.status,
      toStatus: 'ended',
      actorType,
      actorId,
      reason,
      createdAt: endedAt,
    })
    recordAuditEvent({
      actorType,
      actorId,
      action: 'room.ended_for_all',
      resourceType: 'room',
      resourceId: roomId,
      roomId,
      ip,
      userAgent,
      metadata: { reason: String(reason || '').slice(0, 160), fromStatus: room.status, toStatus: 'ended' },
    })
    return publicRoomView(getRoom(roomId))
  })
}

export function adminCreateRoom({ displayName, password, origin, metadata, actorId, ip, userAgent }) {
  const result = createRoom({ displayName, password, origin, metadata, actorType: 'admin', actorId })
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'room.admin_created',
    resourceType: 'room',
    resourceId: result.room.id,
    roomId: result.room.id,
    ip,
    userAgent,
    metadata: { hasMetadata: Boolean(metadata && Object.keys(normalizeRoomMetadata(metadata)).length) },
  })
  return { ...result, room: adminRoomView(getRoom(result.room.id)) }
}

function integrationClientView(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    systemKey: row.system_key || null,
    keyPrefix: row.key_prefix,
    status: row.status,
    allowedOrigins: parseJsonArray(row.allowed_origins_json, []),
    permissionScope: parseJsonArray(row.permission_scope_json, []),
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
  }
}

function externalSystemView(row) {
  if (!row) return null
  return {
    systemKey: row.system_key,
    name: row.name,
    status: row.status,
    metadataSchema: parseJsonObject(row.metadata_schema_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function externalIdentityView(row) {
  if (!row) return null
  return {
    id: row.id,
    systemKey: row.system_key,
    externalUserId: row.external_user_id,
    displayName: row.display_name,
    hasEmailHash: Boolean(row.email_hash),
    metadata: parseJsonObject(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function roomExternalLinkView(row) {
  if (!row) return null
  return {
    id: row.id,
    roomId: row.room_id,
    systemKey: row.system_key,
    objectType: row.object_type,
    objectId: row.object_id,
    externalIdentityId: row.external_identity_id,
    metadata: parseJsonObject(row.metadata_json, {}),
    createdAt: row.created_at,
  }
}

function webhookDeliveryView(row) {
  if (!row) return null
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    eventType: row.event_type,
    roomId: row.room_id,
    status: row.status,
    payloadDigest: row.payload_digest,
    signaturePreview: row.signature_preview,
    createdAt: row.created_at,
  }
}

function ensureExternalSystem({ systemKey, name }) {
  const ts = nowIso()
  db.prepare(`
    insert into external_systems (system_key, name, status, created_at, updated_at)
    values (?, ?, 'active', ?, ?)
    on conflict(system_key) do update set
      name = excluded.name,
      updated_at = excluded.updated_at
  `).run(systemKey, String(name || systemKey).trim().slice(0, 120), ts, ts)
  db.prepare(`
    insert into webhook_subscriptions (id, system_key, event_types_json, status, created_at, updated_at)
    values (?, ?, ?, 'local_mock', ?, ?)
    on conflict(id) do nothing
  `).run(`local_${systemKey}`, systemKey, JSON.stringify(['room.created']), ts, ts)
}

function upsertExternalIdentity(identity) {
  if (!identity) return null
  const ts = nowIso()
  const existing = db.prepare(`
    select id from external_identities where system_key = ? and external_user_id = ?
  `).get(identity.systemKey, identity.externalUserId)
  const id = existing?.id || randomId(12)
  db.prepare(`
    insert into external_identities (
      id, system_key, external_user_id, display_name, email_hash, metadata_json, created_at, updated_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(system_key, external_user_id) do update set
      display_name = excluded.display_name,
      email_hash = excluded.email_hash,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(
    id,
    identity.systemKey,
    identity.externalUserId,
    identity.displayName || null,
    identity.emailHash || null,
    JSON.stringify(identity.metadata || {}),
    ts,
    ts,
  )
  return id
}

function recordLocalWebhookAttempt({ systemKey, eventType, roomId, payload }) {
  const subscription = db.prepare(`
    select id from webhook_subscriptions
    where system_key = ? and status = 'local_mock'
    order by created_at asc
    limit 1
  `).get(systemKey)
  if (!subscription) return null
  const payloadJson = JSON.stringify(payload || {})
  const digest = createHash('sha256').update(payloadJson).digest('base64url')
  const signaturePreview = createHash('sha256').update(`local_mock:${digest}`).digest('base64url').slice(0, 24)
  db.prepare(`
    insert into webhook_delivery_attempts (
      id, subscription_id, event_type, room_id, status, payload_digest, signature_preview, created_at
    )
    values (?, ?, ?, ?, 'local_mock_recorded', ?, ?, ?)
  `).run(randomId(12), subscription.id, eventType, roomId, digest, signaturePreview, nowIso())
  return { payloadDigest: digest, signaturePreview }
}

export function createIntegrationClient({ name, systemKey, permissionScope = [], allowedOrigins = [], actorId, ip, userAgent }) {
  const normalizedSystemKey = normalizeKey(systemKey || name || 'local_integration', 'invalid_system_key')
  const allowed = new Set(['rooms:create', 'rooms:link', 'webhooks:local_record'])
  const scope = normalizeScope(permissionScope.length ? permissionScope : ['rooms:create', 'rooms:link'], allowed)
  if (!scope.length) {
    const error = new Error('Integration client requires at least one supported scope.')
    error.code = 'invalid_integration_scope'
    error.status = 400
    throw error
  }
  const safeOrigins = normalizeAllowedOrigins(allowedOrigins)
  const rawKey = `wrtc_${randomBytes(32).toString('base64url')}`
  const keyPrefix = rawKey.slice(0, 14)
  const ts = nowIso()
  ensureExternalSystem({ systemKey: normalizedSystemKey, name: name || normalizedSystemKey })
  const client = {
    id: randomId(12),
    name: String(name || normalizedSystemKey).trim().slice(0, 120),
    systemKey: normalizedSystemKey,
    keyHash: hashForStorage(rawKey),
    keyPrefix,
    status: 'active',
    allowedOrigins: safeOrigins,
    permissionScope: scope,
    createdAt: ts,
  }
  db.prepare(`
    insert into integration_clients (
      id, name, system_key, key_hash, key_prefix, status, allowed_origins_json, permission_scope_json, created_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    client.id,
    client.name,
    client.systemKey,
    client.keyHash,
    client.keyPrefix,
    client.status,
    JSON.stringify(client.allowedOrigins),
    JSON.stringify(client.permissionScope),
    client.createdAt,
  )
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'integration_client.created',
    resourceType: 'integration_client',
    resourceId: client.id,
    ip,
    userAgent,
    metadata: { systemKey: normalizedSystemKey, keyPrefix, scope },
  })
  return { client: integrationClientView({
    id: client.id,
    name: client.name,
    system_key: client.systemKey,
    key_prefix: client.keyPrefix,
    status: client.status,
    allowed_origins_json: JSON.stringify(client.allowedOrigins),
    permission_scope_json: JSON.stringify(client.permissionScope),
    created_at: client.createdAt,
    rotated_at: null,
  }), key: rawKey }
}

export function listIntegrationOverview() {
  return {
    clients: db.prepare(`
      select id, name, system_key, key_prefix, status, allowed_origins_json, permission_scope_json, created_at, rotated_at
      from integration_clients
      order by created_at desc
      limit 40
    `).all().map(integrationClientView),
    systems: db.prepare(`
      select system_key, name, status, metadata_schema_json, created_at, updated_at
      from external_systems
      order by updated_at desc
      limit 40
    `).all().map(externalSystemView),
    identities: db.prepare(`
      select id, system_key, external_user_id, display_name, email_hash, metadata_json, created_at, updated_at
      from external_identities
      order by updated_at desc
      limit 40
    `).all().map(externalIdentityView),
    roomLinks: db.prepare(`
      select id, room_id, system_key, object_type, object_id, external_identity_id, metadata_json, created_at
      from room_external_links
      order by created_at desc
      limit 40
    `).all().map(roomExternalLinkView),
    webhookAttempts: db.prepare(`
      select id, subscription_id, event_type, room_id, status, payload_digest, signature_preview, created_at
      from webhook_delivery_attempts
      order by created_at desc
      limit 40
    `).all().map(webhookDeliveryView),
  }
}

export function revokeIntegrationClient({ clientId, actorId, ip, userAgent }) {
  const row = db.prepare('select * from integration_clients where id = ?').get(clientId)
  if (!row) {
    const error = new Error('Integration client not found.')
    error.code = 'integration_client_not_found'
    error.status = 404
    throw error
  }
  db.prepare("update integration_clients set status = 'revoked', rotated_at = ? where id = ?").run(nowIso(), clientId)
  recordAuditEvent({
    actorType: 'admin',
    actorId,
    action: 'integration_client.revoked',
    resourceType: 'integration_client',
    resourceId: clientId,
    ip,
    userAgent,
    metadata: { keyPrefix: row.key_prefix, systemKey: row.system_key },
  })
  return integrationClientView(db.prepare(`
    select id, name, system_key, key_prefix, status, allowed_origins_json, permission_scope_json, created_at, rotated_at
    from integration_clients where id = ?
  `).get(clientId))
}

export function authenticateIntegrationClient({ apiKey, origin = '' }) {
  const candidates = db.prepare(`
    select * from integration_clients where status = 'active' order by created_at desc limit 100
  `).all()
  const client = candidates.find((row) => verifyStoredHash(apiKey || '', row.key_hash))
  if (!client) {
    const error = new Error('Invalid integration credentials.')
    error.code = 'invalid_integration_credentials'
    error.status = 401
    throw error
  }
  const allowedOrigins = parseJsonArray(client.allowed_origins_json, [])
  if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
    const error = new Error('Integration origin is not allowed.')
    error.code = 'origin_not_allowed'
    error.status = 403
    throw error
  }
  return integrationClientView(client)
}

export function requireIntegrationScope(client, scope) {
  if (!client.permissionScope.includes(scope)) {
    const error = new Error('Integration scope is not allowed.')
    error.code = 'integration_scope_denied'
    error.status = 403
    throw error
  }
}

export function integrationCreateRoom({ client, displayName, password, metadata, externalLink, externalIdentity, origin, ip, userAgent }) {
  requireIntegrationScope(client, 'rooms:create')
  const hasExternalLink = externalLink && typeof externalLink === 'object' && Object.keys(externalLink).length > 0
  if (hasExternalLink) requireIntegrationScope(client, 'rooms:link')
  return withTransaction(() => {
    const link = hasExternalLink ? normalizeExternalLink({ ...(externalLink || {}), systemKey: externalLink?.systemKey || client.systemKey }) : null
    let identityId = null
    if (link) {
      if (link.systemKey !== client.systemKey) {
        const error = new Error('Integration client cannot link another system.')
        error.code = 'integration_system_mismatch'
        error.status = 403
        throw error
      }
      const identity = normalizeExternalIdentity(externalIdentity, link.systemKey)
      ensureExternalSystem({ systemKey: link.systemKey, name: client.name })
      identityId = upsertExternalIdentity(identity)
    }
    const result = createRoom({
      displayName,
      password,
      metadata,
      origin,
      actorType: 'integration',
      actorId: client.id,
    })
    if (link) {
      db.prepare(`
        insert into room_external_links (
          id, room_id, system_key, object_type, object_id, external_identity_id, metadata_json, created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomId(12), result.room.id, link.systemKey, link.objectType, link.objectId, identityId, JSON.stringify(link.metadata), nowIso())
    }
    const webhook = link && client.permissionScope.includes('webhooks:local_record') ? recordLocalWebhookAttempt({
      systemKey: link.systemKey,
      eventType: 'room.created',
      roomId: result.room.id,
      payload: { event: 'room.created', roomId: result.room.id, systemKey: link.systemKey, objectType: link.objectType },
    }) : null
    recordAuditEvent({
      actorType: 'integration',
      actorId: client.id,
      action: 'integration.room_created',
      resourceType: 'room',
      resourceId: result.room.id,
      roomId: result.room.id,
      ip,
      userAgent,
      metadata: {
        systemKey: link?.systemKey || client.systemKey,
        objectType: link?.objectType || '',
        hasExternalLink: Boolean(link),
        hasIdentity: Boolean(identityId),
        webhookRecorded: Boolean(webhook),
      },
    })
    return {
      ...result,
      ...(link ? { externalLink: { ...link, externalIdentityId: identityId } } : {}),
      webhook,
    }
  })
}

export function updateRoomPolicy({ roomId, actorId, ip, userAgent, patch = {} }) {
  return withTransaction(() => {
    const room = requireRoom(roomId)
    const updates = []
    const values = []
    const metadata = {}
    if (Object.hasOwn(patch, 'expiresAt')) {
      updates.push('expires_at = ?')
      values.push(validateFutureIso(patch.expiresAt))
      metadata.expiresAtChanged = true
    }
    if (Object.hasOwn(patch, 'maxParticipants')) {
      const next = Number(patch.maxParticipants)
      if (!Number.isInteger(next) || next < 2 || next > 12) {
        const error = new Error('Max participants must be between 2 and 12.')
        error.code = 'invalid_max_participants'
        error.status = 400
        throw error
      }
      updates.push('max_participants = ?')
      values.push(next)
      metadata.maxParticipantsChanged = true
    }
    if (Object.hasOwn(patch, 'waitingRoomEnabled')) {
      updates.push('waiting_room_enabled = ?')
      values.push(patch.waitingRoomEnabled ? 1 : 0)
      metadata.waitingRoomChanged = true
    }
    if (Object.hasOwn(patch, 'autoAdmitFirstGuest')) {
      updates.push('auto_admit_first_guest = ?')
      values.push(patch.autoAdmitFirstGuest ? 1 : 0)
      metadata.autoAdmitChanged = true
    }
    if (!updates.length) return adminRoomView(room)
    values.push(roomId)
    db.prepare(`update rooms set ${updates.join(', ')} where id = ?`).run(...values)
    recordAuditEvent({
      actorType: 'admin',
      actorId,
      action: 'room.policy_updated',
      resourceType: 'room',
      resourceId: roomId,
      roomId,
      ip,
      userAgent,
      metadata,
    })
    return adminRoomView(getRoom(roomId))
  })
}

export function transitionRoomLifecycle({ roomId, command, actorType = 'admin', actorId, ip, userAgent, reason, expiresAt }) {
  return withTransaction(() => {
    const room = requireRoom(roomId)
    const ts = nowIso()
    const boundedReason = String(reason || '').slice(0, 160)
    let toStatus = room.status
    let action = ''
    let revoke = false
    let updates = []
    let values = []

    if (command === 'disable') {
      if (['ended', 'expired', 'disabled'].includes(room.status)) throw transitionError('Room cannot be disabled from its current state.')
      toStatus = 'disabled'
      action = 'room.disabled'
      revoke = true
      updates = ['status = ?', 'disabled_at = ?', 'last_lifecycle_reason = ?']
      values = [toStatus, ts, boundedReason]
    } else if (command === 'expire') {
      if (['ended', 'expired', 'disabled'].includes(room.status)) throw transitionError('Room cannot be expired from its current state.')
      toStatus = 'expired'
      action = 'room.expired'
      revoke = true
      updates = ['status = ?', 'expires_at = ?', 'last_lifecycle_reason = ?']
      values = [toStatus, ts, boundedReason]
    } else if (command === 'lock') {
      if (room.status !== 'active') throw transitionError('Only active rooms can be locked.')
      toStatus = 'locked'
      action = 'room.locked'
      updates = ['status = ?', 'locked_at = ?', 'last_lifecycle_reason = ?']
      values = [toStatus, ts, boundedReason]
    } else if (command === 'unlock') {
      if (room.status !== 'locked') throw transitionError('Only locked rooms can be unlocked.')
      if (Date.parse(room.expires_at) <= Date.now()) throw transitionError('Expired rooms cannot be unlocked.')
      toStatus = 'active'
      action = 'room.unlocked'
      updates = ['status = ?', 'locked_at = null', 'last_lifecycle_reason = ?']
      values = [toStatus, boundedReason]
    } else if (command === 'extend') {
      if (['ended', 'expired', 'disabled'].includes(room.status)) throw transitionError('Closed rooms cannot be extended.')
      const nextExpiry = validateFutureIso(expiresAt)
      toStatus = room.status
      action = 'room.extended'
      updates = ['expires_at = ?', 'status = ?', 'last_lifecycle_reason = ?']
      values = [nextExpiry, toStatus, boundedReason]
    } else {
      const error = new Error('Unsupported lifecycle command.')
      error.code = 'unsupported_lifecycle_command'
      error.status = 400
      throw error
    }

    db.prepare(`update rooms set ${updates.join(', ')} where id = ?`).run(...values, roomId)
    if (revoke) {
      db.prepare('update room_access_tokens set revoked_at = ? where room_id = ? and revoked_at is null').run(ts, roomId)
    }
    recordLifecycleEvent({
      roomId,
      fromStatus: room.status,
      toStatus,
      actorType,
      actorId,
      reason,
      metadata: command === 'extend' ? { expiresAt: validateFutureIso(expiresAt) } : {},
      createdAt: ts,
    })
    recordAuditEvent({
      actorType,
      actorId,
      action,
      resourceType: 'room',
      resourceId: roomId,
      roomId,
      ip,
      userAgent,
      metadata: { reason: boundedReason, fromStatus: room.status, toStatus },
    })
    return adminRoomView(getRoom(roomId))
  })
}

export function lifecycleEventsForRoom(roomId, limit = 60) {
  return db.prepare(`
    select id, from_status as fromStatus, to_status as toStatus, actor_type as actorType,
      actor_id as actorId, reason, metadata_json as metadataJson, created_at as createdAt
    from room_lifecycle_events
    where room_id = ?
    order by created_at desc
    limit ?
  `).all(roomId, limit).map((row) => ({
    ...row,
    metadata: parseJsonObject(row.metadataJson, {}),
    metadataJson: undefined,
  }))
}

export function markConnected({ roomId, participantId, role }) {
  const ts = nowIso()
  db.prepare(`
    insert into room_presence (room_id, participant_id, role, connected_at, last_seen_at, disconnected_at)
    values (?, ?, ?, ?, ?, null)
    on conflict(room_id, participant_id) do update set
      role = excluded.role,
      last_seen_at = excluded.last_seen_at,
      disconnected_at = null
  `).run(roomId, participantId, role, ts, ts)
}

export function markDisconnected({ roomId, participantId }) {
  db.prepare(`
    update room_presence
    set last_seen_at = ?, disconnected_at = ?
    where room_id = ? and participant_id = ?
  `).run(nowIso(), nowIso(), roomId, participantId)
}

export function revokeAccess({ accessToken }) {
  if (!accessToken) return
  db.prepare('update room_access_tokens set revoked_at = ? where token_hash = ?').run(nowIso(), tokenHash(accessToken))
}

export function listDebugRooms() {
  return db.prepare(`
    select id, display_name, created_at, expires_at, status, max_participants
    from rooms
    order by created_at desc
    limit 20
  `).all().map(adminRoomView)
}

export function resetForTests() {
  db.exec(`
    delete from admin_user_roles;
    delete from admin_sessions;
    delete from admin_users;
    delete from audit_events;
    delete from room_lifecycle_events;
    delete from embed_origin_events;
    delete from embed_sessions;
    delete from room_embed_settings;
    delete from recording_artifact_events;
    delete from recording_artifacts;
    delete from participant_recording_consents;
    delete from room_recording_settings;
    delete from transcript_segments;
    delete from transcript_artifacts;
    delete from participant_transcript_consents;
    delete from room_transcript_settings;
    delete from chat_messages;
    delete from room_chat_settings;
    delete from retention_policies;
    delete from webhook_delivery_attempts;
    delete from webhook_subscriptions;
    delete from agent_room_links;
    delete from agents;
    delete from room_external_links;
    delete from external_identities;
    delete from external_systems;
    delete from integration_clients;
    delete from room_metadata;
    delete from room_presence;
    delete from room_access_tokens;
    delete from rooms;
  `)
  passwordAttempts.clear()
  chatAttempts.clear()
  transcriptAttempts.clear()
}
