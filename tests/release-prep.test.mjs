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
