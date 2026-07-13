import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.WEBRTC_NO_LISTEN = '1'
process.env.NODE_ENV = 'test'
// LiveKit token minting is pure JWT signing and works offline with any keypair.
process.env.WEBRTC_LIVEKIT_URL = 'ws://127.0.0.1:7880'
process.env.WEBRTC_LIVEKIT_API_KEY = 'webrtc-app'
process.env.WEBRTC_LIVEKIT_API_SECRET = 'test-secret-of-sufficient-length-0088'
process.env.WEBRTC_PORTAL_API_KEY = 'hireportal'
process.env.WEBRTC_PORTAL_API_SECRET = 'portal-secret-of-sufficient-length-0088'
process.env.WEBRTC_STORAGE_MODE = 'local'
process.env.WEBRTC_STT_PROVIDER = 'stub'

const {
  assertRecordingConsentForJoin,
  attachEgressToRecording,
  attachStorageKeyToRecording,
  configureRecordingSettings,
  connectedParticipantCount,
  createEgressRecordingArtifact,
  createRoom,
  db,
  findRoomByLivekitName,
  issuePortalAccess,
  listRoomInvitees,
  markConnected,
  recordConsentDirect,
  resetForTests,
  validatePasswordAndIssueAccess,
} = await import('../server/store.mjs')
const { issueLivekitToken, verifyPortalToken } = await import('../server/livekit.mjs')
const { handleEgressEnded, retryTranscription } = await import('../server/recordings.mjs')
const { startServer } = await import('../server/index.mjs')
const { AccessToken } = await import('livekit-server-sdk')

async function withServer(fn) {
  const server = startServer({ port: 0, host: '127.0.0.1', log: false })
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  })
  return { response, body: await response.json().catch(() => null) }
}

function futureIso(ms) {
  return new Date(Date.now() + ms).toISOString()
}

test('invitee-only rooms require an allowlisted email after the password', () => {
  resetForTests()
  const created = createRoom({
    displayName: 'Interview',
    password: 'pass-1234',
    origin: 'http://localhost:5180',
    invitees: [{ email: 'Jane@Example.com', role: 'candidate' }],
    candidateId: 'u2-candidate',
    recruiterId: 'u1',
  })

  assert.equal(created.room.inviteeOnly, true)
  assert.deepEqual(listRoomInvitees(created.room.id).map((invitee) => invitee.email), ['jane@example.com'])

  // Wrong password fails before the allowlist reveals anything.
  assert.throws(
    () => validatePasswordAndIssueAccess({ roomId: created.room.id, password: 'nope', email: 'jane@example.com', ip: 't', activeCount: 0 }),
    /Incorrect room password/,
  )
  // Right password, uninvited email.
  assert.throws(
    () => validatePasswordAndIssueAccess({ roomId: created.room.id, password: 'pass-1234', email: 'other@example.com', ip: 't', activeCount: 0 }),
    /limited to invited participants/,
  )
  // Right password, invited email (case-insensitive), rejoin works the same way.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const joined = validatePasswordAndIssueAccess({ roomId: created.room.id, password: 'pass-1234', email: 'JANE@example.com', ip: 't', activeCount: 0 })
    assert.equal(joined.access.email, 'jane@example.com')
  }
})

test('join window blocks early guests, includes opensAt, and lets hosts through', () => {
  resetForTests()
  const created = createRoom({
    displayName: 'Scheduled',
    password: 'pass-1234',
    origin: 'http://localhost:5180',
    candidateId: 'u2-candidate',
    recruiterId: 'u1',
    schedule: {
      scheduledStartAt: futureIso(60 * 60 * 1000),
      scheduledEndAt: futureIso(2 * 60 * 60 * 1000),
      joinWindowMinutes: 15,
    },
  })

  // Slot overrides TTL: expiry tracks scheduled end + overrun grace, not 24h.
  const expiresMs = Date.parse(created.room.expiresAt)
  assert.equal(expiresMs > Date.parse(created.room.scheduledEndAt), true)
  assert.equal(expiresMs < Date.now() + 23 * 60 * 60 * 1000, true)

  let earlyError = null
  try {
    validatePasswordAndIssueAccess({ roomId: created.room.id, password: 'pass-1234', ip: 't', activeCount: 0 })
  } catch (error) {
    earlyError = error
  }
  assert.equal(earlyError?.code, 'room_not_open')
  assert.equal(Boolean(earlyError?.opensAt), true)

  // The recruiter's portal identity bypasses the window (host side).
  const room = findRoomByLivekitName('hp-u2candidate')
  const hostAccess = issuePortalAccess({ room, identity: 'u1', name: 'Recruiter', ip: 't', activeCount: 0 })
  assert.equal(hostAccess.role, 'host')

  // A non-recruiter portal identity still respects the window.
  assert.throws(
    () => issuePortalAccess({ room, identity: 'someone-else', name: 'Guest', ip: 't', activeCount: 0 }),
    /not open yet/,
  )
})

test('portal LiveKit tokens verify, resolve the room, and mint our media token', async () => {
  resetForTests()
  // Mixed-case candidate id: the LiveKit room name must match HirePortal's
  // lowercase derivation or portal tokens resolve to nothing.
  const created = createRoom({
    displayName: 'Portal room',
    password: 'pass-1234',
    origin: 'http://localhost:5180',
    candidateId: 'U2-Candidate',
    recruiterId: 'u1',
  })
  assert.equal(created.room.id.length > 0, true)

  // Mint a token exactly the way HirePortal does (HS256, room grant).
  const portalToken = new AccessToken('hireportal', 'portal-secret-of-sufficient-length-0088', {
    identity: 'u2',
    name: 'Jane Doe',
    ttl: 3600,
  })
  portalToken.addGrant({ room: 'hp-u2candidate', roomJoin: true, canPublish: true, canSubscribe: true })
  const claims = await verifyPortalToken(await portalToken.toJwt())
  assert.equal(claims.identity, 'u2')
  assert.equal(claims.livekitRoomName, 'hp-u2candidate')

  const room = findRoomByLivekitName(claims.livekitRoomName)
  assert.equal(room.id, created.room.id)

  const access = issuePortalAccess({ room, identity: claims.identity, name: claims.name, ip: 't', activeCount: 0 })
  assert.equal(access.role, 'guest')
  const livekit = await issueLivekitToken({ room, participantId: access.participantId, role: access.role, displayName: claims.name })
  assert.equal(livekit.roomName, 'hp-u2candidate')
  assert.equal(livekit.token.split('.').length, 3)

  // Tampered tokens are rejected.
  const tampered = `${await portalToken.toJwt()}x`
  await assert.rejects(() => verifyPortalToken(tampered), /Invalid portal token/)
})

test('recorded rooms are acknowledge-to-enter', () => {
  resetForTests()
  const created = createRoom({ displayName: 'Recorded', password: 'pass-1234', origin: 'http://localhost:5180' })
  const joined = validatePasswordAndIssueAccess({ roomId: created.room.id, password: 'pass-1234', ip: 't', activeCount: 0 })

  // Recording off: no consent needed.
  assertRecordingConsentForJoin(created.room.id, joined.access.participantId)

  configureRecordingSettings({ roomId: created.room.id, actorId: 'test-admin', recordingEnabled: true })
  assert.throws(
    () => assertRecordingConsentForJoin(created.room.id, joined.access.participantId),
    /Acknowledge the recording notice/,
  )
  recordConsentDirect({ roomId: created.room.id, participantId: joined.access.participantId, accessTokenValue: joined.access.accessToken, status: 'acknowledged' })
  assertRecordingConsentForJoin(created.room.id, joined.access.participantId)
})

test('egress recording finalizes with real storage values and produces a stub transcript', async () => {
  resetForTests()
  const created = createRoom({ displayName: 'Pipeline', password: 'pass-1234', origin: 'http://localhost:5180' })
  configureRecordingSettings({ roomId: created.room.id, actorId: 'test-admin', recordingEnabled: true })

  const artifact = createEgressRecordingArtifact({
    roomId: created.room.id,
    storageProvider: 'local_file',
    storageKey: null,
    actorId: 'test-admin',
  })
  assert.equal(artifact.source, 'livekit_egress')
  assert.equal(artifact.status, 'active')

  // Simulate what startRecording does after egress accepts, then write the
  // media file egress would have produced.
  const storageKey = `recordings/${created.room.id}/${artifact.id}.mp4`
  attachEgressToRecording({ roomId: created.room.id, recordingId: artifact.id, egressId: 'EG_test_1' })
  attachStorageKeyToRecording(created.room.id, artifact.id, storageKey)
  const mediaDir = join(process.cwd(), 'data', 'recordings', 'recordings', created.room.id)
  mkdirSync(mediaDir, { recursive: true })
  writeFileSync(join(process.cwd(), 'data', 'recordings', storageKey), Buffer.alloc(2048, 1))

  const finalized = await handleEgressEnded({
    egressId: 'EG_test_1',
    status: 'EGRESS_COMPLETE',
    fileResults: [{ size: 2048, duration: 90_000 * 1e6 }],
  })
  assert.equal(finalized.status, 'finalized')
  assert.equal(finalized.byteSize, 2048)
  assert.equal(finalized.durationMs, 90_000)
  assert.equal(finalized.mediaCaptured, true)

  // Deterministic transcript run (the webhook also queued one in background).
  const transcriptArtifactId = await retryTranscription({ roomId: created.room.id, recordingId: artifact.id })
  const rows = db.prepare('select status, provider_key as providerKey from transcript_artifacts where id = ?').get(transcriptArtifactId)
  assert.equal(rows.status, 'finalized')
  assert.equal(rows.providerKey, 'stub_local')
  const segments = db.prepare('select text from transcript_segments where artifact_id = ?').all(transcriptArtifactId)
  assert.equal(segments.length > 0, true)
  assert.match(segments[0].text, /Stub transcript segment/)
})

test('end-to-end over HTTP: password join, portal join, media tokens, end-for-all', async () => {
  resetForTests()
  await withServer(async (base) => {
    // Interview room with a candidate mapping (portal path resolves by it).
    const created = createRoom({
      displayName: 'Smoke interview',
      password: 'pass-1234',
      origin: base,
      candidateId: 'u9-candidate',
      recruiterId: 'u1',
    })

    // Path 1: link + password.
    const joined = await jsonFetch(`${base}/api/rooms/${created.room.id}/access`, {
      method: 'POST',
      body: JSON.stringify({ password: 'pass-1234', displayName: 'Jane' }),
    })
    assert.equal(joined.response.status, 200)
    const media = await jsonFetch(`${base}/api/rooms/${created.room.id}/livekit-token`, {
      method: 'POST',
      headers: {
        'x-participant-id': joined.body.access.participantId,
        'x-room-access-token': joined.body.access.accessToken,
      },
    })
    assert.equal(media.response.status, 200)
    assert.equal(media.body.livekit.roomName, 'hp-u9candidate')

    // Path 2: portal-minted token, auto-admitted with our media credentials.
    const portalToken = new AccessToken('hireportal', 'portal-secret-of-sufficient-length-0088', {
      identity: 'u9', name: 'Jane Doe', ttl: 3600,
    })
    portalToken.addGrant({ room: 'hp-u9candidate', roomJoin: true })
    const portalJoin = await jsonFetch(`${base}/api/portal/access`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await portalToken.toJwt()}` },
      body: JSON.stringify({}),
    })
    assert.equal(portalJoin.response.status, 200)
    assert.equal(portalJoin.body.access.role, 'guest')
    assert.equal(portalJoin.body.livekit.roomName, 'hp-u9candidate')

    // Host ends for all; media credentials stop being issued.
    const ended = await jsonFetch(`${base}/api/rooms/${created.room.id}/end`, {
      method: 'POST',
      headers: {
        'x-participant-id': created.access.participantId,
        'x-room-access-token': created.access.accessToken,
      },
      body: JSON.stringify({ reason: 'smoke test complete' }),
    })
    assert.equal(ended.response.status, 200)
    const afterEnd = await jsonFetch(`${base}/api/rooms/${created.room.id}/livekit-token`, {
      method: 'POST',
      headers: {
        'x-participant-id': joined.body.access.participantId,
        'x-room-access-token': joined.body.access.accessToken,
      },
    })
    assert.equal(afterEnd.response.status, 410)
  })
})

test('presence webhooks drive occupancy counts', () => {
  resetForTests()
  const created = createRoom({ displayName: 'Presence', password: 'pass-1234', origin: 'http://localhost:5180' })
  assert.equal(connectedParticipantCount(created.room.id), 0)
  markConnected({ roomId: created.room.id, participantId: 'p1', role: 'guest' })
  markConnected({ roomId: created.room.id, participantId: 'p2', role: 'host' })
  assert.equal(connectedParticipantCount(created.room.id), 2)
})
