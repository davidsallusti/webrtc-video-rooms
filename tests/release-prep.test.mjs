import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { runReleasePrepInspection } from '../scripts/inspect-release-prep.mjs'
import {
  EMBED_MAX_MESSAGE_BYTES,
  EMBED_MESSAGE_VERSION,
  createEmbedMessage,
  postEmbedMessage,
  validateEmbedMessage,
} from '../src/sdk/index.js'

test('keeps local release prep private and browser SDK export isolated', async () => {
  const result = runReleasePrepInspection()
  assert.equal(result.privatePackage, true)
  assert.deepEqual(result.browserExports, ['src/sdk/index.js', 'src/embed-sdk.js'])
  assert.equal(result.scannedFiles > 0, true)
  assert.equal(result.hostedReviewChecklist, true)
  assert.equal(result.hostedPublicOriginRequired, true)

  assert.equal(EMBED_MESSAGE_VERSION, 1)
  assert.equal(EMBED_MAX_MESSAGE_BYTES, 4096)
  assert.equal(typeof createEmbedMessage, 'function')
  assert.equal(typeof postEmbedMessage, 'function')
  assert.equal(typeof validateEmbedMessage, 'function')

  const sdkBoundary = await readFile(new URL('../src/sdk/index.js', import.meta.url), 'utf8')
  assert.equal(/server\/|admin|integration|csrf|cookie|secret|tokenHash|bootstrapToken/i.test(sdkBoundary), false)
})

test('keeps examples configurable and release checklist explicit about blocked gates', async () => {
  const iframeExample = await readFile(new URL('../examples/embed/local-iframe.html', import.meta.url), 'utf8')
  assert.match(iframeExample, /URLSearchParams/)
  assert.match(iframeExample, /localhost/)
  assert.match(iframeExample, /127\.0\.0\.1/)
  assert.equal(/https:\/\/(?!example\.invalid)/i.test(iframeExample), false)

  const checklist = await readFile(new URL('../docs/release/local-prep-checklist.md', import.meta.url), 'utf8')
  for (const phrase of [
    'does not approve npm publication',
    'hosted examples',
    'deploy/release',
    'production credentials',
    'object storage',
    'TURN/SFU',
    'real recording/media',
    'David approval',
  ]) {
    assert.match(checklist, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  }
})

test('keeps hosted review prep no-spend, reversible, and non-deploying', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const requiredEnv = readme.slice(
    readme.indexOf('Required environment variables for no-spend review:'),
    readme.indexOf('Optional hardening/config variables:'),
  )
  const optionalEnv = readme.slice(
    readme.indexOf('Optional hardening/config variables:'),
    readme.indexOf('Public review limitations:'),
  )
  assert.match(requiredEnv, /WEBRTC_PUBLIC_ORIGIN=/)
  assert.equal(/WEBRTC_PUBLIC_ORIGIN=/.test(optionalEnv), false)

  const checklist = await readFile(new URL('../docs/release/hosted-review-prep-checklist.md', import.meta.url), 'utf8')
  for (const phrase of [
    'does not deploy',
    'one no-spend Node web service',
    'WEBRTC_PUBLIC_ORIGIN',
    'frame-ancestors',
    'Local Verification Before Review',
    '/api/health',
    'Rollback Plan',
    'Cleanup Plan',
    'Separate Checkpoints Required',
    'Actual deploy',
    'production credentials',
    'object storage',
    'TURN/SFU',
    'real callbacks',
    'real media',
    'Permission broadening',
  ]) {
    assert.match(checklist, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  }

  assert.equal(/render\.yaml|fly\.toml|vercel\.json|railway\.json/i.test(checklist), false)
  assert.equal(/npm\s+publish(?!ation)/i.test(checklist), false)
})
