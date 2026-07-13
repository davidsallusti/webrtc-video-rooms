import assert from 'node:assert/strict'
import test from 'node:test'

process.env.WEBRTC_NO_LISTEN = '1'
process.env.WEBRTC_TRUST_PROXY = '1'
process.env.NODE_ENV = 'test'
process.env.WEBRTC_ADMIN_LOGIN_LIMIT = '100'
process.env.WEBRTC_INTEGRATION_AUTH_LIMIT = '100'
delete process.env.ADMIN_BOOTSTRAP_EMAIL
delete process.env.ADMIN_BOOTSTRAP_PASSWORD
delete process.env.ADMIN_BOOTSTRAP_PASSWORD_HASH

const { authenticateAccess, createRoom, db, hashForStorage, resetForTests, validatePasswordAndIssueAccess } = await import('../server/store.mjs')
const { adminTestHooks } = await import('../server/admin.mjs')
const { startServer } = await import('../server/index.mjs')
const { createEmbedMessage, validateEmbedMessage } = await import('../src/embed-sdk.js')

async function withServer(fn) {
  const server = startServer({ port: 0, host: '127.0.0.1', log: false })
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`, port)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  })
  return { response, body: await response.json().catch(() => null) }
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';')[0] || ''
}

async function bootstrapAndSetup(base, password = 'Rotated-Admin-Password-0086!') {
  const login = await jsonFetch(`${base}/api/admin/bootstrap/login`, {
    method: 'POST',
    body: JSON.stringify({
      email: 'admin@webrtc.local',
      password: adminTestHooks.localDefaultPassword,
    }),
  })
  assert.equal(login.response.status, 200)
  assert.equal(login.body.user.setupRequired, true)
  const cookie = cookieFrom(login.response)
  assert.match(login.response.headers.get('set-cookie'), /HttpOnly/)
  assert.match(login.response.headers.get('set-cookie'), /SameSite=Lax/)
  assert.match(login.response.headers.get('set-cookie'), /Path=\/api\/admin/)

  const setup = await jsonFetch(`${base}/api/admin/setup/password`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': login.body.csrfToken },
    body: JSON.stringify({ newPassword: password }),
  })
  assert.equal(setup.response.status, 200)
  assert.match(setup.response.headers.get('set-cookie'), /Path=\/api\/admin/)
  assert.equal(setup.body.user.setupRequired, false)
  return { cookie: cookieFrom(setup.response), csrfToken: setup.body.csrfToken, user: setup.body.user, password }
}

function addAdminUserWithRole({ id, email, password, roleKey }) {
  db.prepare(`
    insert into admin_users (id, email, password_hash, display_name, status, requires_password_change, created_at)
    values (?, ?, ?, ?, 'active', 0, ?)
  `).run(id, email, hashForStorage(password), email, new Date().toISOString())
  const role = db.prepare('select id from roles where key = ?').get(roleKey)
  assert.equal(Boolean(role), true)
  db.prepare('insert into admin_user_roles (admin_user_id, role_id) values (?, ?)').run(id, role.id)
}

function addAdminUserWithPermissions({ id, email, password, roleKey, permissionKeys }) {
  db.prepare(`
    insert into roles (id, key, name)
    values (?, ?, ?)
    on conflict(key) do update set name = excluded.name
  `).run(`${roleKey}-role`, roleKey, roleKey)
  for (const key of permissionKeys) {
    const permission = db.prepare('select id from permissions where key = ?').get(key)
    assert.equal(Boolean(permission), true, `permission ${key} exists`)
    db.prepare('insert or ignore into role_permissions (role_id, permission_id) values (?, ?)').run(`${roleKey}-role`, permission.id)
  }
  addAdminUserWithRole({ id, email, password, roleKey })
}

test('refuses the known local bootstrap default in production configuration', () => {
  process.env.ADMIN_BOOTSTRAP_EMAIL = 'admin@example.test'
  process.env.ADMIN_BOOTSTRAP_PASSWORD = adminTestHooks.localDefaultPassword
  const config = adminTestHooks.bootstrapConfig(true)
  assert.equal(config.available, false)
  assert.match(config.reason, /refused in production/)
  delete process.env.ADMIN_BOOTSTRAP_EMAIL
  delete process.env.ADMIN_BOOTSTRAP_PASSWORD
})

test('scopes production admin cookies to the admin API path', () => {
  const cookieParts = adminTestHooks.cookieOptions({ isProduction: true }).join('; ')
  assert.match(cookieParts, /HttpOnly/)
  assert.match(cookieParts, /SameSite=Lax/)
  assert.match(cookieParts, /Secure/)
  assert.match(cookieParts, /Path=\/api\/admin/)
})

test('forces bootstrap password rotation before admin room access', async () => {
  resetForTests()
  await withServer(async (base) => {
    const created = createRoom({
      displayName: 'Admin visible room',
      password: 'room-pass-0086',
      origin: base,
      metadata: { project: 'TASK-0086', ticket: 'ADMIN-1', disallowed: 'hidden' },
    })

    const status = await jsonFetch(`${base}/api/admin/bootstrap/status`)
    assert.equal(status.response.status, 200)
    assert.equal(status.body.bootstrapRequired, true)
    assert.equal(status.body.bootstrapAvailable, true)

    const publicLookup = await jsonFetch(`${base}/api/rooms/${created.room.id}`)
    assert.equal(publicLookup.response.status, 200)
    assert.equal(Object.hasOwn(publicLookup.body.room, 'metadata'), false)

    const publicAccess = await jsonFetch(`${base}/api/rooms/${created.room.id}/access`, {
      method: 'POST',
      body: JSON.stringify({ password: 'room-pass-0086' }),
    })
    assert.equal(publicAccess.response.status, 200)
    assert.equal(Object.hasOwn(publicAccess.body.room, 'metadata'), false)

    const login = await jsonFetch(`${base}/api/admin/bootstrap/login`, {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@webrtc.local',
        password: adminTestHooks.localDefaultPassword,
      }),
    })
    assert.equal(login.response.status, 200)
    assert.equal(login.body.user.setupRequired, true)
    const bootstrapCookie = cookieFrom(login.response)

    const blockedRooms = await jsonFetch(`${base}/api/admin/rooms`, { headers: { cookie: bootstrapCookie } })
    assert.equal(blockedRooms.response.status, 403)
    assert.equal(blockedRooms.body.error, 'admin_setup_required')

    const noCsrf = await jsonFetch(`${base}/api/admin/setup/password`, {
      method: 'POST',
      headers: { cookie: bootstrapCookie },
      body: JSON.stringify({ newPassword: 'Rotated-Admin-Password-0086!' }),
    })
    assert.equal(noCsrf.response.status, 403)
    assert.equal(noCsrf.body.error, 'csrf_required')

    const setup = await jsonFetch(`${base}/api/admin/setup/password`, {
      method: 'POST',
      headers: { cookie: bootstrapCookie, 'x-csrf-token': login.body.csrfToken },
      body: JSON.stringify({ newPassword: 'Rotated-Admin-Password-0086!' }),
    })
    assert.equal(setup.response.status, 200)
    assert.equal(setup.body.user.setupRequired, false)
    assert.equal(setup.body.user.permissions.includes('rooms:view_all'), true)

    const reusedBootstrap = await jsonFetch(`${base}/api/admin/bootstrap/login`, {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@webrtc.local',
        password: adminTestHooks.localDefaultPassword,
      }),
    })
    assert.equal(reusedBootstrap.response.status, 401)

    const rooms = await jsonFetch(`${base}/api/admin/rooms`, { headers: { cookie: cookieFrom(setup.response) } })
    assert.equal(rooms.response.status, 200)
    assert.equal(rooms.body.rooms.some((room) => room.id === created.room.id), true)
    const room = rooms.body.rooms.find((item) => item.id === created.room.id)
    assert.equal(room.metadata.project, 'TASK-0086')
    assert.equal(room.metadata.ticket, 'ADMIN-1')
    assert.equal(Object.hasOwn(room.metadata, 'disallowed'), false)
  })
})

test('audits global audit log reads with bounded metadata', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await bootstrapAndSetup(base)
    const audit = await jsonFetch(`${base}/api/admin/audit`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(audit.response.status, 200)
    const auditView = audit.body.audit.find((event) => event.action === 'audit.view')
    assert.equal(Boolean(auditView), true)
    assert.deepEqual(auditView.metadata, { scope: 'global', limit: 40 })
  })
})

test('isolates participant tokens from admin APIs and admin sessions from media credentials', async () => {
  resetForTests()
  await withServer(async (base) => {
    const room = createRoom({ displayName: 'Isolation room', password: 'room-pass-0086', origin: base })
    const guest = validatePasswordAndIssueAccess({
      roomId: room.room.id,
      password: 'room-pass-0086',
      ip: 'test',
      activeCount: 0,
    })

    const participantAdmin = await jsonFetch(`${base}/api/admin/rooms`, {
      headers: {
        'x-participant-id': guest.access.participantId,
        'x-room-access-token': guest.access.accessToken,
      },
    })
    assert.equal(participantAdmin.response.status, 401)

    const integrationLikeAdmin = await jsonFetch(`${base}/api/admin/rooms`, {
      headers: { 'x-api-key': 'wrtc_test_fake_integration_key' },
    })
    assert.equal(integrationLikeAdmin.response.status, 401)

    // Admin cookies never mint media credentials: the LiveKit token endpoint
    // only accepts participant access headers.
    const admin = await bootstrapAndSetup(base)
    const adminMediaToken = await jsonFetch(`${base}/api/rooms/${room.room.id}/livekit-token`, {
      method: 'POST',
      headers: { cookie: admin.cookie },
    })
    assert.equal(adminMediaToken.response.status, 401)
    assert.equal(adminMediaToken.body.error, 'invalid_access')
  })
})

test('requires CSRF for admin room ending and audits successful room lifecycle control', async () => {
  resetForTests()
  await withServer(async (base) => {
    const room = createRoom({ displayName: 'End room', password: 'room-pass-0086', origin: base })
    const admin = await bootstrapAndSetup(base)

    const denied = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/end`, {
      method: 'POST',
      headers: { cookie: admin.cookie },
      body: JSON.stringify({ confirm: true }),
    })
    assert.equal(denied.response.status, 403)
    assert.equal(denied.body.error, 'csrf_required')

    const ended = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/end`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ confirm: true, reason: 'test end' }),
    })
    assert.equal(ended.response.status, 200)
    assert.equal(ended.body.room.status, 'ended')

    const detail = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(detail.response.status, 200)
    assert.equal(detail.body.audit.some((event) => event.action === 'room.ended_for_all'), true)
  })
})

test('supports admin room create, lifecycle transitions, search, and projection-safe public views', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await bootstrapAndSetup(base)

    const created = await jsonFetch(`${base}/api/admin/rooms`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({
        displayName: 'Lifecycle Ops',
        password: 'room-pass-0087',
        metadata: { project: 'TASK-0087', ticket: 'LC-1', disallowed: 'hidden' },
      }),
    })
    assert.equal(created.response.status, 201)
    assert.equal(created.body.room.metadata.project, 'TASK-0087')
    assert.equal(Object.hasOwn(created.body.room.metadata, 'disallowed'), false)

    const roomId = created.body.room.id
    const publicLookup = await jsonFetch(`${base}/api/rooms/${roomId}`)
    assert.equal(publicLookup.response.status, 200)
    assert.equal(Object.hasOwn(publicLookup.body.room, 'metadata'), false)
    assert.equal(Object.hasOwn(publicLookup.body.room, 'lastLifecycleReason'), false)

    const locked = await jsonFetch(`${base}/api/admin/rooms/${roomId}/lifecycle/lock`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ reason: 'qa lock' }),
    })
    assert.equal(locked.response.status, 200)
    assert.equal(locked.body.room.status, 'locked')

    const lockedPublicAccess = await jsonFetch(`${base}/api/rooms/${roomId}/access`, {
      method: 'POST',
      body: JSON.stringify({ password: 'room-pass-0087' }),
    })
    assert.equal(lockedPublicAccess.response.status, 423)
    assert.equal(lockedPublicAccess.body.error, 'room_locked')

    const invalidSecondLock = await jsonFetch(`${base}/api/admin/rooms/${roomId}/lifecycle/lock`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ reason: 'second lock' }),
    })
    assert.equal(invalidSecondLock.response.status, 409)
    assert.equal(invalidSecondLock.body.error, 'invalid_room_transition')

    const unlocked = await jsonFetch(`${base}/api/admin/rooms/${roomId}/lifecycle/unlock`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ reason: 'qa unlock' }),
    })
    assert.equal(unlocked.response.status, 200)
    assert.equal(unlocked.body.room.status, 'active')

    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    const extended = await jsonFetch(`${base}/api/admin/rooms/${roomId}/lifecycle/extend`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ reason: 'longer test', expiresAt }),
    })
    assert.equal(extended.response.status, 200)
    assert.equal(extended.body.room.expiresAt, expiresAt)

    const filtered = await jsonFetch(`${base}/api/admin/rooms?status=active&q=TASK-0087`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(filtered.response.status, 200)
    assert.equal(filtered.body.rooms.some((room) => room.id === roomId), true)

    const detail = await jsonFetch(`${base}/api/admin/rooms/${roomId}`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(detail.response.status, 200)
    assert.equal(detail.body.room.lifecycle.some((event) => event.toStatus === 'locked'), true)
    assert.equal(detail.body.audit.some((event) => event.action === 'room.locked'), true)
    assert.equal(detail.body.audit.some((event) => event.action === 'room.extended'), true)

    const expired = await jsonFetch(`${base}/api/admin/rooms/${roomId}/lifecycle/expire`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ reason: 'close before denied extend' }),
    })
    assert.equal(expired.response.status, 200)
    assert.equal(expired.body.room.status, 'expired')

    const deniedReopen = await jsonFetch(`${base}/api/admin/rooms/${roomId}/lifecycle/extend`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({
        reason: 'should not reopen',
        expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      }),
    })
    assert.equal(deniedReopen.response.status, 409)
    assert.equal(deniedReopen.body.error, 'invalid_room_transition')

    const afterDenied = await jsonFetch(`${base}/api/admin/rooms/${roomId}`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(afterDenied.response.status, 200)
    assert.equal(afterDenied.body.room.status, 'expired')

    const expiredAccess = await jsonFetch(`${base}/api/rooms/${roomId}/access`, {
      method: 'POST',
      body: JSON.stringify({ password: 'room-pass-0087' }),
    })
    assert.equal(expiredAccess.response.status, 410)
    assert.equal(expiredAccess.body.error, 'room_expired')
  })
})

test('denies lifecycle commands without explicit RBAC and audits the denial generically', async () => {
  resetForTests()
  await withServer(async (base) => {
    const platformAdmin = await bootstrapAndSetup(base)
    addAdminUserWithRole({
      id: 'support-reviewer-0087',
      email: 'support@example.test',
      password: 'Support-Password-0087!',
      roleKey: 'support_reviewer',
    })
    const room = createRoom({ displayName: 'RBAC room', password: 'room-pass-0087', origin: base })

    const login = await jsonFetch(`${base}/api/admin/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'support@example.test', password: 'Support-Password-0087!' }),
    })
    assert.equal(login.response.status, 200)
    const denied = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/lifecycle/disable`, {
      method: 'POST',
      headers: { cookie: cookieFrom(login.response), 'x-csrf-token': login.body.csrfToken },
      body: JSON.stringify({ reason: 'not allowed' }),
    })
    assert.equal(denied.response.status, 403)
    assert.equal(denied.body.error, 'permission_denied')
    assert.equal(Object.hasOwn(denied.body, 'room'), false)

    const audit = await jsonFetch(`${base}/api/admin/audit`, {
      headers: { cookie: platformAdmin.cookie },
    })
    assert.equal(audit.response.status, 200)
    assert.equal(audit.body.audit.some((event) => event.action === 'admin.permission_denied' && event.resourceId === 'rooms:disable'), true)
  })
})

test('keeps guests waiting until host or admin admission and blocks signaling while pending', async () => {
  resetForTests()
  await withServer(async (base) => {
    const room = createRoom({ displayName: 'Waiting room', password: 'room-pass-0087', origin: base })
    const admin = await bootstrapAndSetup(base)

    const policy = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/policy`, {
      method: 'PATCH',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ waitingRoomEnabled: true, autoAdmitFirstGuest: false }),
    })
    assert.equal(policy.response.status, 200)
    assert.equal(policy.body.room.waitingRoomEnabled, true)

    const guest = await jsonFetch(`${base}/api/rooms/${room.room.id}/access`, {
      method: 'POST',
      body: JSON.stringify({ password: 'room-pass-0087' }),
    })
    assert.equal(guest.response.status, 200)
    assert.equal(guest.body.waiting, true)
    assert.equal(guest.body.access.admissionStatus, 'waiting')

    const pendingStatus = await jsonFetch(`${base}/api/rooms/${room.room.id}/access-status`, {
      headers: {
        'x-participant-id': guest.body.access.participantId,
        'x-room-access-token': guest.body.access.accessToken,
      },
    })
    assert.equal(pendingStatus.response.status, 200)
    assert.equal(pendingStatus.body.admissionStatus, 'waiting')

    const queryTokenStatus = await jsonFetch(`${base}/api/rooms/${room.room.id}/access-status?participantId=${guest.body.access.participantId}&accessToken=${guest.body.access.accessToken}`)
    assert.equal(queryTokenStatus.response.status, 401)
    assert.equal(queryTokenStatus.body.error, 'invalid_access')

    assert.throws(() => authenticateAccess({
      roomId: room.room.id,
      participantId: guest.body.access.participantId,
      accessToken: guest.body.access.accessToken,
    }), (error) => error.code === 'waiting_room_pending')

    const platformDetail = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(platformDetail.response.status, 200)
    assert.equal(platformDetail.body.room.waitingParticipants.length, 1)

    addAdminUserWithRole({
      id: 'support-waiting-0087',
      email: 'support-waiting@example.test',
      password: 'Support-Waiting-Password-0087!',
      roleKey: 'support_reviewer',
    })
    const supportLogin = await jsonFetch(`${base}/api/admin/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'support-waiting@example.test', password: 'Support-Waiting-Password-0087!' }),
    })
    assert.equal(supportLogin.response.status, 200)
    const supportDetail = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}`, {
      headers: { cookie: cookieFrom(supportLogin.response) },
    })
    assert.equal(supportDetail.response.status, 200)
    assert.equal(Object.hasOwn(supportDetail.body.room, 'waitingParticipants'), false)

    const waiting = await jsonFetch(`${base}/api/rooms/${room.room.id}/waiting`, {
      headers: {
        'x-participant-id': room.access.participantId,
        'x-room-access-token': room.access.accessToken,
      },
    })
    assert.equal(waiting.response.status, 200)
    assert.equal(waiting.body.waitingParticipants.length, 1)

    const admitted = await jsonFetch(`${base}/api/rooms/${room.room.id}/waiting/${guest.body.access.participantId}/admit`, {
      method: 'POST',
      headers: {
        'x-participant-id': room.access.participantId,
        'x-room-access-token': room.access.accessToken,
      },
    })
    assert.equal(admitted.response.status, 200)
    assert.equal(admitted.body.participant.admissionStatus, 'admitted')

    const admittedStatus = await jsonFetch(`${base}/api/rooms/${room.room.id}/access-status`, {
      headers: {
        'x-participant-id': guest.body.access.participantId,
        'x-room-access-token': guest.body.access.accessToken,
      },
    })
    assert.equal(admittedStatus.body.admissionStatus, 'admitted')

    const deniedAdmittedRemove = await jsonFetch(`${base}/api/rooms/${room.room.id}/waiting/${guest.body.access.participantId}/remove`, {
      method: 'POST',
      headers: {
        'x-participant-id': room.access.participantId,
        'x-room-access-token': room.access.accessToken,
      },
    })
    assert.equal(deniedAdmittedRemove.response.status, 409)
    assert.equal(deniedAdmittedRemove.body.error, 'invalid_room_transition')

    const secondGuest = await jsonFetch(`${base}/api/rooms/${room.room.id}/access`, {
      method: 'POST',
      body: JSON.stringify({ password: 'room-pass-0087' }),
    })
    const adminReject = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/waiting/${secondGuest.body.access.participantId}/reject`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(adminReject.response.status, 200)
    assert.equal(adminReject.body.participant.admissionStatus, 'rejected')

    const rejectedStatus = await jsonFetch(`${base}/api/rooms/${room.room.id}/access-status`, {
      headers: {
        'x-participant-id': secondGuest.body.access.participantId,
        'x-room-access-token': secondGuest.body.access.accessToken,
      },
    })
    assert.equal(rejectedStatus.response.status, 401)
    assert.equal(rejectedStatus.body.error, 'invalid_access')

    const detail = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(detail.body.audit.some((event) => event.action === 'waiting_room.admitted'), true)
    assert.equal(detail.body.audit.some((event) => event.action === 'waiting_room.rejected'), true)
  })
})

test('supports local integration clients without exposing secrets or sending real webhooks', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await bootstrapAndSetup(base)

    const createdClient = await jsonFetch(`${base}/api/admin/integrations/clients`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({
        name: 'Local CRM',
        systemKey: 'local_crm',
        permissionScope: ['rooms:create', 'rooms:link', 'webhooks:local_record', 'admin:forbidden'],
        allowedOrigins: ['https://allowed.example.test'],
      }),
    })
    assert.equal(createdClient.response.status, 201)
    assert.match(createdClient.body.key, /^wrtc_/)
    assert.equal(createdClient.body.client.systemKey, 'local_crm')
    assert.deepEqual(createdClient.body.client.permissionScope, ['rooms:create', 'rooms:link', 'webhooks:local_record'])
    assert.equal(Object.hasOwn(createdClient.body.client, 'keyHash'), false)

    const overview = await jsonFetch(`${base}/api/admin/integrations`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(overview.response.status, 200)
    assert.equal(overview.body.clients.length, 1)
    assert.equal(Object.hasOwn(overview.body.clients[0], 'key'), false)
    assert.equal(Object.hasOwn(overview.body.clients[0], 'keyHash'), false)
    assert.equal(overview.body.systems.some((system) => system.systemKey === 'local_crm'), true)

    const createOnlyClient = await jsonFetch(`${base}/api/admin/integrations/clients`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({
        name: 'Create Only CRM',
        systemKey: 'create_only_crm',
        permissionScope: ['rooms:create'],
        allowedOrigins: ['https://allowed.example.test'],
      }),
    })
    assert.equal(createOnlyClient.response.status, 201)
    const createOnlyLinkedRoom = await jsonFetch(`${base}/api/integrations/rooms`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${createOnlyClient.body.key}`,
        origin: 'https://allowed.example.test',
      },
      body: JSON.stringify({
        displayName: 'Denied linked room',
        password: 'room-pass-0087',
        externalLink: { objectType: 'ticket', objectId: 'DENIED-1' },
      }),
    })
    assert.equal(createOnlyLinkedRoom.response.status, 403)
    assert.equal(createOnlyLinkedRoom.body.error, 'integration_scope_denied')
    const afterCreateOnlyDenied = await jsonFetch(`${base}/api/admin/integrations`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(afterCreateOnlyDenied.body.roomLinks.length, 0)
    assert.equal(afterCreateOnlyDenied.body.webhookAttempts.length, 0)

    const linkOnlyClient = await jsonFetch(`${base}/api/admin/integrations/clients`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({
        name: 'Link Only CRM',
        systemKey: 'link_only_crm',
        permissionScope: ['rooms:create', 'rooms:link'],
        allowedOrigins: ['https://allowed.example.test'],
      }),
    })
    assert.equal(linkOnlyClient.response.status, 201)
    const linkedNoWebhook = await jsonFetch(`${base}/api/integrations/rooms`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${linkOnlyClient.body.key}`,
        origin: 'https://allowed.example.test',
      },
      body: JSON.stringify({
        displayName: 'Linked no webhook room',
        password: 'room-pass-0087',
        externalLink: { objectType: 'ticket', objectId: 'LINK-1' },
      }),
    })
    assert.equal(linkedNoWebhook.response.status, 201)
    assert.equal(linkedNoWebhook.body.externalLink.objectId, 'LINK-1')
    assert.equal(linkedNoWebhook.body.webhook, null)
    const afterLinkNoWebhook = await jsonFetch(`${base}/api/admin/integrations`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(afterLinkNoWebhook.body.roomLinks.length, 1)
    assert.equal(afterLinkNoWebhook.body.webhookAttempts.length, 0)

    const noBearer = await jsonFetch(`${base}/api/integrations/rooms`, {
      method: 'POST',
      headers: { cookie: admin.cookie },
      body: JSON.stringify({ displayName: 'Should fail', password: 'room-pass-0087' }),
    })
    assert.equal(noBearer.response.status, 401)
    assert.equal(noBearer.body.error, 'invalid_integration_credentials')

    const originDenied = await jsonFetch(`${base}/api/integrations/rooms`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${createdClient.body.key}`,
        origin: 'https://blocked.example.test',
      },
      body: JSON.stringify({
        displayName: 'Blocked origin',
        password: 'room-pass-0087',
        externalLink: { objectType: 'ticket', objectId: 'CRM-1' },
      }),
    })
    assert.equal(originDenied.response.status, 403)
    assert.equal(originDenied.body.error, 'origin_not_allowed')

    const integratedRoom = await jsonFetch(`${base}/api/integrations/rooms`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${createdClient.body.key}`,
        origin: 'https://allowed.example.test',
      },
      body: JSON.stringify({
        displayName: 'Linked CRM room',
        password: 'room-pass-0087',
        metadata: { project: 'TASK-0087', ticket: 'CRM-42', disallowed: 'hidden' },
        externalLink: {
          objectType: 'ticket',
          objectId: 'CRM-42',
          metadata: { customer: 'Local customer', secret: 'hidden' },
        },
        externalIdentity: {
          externalUserId: 'contact-7',
          displayName: 'Ada Local',
          emailHash: 'sha256:local-only',
          metadata: { customer: 'CRM account' },
        },
      }),
    })
    assert.equal(integratedRoom.response.status, 201)
    assert.equal(integratedRoom.body.room.metadata, undefined)
    assert.equal(integratedRoom.body.externalLink.systemKey, 'local_crm')
    assert.equal(integratedRoom.body.externalLink.metadata.customer, 'Local customer')
    assert.equal(Object.hasOwn(integratedRoom.body.externalLink.metadata, 'secret'), false)

    const publicRoom = await jsonFetch(`${base}/api/rooms/${integratedRoom.body.room.id}`)
    assert.equal(publicRoom.response.status, 200)
    assert.equal(Object.hasOwn(publicRoom.body.room, 'metadata'), false)
    assert.equal(Object.hasOwn(publicRoom.body.room, 'externalLinks'), false)

    const roomDetail = await jsonFetch(`${base}/api/admin/rooms/${integratedRoom.body.room.id}`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(roomDetail.response.status, 200)
    assert.equal(roomDetail.body.room.externalLinks.length, 1)
    assert.equal(roomDetail.body.room.externalLinks[0].objectId, 'CRM-42')
    assert.equal(roomDetail.body.audit.some((event) => event.action === 'integration.room_created'), true)

    addAdminUserWithRole({
      id: 'support-integration-0087',
      email: 'support-integration@example.test',
      password: 'Support-Integration-Password-0087!',
      roleKey: 'support_reviewer',
    })
    const supportLogin = await jsonFetch(`${base}/api/admin/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'support-integration@example.test', password: 'Support-Integration-Password-0087!' }),
    })
    assert.equal(supportLogin.response.status, 200)
    const supportDetail = await jsonFetch(`${base}/api/admin/rooms/${integratedRoom.body.room.id}`, {
      headers: { cookie: cookieFrom(supportLogin.response) },
    })
    assert.equal(supportDetail.response.status, 200)
    assert.equal(Object.hasOwn(supportDetail.body.room, 'externalLinks'), false)

    const afterCreateOverview = await jsonFetch(`${base}/api/admin/integrations`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(afterCreateOverview.response.status, 200)
    assert.equal(afterCreateOverview.body.identities[0].hasEmailHash, true)
    assert.equal(Object.hasOwn(afterCreateOverview.body.identities[0], 'emailHash'), false)
    assert.equal(afterCreateOverview.body.roomLinks.length, 2)
    assert.equal(afterCreateOverview.body.webhookAttempts.length, 1)
    assert.equal(afterCreateOverview.body.webhookAttempts[0].status, 'local_mock_recorded')

    const revoked = await jsonFetch(`${base}/api/admin/integrations/clients/${createdClient.body.client.id}/revoke`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(revoked.response.status, 200)
    assert.equal(revoked.body.client.status, 'revoked')

    const revokedUse = await jsonFetch(`${base}/api/integrations/session`, {
      headers: { authorization: `Bearer ${createdClient.body.key}` },
    })
    assert.equal(revokedUse.response.status, 401)
    assert.equal(revokedUse.body.error, 'invalid_integration_credentials')
  })
})

test('denies integration management without explicit RBAC', async () => {
  resetForTests()
  await withServer(async (base) => {
    await bootstrapAndSetup(base)
    addAdminUserWithRole({
      id: 'support-integration-denied-0087',
      email: 'support-integration-denied@example.test',
      password: 'Support-Integration-Denied-Password-0087!',
      roleKey: 'support_reviewer',
    })
    const supportLogin = await jsonFetch(`${base}/api/admin/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'support-integration-denied@example.test', password: 'Support-Integration-Denied-Password-0087!' }),
    })
    assert.equal(supportLogin.response.status, 200)
    const deniedList = await jsonFetch(`${base}/api/admin/integrations`, {
      headers: { cookie: cookieFrom(supportLogin.response) },
    })
    assert.equal(deniedList.response.status, 403)
    assert.equal(deniedList.body.error, 'permission_denied')
  })
})

test('retains local text chat only when explicitly enabled and hides redacted or deleted bodies', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await bootstrapAndSetup(base)
    const room = createRoom({ displayName: 'Retained chat room', password: 'room-pass-chat', origin: base })
    const guest = validatePasswordAndIssueAccess({
      roomId: room.room.id,
      password: 'room-pass-chat',
      ip: 'chat-test',
      activeCount: 0,
    })
    const guestHeaders = {
      'x-participant-id': guest.access.participantId,
      'x-room-access-token': guest.access.accessToken,
    }

    const defaultChat = await jsonFetch(`${base}/api/rooms/${room.room.id}/chat`, { headers: guestHeaders })
    assert.equal(defaultChat.response.status, 200)
    assert.equal(defaultChat.body.retention.retentionEnabled, false)
    assert.deepEqual(defaultChat.body.messages, [])

    const notRetained = await jsonFetch(`${base}/api/rooms/${room.room.id}/chat`, {
      method: 'POST',
      headers: guestHeaders,
      body: JSON.stringify({ body: '<script>alert("off")</script>' }),
    })
    assert.equal(notRetained.response.status, 202)
    assert.equal(notRetained.body.retained, false)

    const disabledExport = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/chat/export`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(disabledExport.response.status, 409)
    assert.equal(disabledExport.body.error, 'chat_retention_disabled')

    const enabled = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/chat-settings`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ retentionEnabled: true, participantNotice: 'Retained locally for test review.', retentionDays: 7 }),
    })
    assert.equal(enabled.response.status, 200)
    assert.equal(enabled.body.retention.retentionEnabled, true)

    const scriptText = '<img src=x onerror=alert(1)> plain text only'
    const retained = await jsonFetch(`${base}/api/rooms/${room.room.id}/chat`, {
      method: 'POST',
      headers: guestHeaders,
      body: JSON.stringify({ body: scriptText }),
    })
    assert.equal(retained.response.status, 201)
    assert.equal(retained.body.retained, true)
    assert.equal(retained.body.message.body, scriptText)

    const tooLong = await jsonFetch(`${base}/api/rooms/${room.room.id}/chat`, {
      method: 'POST',
      headers: guestHeaders,
      body: JSON.stringify({ body: 'x'.repeat(2001) }),
    })
    assert.equal(tooLong.response.status, 413)
    assert.equal(tooLong.body.error, 'message_too_large')

    let rateLimited = null
    for (let index = 0; index < 20; index += 1) {
      rateLimited = await jsonFetch(`${base}/api/rooms/${room.room.id}/chat`, {
        method: 'POST',
        headers: guestHeaders,
        body: JSON.stringify({ body: `rate ${index}` }),
      })
    }
    assert.equal(rateLimited.response.status, 429)
    assert.equal(rateLimited.body.error, 'rate_limited')

    const queryToken = await jsonFetch(`${base}/api/rooms/${room.room.id}/chat?participantId=${guest.access.participantId}&accessToken=${guest.access.accessToken}`)
    assert.equal(queryToken.response.status, 401)
    assert.equal(queryToken.body.error, 'invalid_access')

    const listed = await jsonFetch(`${base}/api/rooms/${room.room.id}/chat`, { headers: guestHeaders })
    assert.equal(listed.response.status, 200)
    assert.equal(listed.body.messages.some((message) => message.body === scriptText), true)

    addAdminUserWithRole({
      id: 'support-chat-denied-0087',
      email: 'support-chat-denied@example.test',
      password: 'Support-Chat-Denied-Password-0087!',
      roleKey: 'support_reviewer',
    })
    const supportLogin = await jsonFetch(`${base}/api/admin/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'support-chat-denied@example.test', password: 'Support-Chat-Denied-Password-0087!' }),
    })
    const supportChat = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/chat`, {
      headers: { cookie: cookieFrom(supportLogin.response) },
    })
    assert.equal(supportChat.response.status, 403)

    addAdminUserWithPermissions({
      id: 'chat-view-only-0087',
      email: 'chat-view-only@example.test',
      password: 'Chat-View-Only-Password-0087!',
      roleKey: 'chat_view_only_0087',
      permissionKeys: ['rooms:view_all', 'chat:view'],
    })
    const viewOnlyLogin = await jsonFetch(`${base}/api/admin/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'chat-view-only@example.test', password: 'Chat-View-Only-Password-0087!' }),
    })
    const viewOnlyChat = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/chat`, {
      headers: { cookie: cookieFrom(viewOnlyLogin.response) },
    })
    assert.equal(viewOnlyChat.response.status, 200)
    assert.equal(viewOnlyChat.body.messages.some((message) => message.body === scriptText), true)
    const viewOnlyExport = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/chat/export`, {
      headers: { cookie: cookieFrom(viewOnlyLogin.response) },
    })
    assert.equal(viewOnlyExport.response.status, 403)

    const redacted = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/chat/${retained.body.message.id}/redact`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(redacted.response.status, 200)
    assert.equal(redacted.body.message.body, '[redacted]')

    const second = await jsonFetch(`${base}/api/rooms/${room.room.id}/chat`, {
      method: 'POST',
      headers: {
        'x-participant-id': room.access.participantId,
        'x-room-access-token': room.access.accessToken,
      },
      body: JSON.stringify({ body: 'host retained delete me' }),
    })
    assert.equal(second.response.status, 201)
    const deleted = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/chat/${second.body.message.id}/delete`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(deleted.response.status, 200)
    assert.equal(deleted.body.message.body, '[deleted]')

    const exported = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/chat/export`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(exported.response.status, 200)
    assert.equal(exported.body.messages.some((message) => message.body === scriptText), false)
    assert.equal(exported.body.messages.some((message) => message.body === '[redacted]'), true)
    assert.equal(exported.body.messages.some((message) => message.body === '[deleted]'), true)

    const detail = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}`, {
      headers: { cookie: admin.cookie },
    })
    const actions = detail.body.audit.map((event) => event.action)
    assert.equal(actions.includes('chat.retention_configured'), true)
    assert.equal(actions.includes('chat.message_created'), true)
    assert.equal(actions.includes('chat.viewed'), true)
    assert.equal(actions.includes('chat.exported'), true)
    assert.equal(actions.includes('chat.redacted'), true)
    assert.equal(actions.includes('chat.deleted'), true)
    assert.equal(JSON.stringify(detail.body.audit).includes(scriptText), false)

    const integrationLike = await jsonFetch(`${base}/api/integrations/rooms/${room.room.id}/chat`, {
      headers: { authorization: 'Bearer fake' },
    })
    assert.equal(integrationLike.response.status, 401)
    assert.equal(integrationLike.body.error, 'invalid_integration_credentials')
  })
})

test('keeps retained chat duration isolated per room', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await bootstrapAndSetup(base)
    const roomA = createRoom({ displayName: 'Retained chat room A', password: 'room-pass-chat-a', origin: base })
    const roomB = createRoom({ displayName: 'Retained chat room B', password: 'room-pass-chat-b', origin: base })

    const enableRoomA = await jsonFetch(`${base}/api/admin/rooms/${roomA.room.id}/chat-settings`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ retentionEnabled: true, retentionDays: 30 }),
    })
    assert.equal(enableRoomA.response.status, 200)
    assert.equal(enableRoomA.body.retention.retentionDays, 30)

    const enableRoomB = await jsonFetch(`${base}/api/admin/rooms/${roomB.room.id}/chat-settings`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ retentionEnabled: true, retentionDays: 1 }),
    })
    assert.equal(enableRoomB.response.status, 200)
    assert.equal(enableRoomB.body.retention.retentionDays, 1)

    const messageA = await jsonFetch(`${base}/api/rooms/${roomA.room.id}/chat`, {
      method: 'POST',
      headers: {
        'x-participant-id': roomA.access.participantId,
        'x-room-access-token': roomA.access.accessToken,
      },
      body: JSON.stringify({ body: 'room A after room B configure' }),
    })
    assert.equal(messageA.response.status, 201)

    const messageB = await jsonFetch(`${base}/api/rooms/${roomB.room.id}/chat`, {
      method: 'POST',
      headers: {
        'x-participant-id': roomB.access.participantId,
        'x-room-access-token': roomB.access.accessToken,
      },
      body: JSON.stringify({ body: 'room B one day' }),
    })
    assert.equal(messageB.response.status, 201)

    const exportA = await jsonFetch(`${base}/api/admin/rooms/${roomA.room.id}/chat/export`, {
      headers: { cookie: admin.cookie },
    })
    const exportB = await jsonFetch(`${base}/api/admin/rooms/${roomB.room.id}/chat/export`, {
      headers: { cookie: admin.cookie },
    })
    const retainedA = exportA.body.messages.find((message) => message.body === 'room A after room B configure')
    const retainedB = exportB.body.messages.find((message) => message.body === 'room B one day')
    const dayMs = 24 * 60 * 60 * 1000
    const deltaA = Math.round((Date.parse(retainedA.retentionExpiresAt) - Date.parse(retainedA.createdAt)) / dayMs)
    const deltaB = Math.round((Date.parse(retainedB.retentionExpiresAt) - Date.parse(retainedB.createdAt)) / dayMs)
    assert.equal(deltaA, 30)
    assert.equal(deltaB, 1)

    const sharedPolicy = db.prepare("select chat_retention_days from retention_policies where key = 'local_enabled_7d'").get()
    assert.equal(sharedPolicy.chat_retention_days, 7)
  })
})

test('blocks retained chat for waiting guests and inactive rooms', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await bootstrapAndSetup(base)
    const room = createRoom({ displayName: 'Retained waiting room', password: 'room-pass-chat-wait', origin: base })
    const policy = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/policy`, {
      method: 'PATCH',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ waitingRoomEnabled: true, autoAdmitFirstGuest: false }),
    })
    assert.equal(policy.response.status, 200)
    await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/chat-settings`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ retentionEnabled: true }),
    })

    const guest = await jsonFetch(`${base}/api/rooms/${room.room.id}/access`, {
      method: 'POST',
      body: JSON.stringify({ password: 'room-pass-chat-wait' }),
    })
    assert.equal(guest.response.status, 200)
    assert.equal(guest.body.waiting, true)
    const pendingChat = await jsonFetch(`${base}/api/rooms/${room.room.id}/chat`, {
      method: 'POST',
      headers: {
        'x-participant-id': guest.body.access.participantId,
        'x-room-access-token': guest.body.access.accessToken,
      },
      body: JSON.stringify({ body: 'pending should not retain' }),
    })
    assert.equal(pendingChat.response.status, 403)
    assert.equal(pendingChat.body.error, 'waiting_room_pending')

    const expired = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/lifecycle/expire`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ reason: 'chat expiry test' }),
    })
    assert.equal(expired.response.status, 200)
    const expiredChat = await jsonFetch(`${base}/api/rooms/${room.room.id}/chat`, {
      headers: {
        'x-participant-id': room.access.participantId,
        'x-room-access-token': room.access.accessToken,
      },
    })
    assert.equal(expiredChat.response.status, 410)
    assert.equal(expiredChat.body.error, 'room_expired')
  })
})

test('supports local mock transcripts with consent, RBAC, projection, and audit boundaries', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await bootstrapAndSetup(base)
    const room = createRoom({ displayName: 'Mock transcript room', password: 'room-pass-transcript', origin: base })
    const hostHeaders = {
      'x-participant-id': room.access.participantId,
      'x-room-access-token': room.access.accessToken,
    }

    const defaultStatus = await jsonFetch(`${base}/api/rooms/${room.room.id}/transcript/status`, {
      headers: hostHeaders,
    })
    assert.equal(defaultStatus.response.status, 200)
    assert.equal(defaultStatus.body.settings.transcriptEnabled, false)
    assert.equal(defaultStatus.body.consent.status, 'not_required')

    const missingHeaders = await jsonFetch(`${base}/api/rooms/${room.room.id}/transcript/status`)
    assert.equal(missingHeaders.response.status, 401)
    assert.equal(missingHeaders.body.error, 'invalid_access')

    const queryToken = await jsonFetch(`${base}/api/rooms/${room.room.id}/transcript/status?participantId=${room.access.participantId}&accessToken=${room.access.accessToken}`)
    assert.equal(queryToken.response.status, 401)
    assert.equal(queryToken.body.error, 'invalid_access')

    const disabledCaptions = await jsonFetch(`${base}/api/rooms/${room.room.id}/live-captions`, {
      headers: hostHeaders,
    })
    assert.equal(disabledCaptions.response.status, 409)
    assert.equal(disabledCaptions.body.error, 'transcripts_disabled')

    const settings = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcript-settings`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({
        transcriptEnabled: true,
        liveCaptionsEnabled: true,
        mockProviderEnabled: true,
        participantNotice: 'Local mock transcript notice for testing only.',
        retentionDays: 7,
      }),
    })
    assert.equal(settings.response.status, 200)
    assert.equal(settings.body.settings.transcriptEnabled, true)
    assert.equal(settings.body.settings.liveCaptionsEnabled, true)

    const bodyOnlyConsent = await jsonFetch(`${base}/api/rooms/${room.room.id}/transcript/consent`, {
      method: 'POST',
      body: JSON.stringify({
        participantId: room.access.participantId,
        accessToken: room.access.accessToken,
        status: 'acknowledged',
      }),
    })
    assert.equal(bodyOnlyConsent.response.status, 401)
    assert.equal(bodyOnlyConsent.body.error, 'invalid_access')

    const queryConsent = await jsonFetch(`${base}/api/rooms/${room.room.id}/transcript/consent?participantId=${room.access.participantId}&accessToken=${room.access.accessToken}`, {
      method: 'POST',
      body: JSON.stringify({ status: 'acknowledged' }),
    })
    assert.equal(queryConsent.response.status, 401)
    assert.equal(queryConsent.body.error, 'invalid_access')

    const unknownProvider = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/mock/start`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ providerKey: 'cloud_speech' }),
    })
    assert.equal(unknownProvider.response.status, 400)
    assert.equal(unknownProvider.body.error, 'invalid_transcript_provider')

    const started = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/mock/start`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ providerKey: 'mock_local', language: 'en' }),
    })
    assert.equal(started.response.status, 201)
    assert.equal(started.body.artifact.providerKey, 'mock_local')
    assert.equal(started.body.artifact.source, 'mock')

    const artifactId = started.body.artifact.id
    const scriptText = '<script>alert("caption")</script> spoken as text'
    const segment = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/${artifactId}/mock-segments`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ speakerLabel: 'Host', text: scriptText, startMs: 0, endMs: 1200 }),
    })
    assert.equal(segment.response.status, 201)
    assert.equal(segment.body.segment.text, scriptText)

    const beforeConsent = await jsonFetch(`${base}/api/rooms/${room.room.id}/live-captions`, {
      headers: hostHeaders,
    })
    assert.equal(beforeConsent.response.status, 403)
    assert.equal(beforeConsent.body.error, 'transcript_consent_required')

    const declined = await jsonFetch(`${base}/api/rooms/${room.room.id}/transcript/consent`, {
      method: 'POST',
      headers: hostHeaders,
      body: JSON.stringify({ status: 'declined' }),
    })
    assert.equal(declined.response.status, 200)
    assert.equal(declined.body.consent.status, 'declined')
    const declinedCaptions = await jsonFetch(`${base}/api/rooms/${room.room.id}/live-captions`, {
      headers: hostHeaders,
    })
    assert.equal(declinedCaptions.response.status, 403)
    assert.equal(declinedCaptions.body.error, 'transcript_consent_declined')

    const acknowledged = await jsonFetch(`${base}/api/rooms/${room.room.id}/transcript/consent`, {
      method: 'POST',
      headers: hostHeaders,
      body: JSON.stringify({ status: 'acknowledged' }),
    })
    assert.equal(acknowledged.response.status, 200)
    assert.equal(acknowledged.body.consent.status, 'acknowledged')

    const captions = await jsonFetch(`${base}/api/rooms/${room.room.id}/live-captions`, {
      headers: hostHeaders,
    })
    assert.equal(captions.response.status, 200)
    assert.equal(captions.body.segments.some((item) => item.text === scriptText), true)
    assert.equal(Object.hasOwn(captions.body.segments[0], 'redactedAt'), false)

    addAdminUserWithRole({
      id: 'support-transcript-denied-0087',
      email: 'support-transcript-denied@example.test',
      password: 'Support-Transcript-Denied-Password-0087!',
      roleKey: 'support_reviewer',
    })
    const supportLogin = await jsonFetch(`${base}/api/admin/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'support-transcript-denied@example.test', password: 'Support-Transcript-Denied-Password-0087!' }),
    })
    const supportList = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts`, {
      headers: { cookie: cookieFrom(supportLogin.response) },
    })
    assert.equal(supportList.response.status, 403)

    addAdminUserWithPermissions({
      id: 'transcript-view-only-0087',
      email: 'transcript-view-only@example.test',
      password: 'Transcript-View-Only-Password-0087!',
      roleKey: 'transcript_view_only_0087',
      permissionKeys: ['rooms:view_all', 'transcripts:view'],
    })
    const viewOnlyLogin = await jsonFetch(`${base}/api/admin/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'transcript-view-only@example.test', password: 'Transcript-View-Only-Password-0087!' }),
    })
    const viewOnlyTranscript = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/${artifactId}`, {
      headers: { cookie: cookieFrom(viewOnlyLogin.response) },
    })
    assert.equal(viewOnlyTranscript.response.status, 200)
    assert.equal(viewOnlyTranscript.body.segments.some((item) => item.text === scriptText), true)
    const viewOnlyExport = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/${artifactId}/export`, {
      headers: { cookie: cookieFrom(viewOnlyLogin.response) },
    })
    assert.equal(viewOnlyExport.response.status, 403)

    const tooLarge = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/${artifactId}/mock-segments`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ text: 'x'.repeat(2001), startMs: 2000, endMs: 3000 }),
    })
    assert.equal(tooLarge.response.status, 413)
    assert.equal(tooLarge.body.error, 'transcript_segment_too_large')

    const redacted = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/${artifactId}/segments/${segment.body.segment.id}/redact`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(redacted.response.status, 200)
    assert.equal(redacted.body.segment.text, '[redacted]')

    const secondSegment = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/${artifactId}/mock-segments`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ speakerLabel: 'Guest', text: 'delete this mock caption', startMs: 2000, endMs: 3000 }),
    })
    assert.equal(secondSegment.response.status, 201)
    const deleted = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/${artifactId}/segments/${secondSegment.body.segment.id}/delete`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(deleted.response.status, 200)
    assert.equal(deleted.body.segment.text, '[deleted]')

    const exported = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/${artifactId}/export`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(exported.response.status, 200)
    assert.equal(exported.body.segments.some((item) => item.text === scriptText), false)
    assert.equal(exported.body.segments.some((item) => item.text === '[redacted]'), true)
    assert.equal(exported.body.segments.some((item) => item.text === '[deleted]'), true)

    const finalized = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/${artifactId}/finalize`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(finalized.response.status, 200)
    assert.equal(finalized.body.artifact.status, 'finalized')

    const artifactDeleted = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/${artifactId}/delete`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(artifactDeleted.response.status, 200)
    assert.equal(artifactDeleted.body.deleted, true)

    const integrationLike = await jsonFetch(`${base}/api/integrations/rooms/${room.room.id}/transcripts`, {
      headers: { authorization: 'Bearer fake' },
    })
    assert.equal(integrationLike.response.status, 401)
    assert.equal(integrationLike.body.error, 'invalid_integration_credentials')

    const detail = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}`, {
      headers: { cookie: admin.cookie },
    })
    const actions = detail.body.audit.map((event) => event.action)
    assert.equal(actions.includes('transcript.settings_configured'), true)
    assert.equal(actions.includes('transcript.consent_recorded'), true)
    assert.equal(actions.includes('transcript.mock_started'), true)
    assert.equal(actions.includes('transcript.mock_segment_created'), true)
    assert.equal(actions.includes('transcript.viewed'), true)
    assert.equal(actions.includes('transcript.exported'), true)
    assert.equal(actions.includes('transcript.segment_redacted'), true)
    assert.equal(actions.includes('transcript.segment_deleted'), true)
    assert.equal(actions.includes('transcript.finalized'), true)
    assert.equal(actions.includes('transcript.artifact_deleted'), true)
    assert.equal(JSON.stringify(detail.body.audit).includes(scriptText), false)
  })
})

test('blocks local mock transcripts for waiting and inactive room states', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await bootstrapAndSetup(base)
    const room = createRoom({ displayName: 'Mock transcript waiting room', password: 'room-pass-transcript-wait', origin: base })
    await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/policy`, {
      method: 'PATCH',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ waitingRoomEnabled: true, autoAdmitFirstGuest: false }),
    })
    await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcript-settings`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ transcriptEnabled: true, liveCaptionsEnabled: true, mockProviderEnabled: true }),
    })

    const guest = await jsonFetch(`${base}/api/rooms/${room.room.id}/access`, {
      method: 'POST',
      body: JSON.stringify({ password: 'room-pass-transcript-wait' }),
    })
    assert.equal(guest.response.status, 200)
    assert.equal(guest.body.waiting, true)
    const waitingConsent = await jsonFetch(`${base}/api/rooms/${room.room.id}/transcript/consent`, {
      method: 'POST',
      headers: {
        'x-participant-id': guest.body.access.participantId,
        'x-room-access-token': guest.body.access.accessToken,
      },
      body: JSON.stringify({ status: 'acknowledged' }),
    })
    assert.equal(waitingConsent.response.status, 403)
    assert.equal(waitingConsent.body.error, 'waiting_room_pending')

    const artifact = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/mock/start`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ providerKey: 'mock_local' }),
    })
    assert.equal(artifact.response.status, 201)

    await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/lifecycle/expire`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ reason: 'transcript expiry test' }),
    })
    const expiredAppend = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/transcripts/${artifact.body.artifact.id}/mock-segments`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ text: 'should not append', startMs: 0, endMs: 1000 }),
    })
    assert.equal(expiredAppend.response.status, 410)
    assert.equal(expiredAppend.body.error, 'room_expired')

    const expiredCaptions = await jsonFetch(`${base}/api/rooms/${room.room.id}/live-captions`, {
      headers: {
        'x-participant-id': room.access.participantId,
        'x-room-access-token': room.access.accessToken,
      },
    })
    assert.equal(expiredCaptions.response.status, 410)
    assert.equal(expiredCaptions.body.error, 'room_expired')
  })
})

test('supports local mock recording metadata with consent, RBAC, projection, and audit boundaries', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await bootstrapAndSetup(base)
    const room = createRoom({ displayName: 'Mock recording room', password: 'room-pass-recording', origin: base })
    const hostHeaders = {
      'x-participant-id': room.access.participantId,
      'x-room-access-token': room.access.accessToken,
    }
    const participantInternalFields = [
      'storageProvider',
      'retentionDays',
      'updatedAt',
      'mockRecordingEnabled',
      'mediaCaptured',
    ]
    const assertParticipantSafeRecordingSettings = (settings) => {
      assert.equal(Object.hasOwn(settings, 'recordingEnabled'), true)
      assert.equal(Object.hasOwn(settings, 'participantNotice'), true)
      assert.equal(Object.hasOwn(settings, 'statusLabel'), true)
      for (const field of participantInternalFields) {
        assert.equal(Object.hasOwn(settings, field), false, `${field} is not exposed to participants`)
      }
    }

    const defaultStatus = await jsonFetch(`${base}/api/rooms/${room.room.id}/recording/status`, {
      headers: hostHeaders,
    })
    assert.equal(defaultStatus.response.status, 200)
    assert.equal(defaultStatus.body.settings.recordingEnabled, false)
    assertParticipantSafeRecordingSettings(defaultStatus.body.settings)
    assert.equal(defaultStatus.body.consent.status, 'not_required')

    const missingHeaders = await jsonFetch(`${base}/api/rooms/${room.room.id}/recording/status`)
    assert.equal(missingHeaders.response.status, 401)
    assert.equal(missingHeaders.body.error, 'invalid_access')

    const queryToken = await jsonFetch(`${base}/api/rooms/${room.room.id}/recording/status?participantId=${room.access.participantId}&accessToken=${room.access.accessToken}`)
    assert.equal(queryToken.response.status, 401)
    assert.equal(queryToken.body.error, 'invalid_access')

    const disabledConsent = await jsonFetch(`${base}/api/rooms/${room.room.id}/recording/consent`, {
      method: 'POST',
      headers: hostHeaders,
      body: JSON.stringify({ status: 'acknowledged' }),
    })
    assert.equal(disabledConsent.response.status, 409)
    assert.equal(disabledConsent.body.error, 'recording_disabled')

    const disabledStart = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recordings/mock/start`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(disabledStart.response.status, 409)
    assert.equal(disabledStart.body.error, 'recording_disabled')

    const settings = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recording-settings`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({
        recordingEnabled: true,
        mockRecordingEnabled: true,
        participantNotice: 'Local mock recording metadata notice. No audio/video stored.',
        retentionDays: 7,
      }),
    })
    assert.equal(settings.response.status, 200)
    assert.equal(settings.body.settings.recordingEnabled, true)
    assert.equal(settings.body.settings.mockRecordingEnabled, true)
    assert.equal(settings.body.settings.retentionDays, 7)
    assert.equal(settings.body.settings.storageProvider, 'none')
    assert.equal(settings.body.settings.mediaCaptured, false)

    const bodyOnlyConsent = await jsonFetch(`${base}/api/rooms/${room.room.id}/recording/consent`, {
      method: 'POST',
      body: JSON.stringify({
        participantId: room.access.participantId,
        accessToken: room.access.accessToken,
        status: 'acknowledged',
      }),
    })
    assert.equal(bodyOnlyConsent.response.status, 401)
    assert.equal(bodyOnlyConsent.body.error, 'invalid_access')

    const queryConsent = await jsonFetch(`${base}/api/rooms/${room.room.id}/recording/consent?participantId=${room.access.participantId}&accessToken=${room.access.accessToken}`, {
      method: 'POST',
      body: JSON.stringify({ status: 'acknowledged' }),
    })
    assert.equal(queryConsent.response.status, 401)
    assert.equal(queryConsent.body.error, 'invalid_access')

    const declined = await jsonFetch(`${base}/api/rooms/${room.room.id}/recording/consent`, {
      method: 'POST',
      headers: hostHeaders,
      body: JSON.stringify({ status: 'declined' }),
    })
    assert.equal(declined.response.status, 200)
    assert.equal(declined.body.consent.status, 'declined')
    assertParticipantSafeRecordingSettings(declined.body.settings)

    const acknowledged = await jsonFetch(`${base}/api/rooms/${room.room.id}/recording/consent`, {
      method: 'POST',
      headers: hostHeaders,
      body: JSON.stringify({ status: 'acknowledged' }),
    })
    assert.equal(acknowledged.response.status, 200)
    assert.equal(acknowledged.body.consent.status, 'acknowledged')
    assertParticipantSafeRecordingSettings(acknowledged.body.settings)

    addAdminUserWithRole({
      id: 'support-recording-denied-0087',
      email: 'support-recording-denied@example.test',
      password: 'Support-Recording-Denied-Password-0087!',
      roleKey: 'support_reviewer',
    })
    const supportLogin = await jsonFetch(`${base}/api/admin/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'support-recording-denied@example.test', password: 'Support-Recording-Denied-Password-0087!' }),
    })
    const supportList = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recordings`, {
      headers: { cookie: cookieFrom(supportLogin.response) },
    })
    assert.equal(supportList.response.status, 403)

    addAdminUserWithPermissions({
      id: 'recording-view-only-0087',
      email: 'recording-view-only@example.test',
      password: 'Recording-View-Only-Password-0087!',
      roleKey: 'recording_view_only_0087',
      permissionKeys: ['rooms:view_all', 'recordings:view'],
    })
    const viewOnlyLogin = await jsonFetch(`${base}/api/admin/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'recording-view-only@example.test', password: 'Recording-View-Only-Password-0087!' }),
    })
    const viewOnlySettings = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recording-settings`, {
      headers: { cookie: cookieFrom(viewOnlyLogin.response) },
    })
    assert.equal(viewOnlySettings.response.status, 403)
    const viewOnlyStart = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recordings/mock/start`, {
      method: 'POST',
      headers: { cookie: cookieFrom(viewOnlyLogin.response), 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(viewOnlyStart.response.status, 403)

    const started = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recordings/mock/start`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(started.response.status, 201)
    assert.equal(started.body.artifact.source, 'mock_metadata')
    assert.equal(started.body.artifact.status, 'mock_active')
    assert.equal(started.body.artifact.storageProvider, 'none')
    assert.equal(started.body.artifact.byteSize, 0)
    assert.equal(started.body.artifact.mediaCaptured, false)
    assert.equal(Object.hasOwn(started.body.artifact, 'storageKey'), false)
    assert.equal(Object.hasOwn(started.body.artifact, 'playbackUrl'), false)
    assert.equal(Object.hasOwn(started.body.artifact, 'downloadUrl'), false)
    assert.equal(Object.hasOwn(started.body.artifact, 'mediaUrl'), false)

    const stored = db.prepare('select source, storage_provider, storage_key, byte_size from recording_artifacts where id = ?').get(started.body.artifact.id)
    assert.equal(stored.source, 'mock_metadata')
    assert.equal(stored.storage_provider, 'none')
    assert.equal(stored.storage_key, null)
    assert.equal(stored.byte_size, 0)

    const listed = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recordings`, {
      headers: { cookie: cookieFrom(viewOnlyLogin.response) },
    })
    assert.equal(listed.response.status, 200)
    assert.equal(listed.body.artifacts.length, 1)
    assert.equal(Object.hasOwn(listed.body.artifacts[0], 'storageKey'), false)

    const viewOnlyDelete = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recordings/${started.body.artifact.id}/delete`, {
      method: 'POST',
      headers: { cookie: cookieFrom(viewOnlyLogin.response), 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(viewOnlyDelete.response.status, 403)

    const finalized = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recordings/${started.body.artifact.id}/mock-finalize`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ durationMs: 45000 }),
    })
    assert.equal(finalized.response.status, 200)
    assert.equal(finalized.body.artifact.status, 'mock_finalized')
    assert.equal(finalized.body.artifact.durationMs, 45000)
    assert.equal(finalized.body.artifact.storageProvider, 'none')

    const failedStart = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recordings/mock/start`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(failedStart.response.status, 201)
    const failed = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recordings/${failedStart.body.artifact.id}/mock-fail`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ reason: 'metadata only failure' }),
    })
    assert.equal(failed.response.status, 200)
    assert.equal(failed.body.artifact.status, 'mock_failed')
    assert.equal(failed.body.artifact.storageProvider, 'none')

    const artifactDeleted = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recordings/${started.body.artifact.id}/delete`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(artifactDeleted.response.status, 200)
    assert.equal(artifactDeleted.body.deleted, true)

    const integrationLike = await jsonFetch(`${base}/api/integrations/rooms/${room.room.id}/recordings`, {
      headers: { authorization: 'Bearer fake' },
    })
    assert.equal(integrationLike.response.status, 401)
    assert.equal(integrationLike.body.error, 'invalid_integration_credentials')

    const detail = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}`, {
      headers: { cookie: admin.cookie },
    })
    const actions = detail.body.audit.map((event) => event.action)
    assert.equal(actions.includes('recording.settings_configured'), true)
    assert.equal(actions.includes('recording.consent_recorded'), true)
    assert.equal(actions.includes('recording.mock_started'), true)
    assert.equal(actions.includes('recording.mock_finalized'), true)
    assert.equal(actions.includes('recording.mock_failed'), true)
    assert.equal(actions.includes('recording.viewed'), true)
    assert.equal(actions.includes('recording.deleted'), true)
    const auditPayload = JSON.stringify(detail.body.audit)
    assert.equal(auditPayload.includes('storage_key'), false)
    assert.equal(auditPayload.includes('storageKey'), false)
    assert.equal(auditPayload.includes('playbackUrl'), false)
    assert.equal(auditPayload.includes('downloadUrl'), false)
    assert.equal(auditPayload.includes('mediaUrl'), false)
  })
})

test('blocks local mock recording metadata for waiting and inactive room states', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await bootstrapAndSetup(base)
    const room = createRoom({ displayName: 'Mock recording waiting room', password: 'room-pass-recording-wait', origin: base })
    await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/policy`, {
      method: 'PATCH',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ waitingRoomEnabled: true, autoAdmitFirstGuest: false }),
    })
    await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recording-settings`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ recordingEnabled: true, mockRecordingEnabled: true }),
    })

    const guest = await jsonFetch(`${base}/api/rooms/${room.room.id}/access`, {
      method: 'POST',
      body: JSON.stringify({ password: 'room-pass-recording-wait' }),
    })
    assert.equal(guest.response.status, 200)
    assert.equal(guest.body.waiting, true)
    const waitingConsent = await jsonFetch(`${base}/api/rooms/${room.room.id}/recording/consent`, {
      method: 'POST',
      headers: {
        'x-participant-id': guest.body.access.participantId,
        'x-room-access-token': guest.body.access.accessToken,
      },
      body: JSON.stringify({ status: 'acknowledged' }),
    })
    assert.equal(waitingConsent.response.status, 403)
    assert.equal(waitingConsent.body.error, 'waiting_room_pending')

    await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/lifecycle/expire`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ reason: 'recording expiry test' }),
    })

    const expiredStart = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/recordings/mock/start`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(expiredStart.response.status, 410)
    assert.equal(expiredStart.body.error, 'room_expired')

    const expiredConsent = await jsonFetch(`${base}/api/rooms/${room.room.id}/recording/consent`, {
      method: 'POST',
      headers: {
        'x-participant-id': room.access.participantId,
        'x-room-access-token': room.access.accessToken,
      },
      body: JSON.stringify({ status: 'acknowledged' }),
    })
    assert.equal(expiredConsent.response.status, 410)
    assert.equal(expiredConsent.body.error, 'room_expired')
  })
})

test('supports local-only embed sessions with exact origins, safe projections, and route-scoped frame policy', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await bootstrapAndSetup(base)
    const room = createRoom({ displayName: 'Local embed room', password: 'room-pass-embed', origin: base, metadata: { project: 'hidden-admin-metadata' } })
    const allowedOrigin = 'http://127.0.0.1:5173'

    const nonEmbedHealth = await fetch(`${base}/api/health`)
    assert.match(nonEmbedHealth.headers.get('content-security-policy'), /frame-ancestors 'none'/)

    const disabledEmbedShell = await fetch(`${base}/embed/rooms/${room.room.id}`)
    assert.match(disabledEmbedShell.headers.get('content-security-policy'), /frame-ancestors 'none'/)

    const wildcardOrigin = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/embed`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ embedEnabled: true, allowedOrigins: ['*'] }),
    })
    assert.equal(wildcardOrigin.response.status, 400)
    assert.equal(wildcardOrigin.body.error, 'invalid_embed_origin')

    const configured = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/embed`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ embedEnabled: true, allowedOrigins: [allowedOrigin] }),
    })
    assert.equal(configured.response.status, 200)
    assert.equal(configured.body.settings.embedEnabled, true)
    assert.deepEqual(configured.body.settings.allowedOrigins, [allowedOrigin])

    const embedShell = await fetch(`${base}/embed/rooms/${room.room.id}`)
    assert.match(embedShell.headers.get('content-security-policy'), /frame-ancestors 'self' http:\/\/127\.0\.0\.1:5173/)
    const apiHealth = await fetch(`${base}/api/health`)
    assert.match(apiHealth.headers.get('content-security-policy'), /frame-ancestors 'none'/)

    addAdminUserWithPermissions({
      id: 'embed-view-only-0087',
      email: 'embed-view-only@example.test',
      password: 'Embed-View-Only-Password-0087!',
      roleKey: 'embed_view_only_0087',
      permissionKeys: ['rooms:view_all', 'embed:view'],
    })
    const viewOnlyLogin = await jsonFetch(`${base}/api/admin/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'embed-view-only@example.test', password: 'Embed-View-Only-Password-0087!' }),
    })
    const viewOnlyEmbed = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/embed`, {
      headers: { cookie: cookieFrom(viewOnlyLogin.response) },
    })
    assert.equal(viewOnlyEmbed.response.status, 200)
    const viewOnlyIssue = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/embed/sessions`, {
      method: 'POST',
      headers: { cookie: cookieFrom(viewOnlyLogin.response), 'x-csrf-token': viewOnlyLogin.body.csrfToken },
      body: JSON.stringify({ allowedOrigin, scope: ['embed:status'] }),
    })
    assert.equal(viewOnlyIssue.response.status, 403)

    const deniedIssue = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/embed/sessions`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ allowedOrigin: 'http://localhost:5173', scope: ['embed:status'] }),
    })
    assert.equal(deniedIssue.response.status, 403)
    assert.equal(deniedIssue.body.error, 'origin_not_allowed')

    const issued = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/embed/sessions`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ allowedOrigin, scope: ['embed:status', 'embed:join'] }),
    })
    assert.equal(issued.response.status, 201)
    assert.equal(typeof issued.body.bootstrapToken, 'string')
    assert.equal(Object.hasOwn(issued.body.session, 'bootstrapToken'), false)
    assert.equal(Object.hasOwn(issued.body.session, 'sessionToken'), false)

    const bodyExchange = await jsonFetch(`${base}/api/embed/sessions/exchange`, {
      method: 'POST',
      headers: { origin: allowedOrigin },
      body: JSON.stringify({ bootstrapToken: issued.body.bootstrapToken }),
    })
    assert.equal(bodyExchange.response.status, 401)

    const wrongOriginExchange = await jsonFetch(`${base}/api/embed/sessions/exchange`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:5999', 'x-embed-bootstrap-token': issued.body.bootstrapToken },
    })
    assert.equal(wrongOriginExchange.response.status, 403)
    assert.equal(wrongOriginExchange.body.error, 'origin_not_allowed')

    const exchanged = await jsonFetch(`${base}/api/embed/sessions/exchange`, {
      method: 'POST',
      headers: { origin: allowedOrigin, 'x-embed-bootstrap-token': issued.body.bootstrapToken },
    })
    assert.equal(exchanged.response.status, 200)
    assert.equal(typeof exchanged.body.sessionToken, 'string')

    const replayed = await jsonFetch(`${base}/api/embed/sessions/exchange`, {
      method: 'POST',
      headers: { origin: allowedOrigin, 'x-embed-bootstrap-token': issued.body.bootstrapToken },
    })
    assert.equal(replayed.response.status, 401)

    const embedHeaders = {
      origin: allowedOrigin,
      'x-embed-session-id': exchanged.body.session.id,
      'x-embed-session-token': exchanged.body.sessionToken,
    }
    const queryToken = await jsonFetch(`${base}/api/embed/rooms/${room.room.id}/status?sessionId=${exchanged.body.session.id}&sessionToken=${exchanged.body.sessionToken}`, {
      headers: { origin: allowedOrigin },
    })
    assert.equal(queryToken.response.status, 401)

    const adminCookieStatus = await jsonFetch(`${base}/api/embed/rooms/${room.room.id}/status`, {
      headers: { cookie: admin.cookie, origin: allowedOrigin },
    })
    assert.equal(adminCookieStatus.response.status, 401)

    const integrationBearerStatus = await jsonFetch(`${base}/api/embed/rooms/${room.room.id}/status`, {
      headers: { authorization: 'Bearer fake', origin: allowedOrigin },
    })
    assert.equal(integrationBearerStatus.response.status, 401)

    const wrongOriginStatus = await jsonFetch(`${base}/api/embed/rooms/${room.room.id}/status`, {
      headers: { ...embedHeaders, origin: 'http://127.0.0.1:5999' },
    })
    assert.equal(wrongOriginStatus.response.status, 403)

    const wrongRoomStatus = await jsonFetch(`${base}/api/embed/rooms/not-the-room/status`, {
      headers: embedHeaders,
    })
    assert.equal(wrongRoomStatus.response.status, 401)

    const status = await jsonFetch(`${base}/api/embed/rooms/${room.room.id}/status`, {
      headers: embedHeaders,
    })
    assert.equal(status.response.status, 200)
    assert.deepEqual(Object.keys(status.body.room).sort(), ['displayName', 'id', 'status', 'waitingRoomEnabled'].sort())
    assert.equal(JSON.stringify(status.body).includes('hidden-admin-metadata'), false)
    assert.equal(JSON.stringify(status.body).includes('integration'), false)
    assert.equal(JSON.stringify(status.body).includes('transcript'), false)
    assert.equal(JSON.stringify(status.body).includes('recording'), false)
    assert.equal(JSON.stringify(status.body).includes('audit'), false)

    const accessBodyToken = await jsonFetch(`${base}/api/embed/rooms/${room.room.id}/access`, {
      method: 'POST',
      headers: { origin: allowedOrigin },
      body: JSON.stringify({ sessionId: exchanged.body.session.id, sessionToken: exchanged.body.sessionToken, password: 'room-pass-embed' }),
    })
    assert.equal(accessBodyToken.response.status, 401)

    const access = await jsonFetch(`${base}/api/embed/rooms/${room.room.id}/access`, {
      method: 'POST',
      headers: embedHeaders,
      body: JSON.stringify({ password: 'room-pass-embed' }),
    })
    assert.equal(access.response.status, 200)
    assert.equal(access.body.room.id, room.room.id)
    assert.equal(access.body.access.role, 'guest')

    const revokedIssue = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/embed/sessions`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ allowedOrigin, scope: ['embed:status'] }),
    })
    const revokedExchange = await jsonFetch(`${base}/api/embed/sessions/exchange`, {
      method: 'POST',
      headers: { origin: allowedOrigin, 'x-embed-bootstrap-token': revokedIssue.body.bootstrapToken },
    })
    await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/embed/sessions/${revokedIssue.body.session.id}/revoke`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    const revokedStatus = await jsonFetch(`${base}/api/embed/rooms/${room.room.id}/status`, {
      headers: {
        origin: allowedOrigin,
        'x-embed-session-id': revokedExchange.body.session.id,
        'x-embed-session-token': revokedExchange.body.sessionToken,
      },
    })
    assert.equal(revokedStatus.response.status, 401)

    const expiredIssue = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/embed/sessions`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ allowedOrigin, scope: ['embed:status'] }),
    })
    db.prepare('update embed_sessions set expires_at = ? where id = ?').run(new Date(Date.now() - 1000).toISOString(), expiredIssue.body.session.id)
    const expiredExchange = await jsonFetch(`${base}/api/embed/sessions/exchange`, {
      method: 'POST',
      headers: { origin: allowedOrigin, 'x-embed-bootstrap-token': expiredIssue.body.bootstrapToken },
    })
    assert.equal(expiredExchange.response.status, 401)

    const scopeIssue = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}/embed/sessions`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ allowedOrigin, scope: ['embed:status'] }),
    })
    const scopeExchange = await jsonFetch(`${base}/api/embed/sessions/exchange`, {
      method: 'POST',
      headers: { origin: allowedOrigin, 'x-embed-bootstrap-token': scopeIssue.body.bootstrapToken },
    })
    const scopeDenied = await jsonFetch(`${base}/api/embed/rooms/${room.room.id}/access`, {
      method: 'POST',
      headers: {
        origin: allowedOrigin,
        'x-embed-session-id': scopeExchange.body.session.id,
        'x-embed-session-token': scopeExchange.body.sessionToken,
      },
      body: JSON.stringify({ password: 'room-pass-embed' }),
    })
    assert.equal(scopeDenied.response.status, 403)
    assert.equal(scopeDenied.body.error, 'embed_scope_denied')

    const detail = await jsonFetch(`${base}/api/admin/rooms/${room.room.id}`, {
      headers: { cookie: admin.cookie },
    })
    const actions = detail.body.audit.map((event) => event.action)
    assert.equal(actions.includes('embed.settings_configured'), true)
    assert.equal(actions.includes('embed.session_issued'), true)
    assert.equal(actions.includes('embed.session_exchanged'), true)
    assert.equal(actions.includes('embed.join_bootstrap'), true)
    assert.equal(actions.includes('embed.session_revoked'), true)
    const auditPayload = JSON.stringify(detail.body.audit)
    assert.equal(auditPayload.includes(issued.body.bootstrapToken), false)
    assert.equal(auditPayload.includes(exchanged.body.sessionToken), false)
  })
})

test('validates local embed postMessage envelopes without wildcard targets or oversize payloads', () => {
  const allowedOrigin = 'http://127.0.0.1:5173'
  const expectedSource = { name: 'embed-frame-window' }
  const message = createEmbedMessage({
    type: 'webrtc.embed.init',
    roomId: 'room-1',
    sessionId: 'session-1',
    requestId: 'req-1',
    payload: { theme: 'system' },
  })
  assert.equal(validateEmbedMessage(message, {
    allowedOrigin,
    eventOrigin: allowedOrigin,
    expectedSource,
    eventSource: expectedSource,
    roomId: 'room-1',
    sessionId: 'session-1',
  }).ok, true)
  assert.equal(validateEmbedMessage(message, {
    allowedOrigin,
    eventOrigin: 'http://127.0.0.1:5999',
    roomId: 'room-1',
    sessionId: 'session-1',
  }).error, 'invalid_origin')
  assert.equal(validateEmbedMessage(message, {
    allowedOrigin,
    eventOrigin: allowedOrigin,
    expectedSource,
    eventSource: { name: 'other-window' },
    roomId: 'room-1',
    sessionId: 'session-1',
  }).error, 'invalid_source')
  assert.equal(validateEmbedMessage({ ...message, type: 'webrtc.embed.secret' }, {
    allowedOrigin,
    eventOrigin: allowedOrigin,
    roomId: 'room-1',
    sessionId: 'session-1',
  }).error, 'invalid_type')
  assert.equal(validateEmbedMessage({ ...message, version: 2 }, {
    allowedOrigin,
    eventOrigin: allowedOrigin,
    roomId: 'room-1',
    sessionId: 'session-1',
  }).error, 'invalid_version')
  assert.equal(validateEmbedMessage({ ...message, roomId: 'room-2' }, {
    allowedOrigin,
    eventOrigin: allowedOrigin,
    roomId: 'room-1',
    sessionId: 'session-1',
  }).error, 'invalid_binding')
  assert.equal(validateEmbedMessage({ ...message, payload: { text: 'x'.repeat(5000) } }, {
    allowedOrigin,
    eventOrigin: allowedOrigin,
    roomId: 'room-1',
    sessionId: 'session-1',
  }).error, 'message_too_large')
  assert.equal(validateEmbedMessage({
    ...message,
    type: 'webrtc.embed.setTheme',
    payload: { theme: '<script>alert(1)</script>' },
  }, {
    allowedOrigin,
    eventOrigin: allowedOrigin,
    roomId: 'room-1',
    sessionId: 'session-1',
  }).error, 'invalid_payload')
  assert.equal(validateEmbedMessage({
    ...message,
    type: 'webrtc.embed.roomStatus',
    payload: {
      displayName: 'Local room',
      status: 'active',
      waitingRoomEnabled: false,
    },
  }, {
    allowedOrigin,
    eventOrigin: allowedOrigin,
    roomId: 'room-1',
    sessionId: 'session-1',
    direction: 'frame-to-parent',
  }).ok, true)
  assert.equal(validateEmbedMessage({
    ...message,
    type: 'webrtc.embed.roomStatus',
    payload: {
      displayName: 'Local room',
      status: 'active',
      waitingRoomEnabled: false,
      html: '<script>alert(1)</script>',
      sessionToken: 'should-not-cross-postmessage',
    },
  }, {
    allowedOrigin,
    eventOrigin: allowedOrigin,
    roomId: 'room-1',
    sessionId: 'session-1',
    direction: 'frame-to-parent',
  }).error, 'invalid_payload')
  assert.equal(validateEmbedMessage({
    ...message,
    type: 'webrtc.embed.error',
    payload: {
      code: 'invalid_access',
      message: 'javascript:alert(1)',
    },
  }, {
    allowedOrigin,
    eventOrigin: allowedOrigin,
    roomId: 'room-1',
    sessionId: 'session-1',
    direction: 'frame-to-parent',
  }).error, 'invalid_payload')

  const validPayloads = [
    ['webrtc.embed.init', 'parent-to-frame', { theme: 'system' }],
    ['webrtc.embed.join', 'parent-to-frame', { displayName: 'Guest' }],
    ['webrtc.embed.leave', 'parent-to-frame', {}],
    ['webrtc.embed.setDisplayName', 'parent-to-frame', { displayName: 'Guest' }],
    ['webrtc.embed.setTheme', 'parent-to-frame', { theme: 'dark' }],
    ['webrtc.embed.ready', 'frame-to-parent', {}],
    ['webrtc.embed.joined', 'frame-to-parent', { participantId: 'participant-1', status: 'admitted' }],
    ['webrtc.embed.left', 'frame-to-parent', { reason: 'left' }],
    ['webrtc.embed.error', 'frame-to-parent', { code: 'invalid_access', message: 'Access denied' }],
    ['webrtc.embed.roomStatus', 'frame-to-parent', {
      displayName: 'Local room',
      status: 'active',
      waitingRoomEnabled: false,
    }],
    ['webrtc.embed.heightChanged', 'frame-to-parent', { height: 640 }],
  ]

  for (const [type, direction, payload] of validPayloads) {
    assert.equal(validateEmbedMessage({ ...message, type, payload }, {
      allowedOrigin,
      eventOrigin: allowedOrigin,
      roomId: 'room-1',
      sessionId: 'session-1',
      direction,
    }).ok, true, `${type} accepts its strict payload`)
    assert.equal(validateEmbedMessage({
      ...message,
      type,
      payload: { ...payload, sessionToken: 'raw-token-like-value' },
    }, {
      allowedOrigin,
      eventOrigin: allowedOrigin,
      roomId: 'room-1',
      sessionId: 'session-1',
      direction,
    }).error, 'invalid_payload', `${type} rejects token fields`)
    assert.equal(validateEmbedMessage({
      ...message,
      type,
      payload: { ...payload, html: '<script>alert(1)</script>' },
    }, {
      allowedOrigin,
      eventOrigin: allowedOrigin,
      roomId: 'room-1',
      sessionId: 'session-1',
      direction,
    }).error, 'invalid_payload', `${type} rejects unknown executable fields`)
  }
})

test('preserves public room password access and allows only hosts to end public rooms', async () => {
  resetForTests()
  await withServer(async (base) => {
    const room = createRoom({ displayName: 'Public room', password: 'room-pass-0086', origin: base })
    const guest = validatePasswordAndIssueAccess({
      roomId: room.room.id,
      password: 'room-pass-0086',
      ip: 'test',
      activeCount: 0,
    })

    const guestEnd = await jsonFetch(`${base}/api/rooms/${room.room.id}/end`, {
      method: 'POST',
      headers: {
        'x-participant-id': guest.access.participantId,
        'x-room-access-token': guest.access.accessToken,
      },
      body: JSON.stringify({ reason: 'guest try' }),
    })
    assert.equal(guestEnd.response.status, 403)
    assert.equal(guestEnd.body.error, 'host_required')

    const hostEnd = await jsonFetch(`${base}/api/rooms/${room.room.id}/end`, {
      method: 'POST',
      headers: {
        'x-participant-id': room.access.participantId,
        'x-room-access-token': room.access.accessToken,
      },
      body: JSON.stringify({ reason: 'host end' }),
    })
    assert.equal(hostEnd.response.status, 200)
    assert.equal(hostEnd.body.room.status, 'ended')
  })
})
