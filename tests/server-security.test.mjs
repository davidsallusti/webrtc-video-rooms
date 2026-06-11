import assert from 'node:assert/strict'
import test from 'node:test'

process.env.WEBRTC_NO_LISTEN = '1'
process.env.WEBRTC_TRUST_PROXY = '1'
process.env.WEBRTC_ROOM_CREATE_LIMIT = '2'
process.env.WEBRTC_ROOM_CREATE_WINDOW_MS = '60000'
process.env.WEBRTC_PASSWORD_ATTEMPT_LIMIT = '2'
process.env.WEBRTC_PASSWORD_ATTEMPT_WINDOW_MS = '60000'

const { resetForTests } = await import('../server/store.mjs')
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

async function createRoom(base, password = 'rate-pass-1234', ip = '10.0.0.1') {
  const response = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ displayName: 'Rate room', password }),
  })
  return { response, body: await response.json().catch(() => null) }
}

test('rate limits room creation', async () => {
  resetForTests()
  await withServer(async (base) => {
    assert.equal((await createRoom(base, 'room-pass-1')).response.status, 201)
    assert.equal((await createRoom(base, 'room-pass-2')).response.status, 201)

    const limited = await createRoom(base, 'room-pass-3')
    assert.equal(limited.response.status, 429)
    assert.equal(limited.body.error, 'rate_limited')
  })
})

test('rate limits repeated wrong password attempts', async () => {
  resetForTests()
  await withServer(async (base) => {
    const created = await createRoom(base, 'correct-pass', '10.0.0.2')
    const roomId = created.body.room.id

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${base}/api/rooms/${roomId}/access`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.2' },
        body: JSON.stringify({ password: 'wrong-pass' }),
      })
      assert.equal(response.status, 401)
    }

    const limited = await fetch(`${base}/api/rooms/${roomId}/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.2' },
      body: JSON.stringify({ password: 'wrong-pass' }),
    })
    const body = await limited.json()
    assert.equal(limited.status, 429)
    assert.equal(body.error, 'rate_limited')
  })
})

test('does not expose debug room listing route', async () => {
  resetForTests()
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/debug/rooms`)
    assert.equal(response.status, 404)
  })
})
