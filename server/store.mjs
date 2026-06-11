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

const db = new DatabaseSync(dbPath)
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

const passwordAttempts = new Map()
const passwordAttemptLimit = readLimit('WEBRTC_PASSWORD_ATTEMPT_LIMIT', 8)
const passwordAttemptWindowMs = readLimit('WEBRTC_PASSWORD_ATTEMPT_WINDOW_MS', 60_000)
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

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('base64url')
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('base64url')
}

function constantEqual(a, b) {
  const left = Buffer.from(a || '')
  const right = Buffer.from(b || '')
  return left.length === right.length && timingSafeEqual(left, right)
}

function roomView(room) {
  if (!room) return null
  return {
    id: room.id,
    displayName: room.display_name,
    createdAt: room.created_at,
    expiresAt: room.expires_at,
    maxParticipants: room.max_participants,
    status: room.status,
  }
}

function getRoom(roomId) {
  return db.prepare('select * from rooms where id = ?').get(roomId)
}

function assertRoomJoinable(room) {
  if (!room) {
    const error = new Error('Room not found')
    error.code = 'room_not_found'
    error.status = 404
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

export function createRoom({ displayName, password, origin }) {
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
  db.prepare(`
    insert into rooms (id, display_name, password_hash, password_salt, created_at, expires_at, max_participants, status)
    values (?, ?, ?, ?, ?, ?, 2, 'active')
  `).run(id, displayName || 'Untitled room', hashPassword(password, salt), salt, createdAt, expiresAt)
  const access = issueAccessToken({ roomId: id, role: 'host' })
  return {
    room: roomView(getRoom(id)),
    shareUrl: `${origin || ''}/rooms/${id}`,
    access,
  }
}

export function getPublicRoom(roomId) {
  const room = getRoom(roomId)
  assertRoomJoinable(room)
  return roomView(room)
}

export function issueAccessToken({ roomId, role }) {
  const token = randomBytes(32).toString('base64url')
  const participantId = randomId(10)
  const issuedAt = nowIso()
  const expiresAt = futureIso(15 * 60 * 1000)
  db.prepare(`
    insert into room_access_tokens (token_hash, room_id, participant_id, role, issued_at, expires_at)
    values (?, ?, ?, ?, ?, ?)
  `).run(tokenHash(token), roomId, participantId, role, issuedAt, expiresAt)
  return { accessToken: token, participantId, role, expiresAt }
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
  return {
    room: roomView(room),
    access: issueAccessToken({ roomId, role: 'guest' }),
  }
}

export function authenticateAccess({ roomId, participantId, accessToken }) {
  const room = getRoom(roomId)
  assertRoomJoinable(room)
  const row = db.prepare(`
    select * from room_access_tokens
    where token_hash = ? and room_id = ? and participant_id = ?
  `).get(tokenHash(accessToken || ''), roomId, participantId)
  if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) {
    const error = new Error('Room access expired or invalid.')
    error.code = 'invalid_access'
    error.status = 401
    throw error
  }
  return { room: roomView(room), access: row }
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
  `).all().map(roomView)
}

export function resetForTests() {
  db.exec('delete from room_presence; delete from room_access_tokens; delete from rooms;')
  passwordAttempts.clear()
}
