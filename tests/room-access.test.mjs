import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRoom,
  getPublicRoom,
  resetForTests,
  validatePasswordAndIssueAccess,
} from '../server/store.mjs'

test('creates rooms without exposing or storing plaintext passwords', () => {
  resetForTests()
  const created = createRoom({ displayName: 'QA room', password: 'correct horse', origin: 'http://localhost:5180' })

  assert.equal(created.room.displayName, 'QA room')
  assert.equal(created.room.maxParticipants, 2)
  assert.equal(created.shareUrl.includes(created.access.accessToken), false)
  assert.equal(JSON.stringify(created).includes('correct horse'), false)
  assert.equal(Boolean(created.access.accessToken), true)
})

test('validates wrong and correct password access', () => {
  resetForTests()
  const created = createRoom({ displayName: 'Join room', password: 'pass-1234', origin: 'http://localhost:5180' })

  assert.throws(
    () => validatePasswordAndIssueAccess({ roomId: created.room.id, password: 'bad', ip: 'test', activeCount: 0 }),
    /Incorrect room password/,
  )

  const joined = validatePasswordAndIssueAccess({ roomId: created.room.id, password: 'pass-1234', ip: 'test', activeCount: 0 })
  assert.equal(joined.room.id, created.room.id)
  assert.equal(joined.access.role, 'guest')
  assert.notEqual(joined.access.participantId, created.access.participantId)
})

test('returns not found for missing room access', () => {
  resetForTests()
  assert.throws(() => getPublicRoom('missing-room'), /Room not found/)
})

test('rejects access when active occupancy is at the room cap', () => {
  resetForTests()
  const created = createRoom({ displayName: 'Full room', password: 'pass-1234', origin: 'http://localhost:5180' })

  assert.throws(
    () => validatePasswordAndIssueAccess({ roomId: created.room.id, password: 'pass-1234', ip: 'test', activeCount: 2 }),
    /already full/,
  )
})
