import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const browserExportFiles = [
  'src/sdk/index.js',
  'src/embed-sdk.js',
]

const forbiddenBrowserImportPatterns = [
  /from\s+['"]node:/,
  /from\s+['"](?:\.\.\/)*server\//,
  /from\s+['"](?:\.\.\/)*examples\/embed\/server-helper/,
  /from\s+['"](?:\.\.\/)*server\//,
  /require\(['"]node:/,
  /require\(['"](?:\.\.\/)*server\//,
]

const forbiddenSurfacePatterns = [
  /"private"\s*:\s*false/,
  /npm\s+publish/i,
  /publishConfig/i,
  /registry\.npmjs\.org/i,
  /api[_-]?key\s*[:=]\s*['"][^'"]{12,}/i,
  /secret\s*[:=]\s*['"][^'"]{12,}/i,
  /password\s*[:=]\s*['"][^'"]{12,}/i,
  /BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY/,
  /AWS_ACCESS_KEY_ID/,
  /AWS_SECRET_ACCESS_KEY/,
  /\bS3\b|@aws-sdk|aws-sdk/i,
  /cloudflare|twilio|sendgrid|datadog|sentry\.io/i,
  /turn:\S+|coturn/i,
  /MediaRecorder|createObjectURL/i,
  /signedUrl|signed_url/i,
  /ngrok|localtunnel/i,
]

const textExtensions = new Set(['.js', '.mjs', '.jsx', '.json', '.md', '.html', '.example'])
const scanRoots = ['package.json', 'README.md', 'src/sdk', 'src/embed-sdk.js', 'examples/embed', 'docs/release']

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8')
}

function listFiles(entry) {
  const absolute = path.join(root, entry)
  const stats = statSync(absolute)
  if (stats.isFile()) return [entry]
  return readdirSync(absolute).flatMap((child) => listFiles(path.join(entry, child)))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function runReleasePrepInspection() {
  const packageJson = JSON.parse(read('package.json'))
  assert(packageJson.private === true, 'package.json must remain private.')
  assert(!packageJson.publishConfig, 'publishConfig is not allowed in local prep.')
  assert(packageJson.exports?.['./embed-sdk']?.import === './src/sdk/index.js', 'browser SDK export must point to src/sdk/index.js.')
  assert((packageJson.files || []).includes('src/sdk/index.js'), 'package files must include the browser SDK boundary.')
  assert(!(packageJson.files || []).some((entry) => entry === 'server' || entry.startsWith('server/')), 'package files must not include server modules.')

  for (const relativePath of browserExportFiles) {
    const source = read(relativePath)
    for (const pattern of forbiddenBrowserImportPatterns) {
      assert(!pattern.test(source), `browser export imports forbidden module in ${relativePath}`)
    }
    assert(!/tokenHash|bootstrapToken|ADMIN_BOOTSTRAP|webrtc_admin_session|integrationApiKey/i.test(source), `browser export leaks privileged identifiers in ${relativePath}`)
  }

  const files = scanRoots.flatMap((entry) => listFiles(entry))
    .filter((file) => textExtensions.has(path.extname(file)) || file.endsWith('.env.example'))

  for (const file of files) {
    if (file === 'docs/release/local-prep-checklist.md') continue
    const source = read(file)
    for (const pattern of forbiddenSurfacePatterns) {
      assert(!pattern.test(source), `forbidden release surface matched in ${file}: ${pattern}`)
    }
  }

  const iframeExample = read('examples/embed/local-iframe.html')
  assert(iframeExample.includes('URLSearchParams'), 'iframe example must use configurable local parameters.')
  assert(!/https:\/\/(?!example\.invalid)/i.test(iframeExample), 'iframe example must not hard-code production HTTPS endpoints.')

  return {
    privatePackage: true,
    browserExports: browserExportFiles,
    scannedFiles: files.length,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runReleasePrepInspection()
  console.log(JSON.stringify(result, null, 2))
}
