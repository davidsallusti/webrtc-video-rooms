import assert from 'node:assert/strict'
import test from 'node:test'

process.env.WEBRTC_NO_LISTEN = '1'
process.env.NODE_ENV = 'test'
process.env.WEBRTC_ADMIN_LOGIN_LIMIT = '100'

const { openApiSpec } = await import('../server/openapi.mjs')
const { adminTestHooks } = await import('../server/admin.mjs')
const { resetForTests } = await import('../server/store.mjs')
const { app, startServer } = await import('../server/index.mjs')

// Serving infrastructure for the docs themselves — routes that exist but are
// deliberately not OpenAPI operations.
const SPEC_EXEMPT = new Set([
  'GET /api/admin/docs',
  'GET /api/admin/docs/openapi.json',
  'GET /api/admin/docs/swagger-initializer.js',
])

// ---------------------------------------------------------------------------
// Route inventory: walk the live Express app (static string mounts only) and
// produce "METHOD /path" pairs with :params converted to {params}.
// ---------------------------------------------------------------------------
function mountPrefixFromRegexp(regexp) {
  if (regexp.fast_slash) return ''
  // Express encodes static mounts as /^\/api\/admin\/?(?=\/|$)/i
  return regexp.source
    .replace('\\/?(?=\\/|$)', '')
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replaceAll('\\/', '/')
}

function collectRoutes(stack, prefix = '') {
  const routes = []
  for (const layer of stack) {
    if (layer.route) {
      const path = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`
      for (const method of Object.keys(layer.route.methods)) {
        routes.push(`${method.toUpperCase()} ${path}`)
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      routes.push(...collectRoutes(layer.handle.stack, `${prefix}${mountPrefixFromRegexp(layer.regexp)}`))
    }
  }
  return routes
}

function liveApiRoutes() {
  return collectRoutes(app._router.stack)
    .filter((entry) => entry.includes(' /api/'))
    .map((entry) => entry.replace(/:([A-Za-z0-9_]+)/g, '{$1}'))
    .filter((entry) => !SPEC_EXEMPT.has(entry))
}

function specOperations() {
  const operations = []
  for (const [path, methods] of Object.entries(openApiSpec.paths)) {
    for (const method of Object.keys(methods)) {
      operations.push(`${method.toUpperCase()} ${path}`)
    }
  }
  return operations
}

test('every live API route is documented in the OpenAPI spec', () => {
  const documented = new Set(specOperations())
  const missing = liveApiRoutes().filter((route) => !documented.has(route))
  assert.deepEqual(missing, [], `undocumented routes:\n${missing.join('\n')}`)
})

test('every documented operation exists as a live route', () => {
  const live = new Set(liveApiRoutes())
  const stale = specOperations().filter((operation) => !live.has(operation))
  assert.deepEqual(stale, [], `spec documents routes that do not exist:\n${stale.join('\n')}`)
})

test('spec is structurally sane', () => {
  assert.equal(openApiSpec.openapi, '3.1.0')
  assert.ok(Object.keys(openApiSpec.paths).length >= 70)
  // Every operation carries a summary and at least one response.
  for (const [path, methods] of Object.entries(openApiSpec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      assert.ok(operation.summary, `missing summary: ${method} ${path}`)
      assert.ok(Object.keys(operation.responses || {}).length, `missing responses: ${method} ${path}`)
      assert.ok(operation.tags?.length, `missing tags: ${method} ${path}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Access control: docs and spec are admin-only.
// ---------------------------------------------------------------------------
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

test('docs page and spec require an admin session', async () => {
  resetForTests()
  await withServer(async (base) => {
    for (const path of ['/api/admin/docs/', '/api/admin/docs/openapi.json', '/api/admin/docs/swagger-initializer.js']) {
      const anonymous = await fetch(`${base}${path}`)
      assert.equal(anonymous.status, 401, `${path} must deny anonymous access`)
    }

    // Bootstrap an admin and confirm the spec serves with the session cookie.
    const login = await fetch(`${base}/api/admin/bootstrap/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@webrtc.local', password: adminTestHooks.localDefaultPassword }),
    })
    assert.equal(login.status, 200)
    const loginBody = await login.json()
    const bootstrapCookie = login.headers.get('set-cookie').split(';')[0]

    // Docs require a fully set-up admin: finish the forced password rotation.
    const setup = await fetch(`${base}/api/admin/setup/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: bootstrapCookie, 'x-csrf-token': loginBody.csrfToken },
      body: JSON.stringify({ newPassword: 'Docs-Test-Password-0090!' }),
    })
    assert.equal(setup.status, 200)
    const cookie = setup.headers.get('set-cookie').split(';')[0]

    const spec = await fetch(`${base}/api/admin/docs/openapi.json`, { headers: { cookie } })
    assert.equal(spec.status, 200)
    const body = await spec.json()
    assert.equal(body.openapi, '3.1.0')
    assert.ok(body.paths['/api/integrations/rooms'])

    // The docs HTML route carries the scoped CSP relaxation.
    const page = await fetch(`${base}/api/admin/docs/`, { headers: { cookie } })
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/)

    // Everywhere else stays strict.
    const health = await fetch(`${base}/api/health`)
    assert.match(health.headers.get('content-security-policy'), /style-src 'self'(?!')/)
  })
})
