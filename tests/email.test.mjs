import assert from 'node:assert/strict'
import test from 'node:test'

process.env.WEBRTC_NO_LISTEN = '1'
process.env.NODE_ENV = 'test'
process.env.WEBRTC_ADMIN_LOGIN_LIMIT = '100'
// Force the local provider: emails are composed + recorded, never sent.
process.env.WEBRTC_EMAIL_PROVIDER = 'local'

const { db, resetForTests } = await import('../server/store.mjs')
const { adminTestHooks } = await import('../server/admin.mjs')
const { startServer } = await import('../server/index.mjs')

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

async function adminSession(base) {
  const login = await jsonFetch(`${base}/api/admin/bootstrap/login`, {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@webrtc.local', password: adminTestHooks.localDefaultPassword }),
  })
  const cookie = login.response.headers.get('set-cookie').split(';')[0]
  const setup = await jsonFetch(`${base}/api/admin/setup/password`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': login.body.csrfToken },
    body: JSON.stringify({ newPassword: 'Email-Test-Password-01!' }),
  })
  return { cookie: setup.response.headers.get('set-cookie').split(';')[0], csrfToken: setup.body.csrfToken }
}

// Outbox writes are fire-and-forget; give the microtask queue a beat.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

function outboxRows() {
  return db.prepare('select * from email_outbox order by created_at asc').all()
}

test('room creation with invitees records invitation emails including the password', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await adminSession(base)
    const created = await jsonFetch(`${base}/api/admin/rooms`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({
        displayName: 'Email room',
        password: 'invite-pass-1',
        invitees: [{ email: 'jane@example.com' }, { email: 'panel@example.com' }],
        candidateId: 'u2-candidate',
      }),
    })
    assert.equal(created.response.status, 201)
    await settle()

    const rows = outboxRows().filter((row) => row.template_key === 'room_invitation')
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((row) => row.to_email).sort(), ['jane@example.com', 'panel@example.com'])
    assert.equal(rows[0].provider, 'local')
    assert.equal(rows[0].status, 'local_recorded')
    assert.match(rows[0].subject, /Email room/)
    assert.match(rows[0].body_text, /invite-pass-1/)
    assert.match(rows[0].body_text, new RegExp(`/rooms/${created.body.room.id}`))

    // Outbox is visible via the admin API.
    const outbox = await jsonFetch(`${base}/api/admin/rooms/${created.body.room.id}/emails`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(outbox.response.status, 200)
    assert.equal(outbox.body.emails.length, 2)
    assert.equal(outbox.body.email.provider, 'local')
  })
})

test('newly added invitees get an email without the password; resend works', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await adminSession(base)
    const created = await jsonFetch(`${base}/api/admin/rooms`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ displayName: 'Diff room', password: 'pass-1234', invitees: [{ email: 'a@example.com' }] }),
    })
    await settle()
    assert.equal(outboxRows().length, 1)

    // Update invitees: keep a@, add b@ — only b@ gets an email, without password.
    const updated = await jsonFetch(`${base}/api/admin/rooms/${created.body.room.id}/interview-config`, {
      method: 'PATCH',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ invitees: [{ email: 'a@example.com' }, { email: 'b@example.com' }] }),
    })
    assert.equal(updated.response.status, 200)
    await settle()
    const rows = outboxRows()
    assert.equal(rows.length, 2)
    assert.equal(rows[1].to_email, 'b@example.com')
    assert.doesNotMatch(rows[1].body_text, /pass-1234/)
    assert.match(rows[1].body_text, /shared separately/)

    // Resend to an existing invitee.
    const resend = await jsonFetch(`${base}/api/admin/rooms/${created.body.room.id}/invitees/a@example.com/resend-invite`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(resend.response.status, 202)
    await settle()
    assert.equal(outboxRows().length, 3)

    const missing = await jsonFetch(`${base}/api/admin/rooms/${created.body.room.id}/invitees/nobody@example.com/resend-invite`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    })
    assert.equal(missing.response.status, 404)
  })
})

test('admin user creation sends a welcome email and forces rotation on first login', async () => {
  resetForTests()
  await withServer(async (base) => {
    const admin = await adminSession(base)
    const created = await jsonFetch(`${base}/api/admin/users`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ email: 'newop@example.com', displayName: 'New Operator', roleKeys: ['operator'] }),
    })
    assert.equal(created.response.status, 201)
    assert.ok(created.body.temporaryPassword.length >= 12)
    assert.equal(created.body.user.setupRequired, true)
    await settle()

    const welcome = outboxRows().find((row) => row.template_key === 'admin_welcome')
    assert.equal(welcome.to_email, 'newop@example.com')
    assert.match(welcome.body_text, new RegExp(created.body.temporaryPassword))

    // Duplicate email rejected.
    const duplicate = await jsonFetch(`${base}/api/admin/users`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ email: 'newop@example.com' }),
    })
    assert.equal(duplicate.response.status, 409)

    // First login with the temp password lands in forced rotation.
    const login = await jsonFetch(`${base}/api/admin/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'newop@example.com', password: created.body.temporaryPassword }),
    })
    assert.equal(login.response.status, 200)
    assert.equal(login.body.user.setupRequired, true)
    const cookie = login.response.headers.get('set-cookie').split(';')[0]

    // Blocked from other admin routes until rotation…
    const blocked = await jsonFetch(`${base}/api/admin/rooms`, { headers: { cookie } })
    assert.equal(blocked.response.status, 403)

    // …then rotation completes and access works per role.
    const setup = await jsonFetch(`${base}/api/admin/setup/password`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': login.body.csrfToken },
      body: JSON.stringify({ newPassword: 'Operator-Own-Password-1!' }),
    })
    assert.equal(setup.response.status, 200)
    const rotatedCookie = setup.response.headers.get('set-cookie').split(';')[0]
    const rooms = await jsonFetch(`${base}/api/admin/rooms`, { headers: { cookie: rotatedCookie } })
    assert.equal(rooms.response.status, 200)
  })
})
