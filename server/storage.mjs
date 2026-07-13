import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

// Recording media storage. Two modes behind one interface:
//   local — files land in a folder inside this project (dev/test default).
//   s3    — any S3-compatible bucket (production on AWS).
// LiveKit egress WRITES the media (directly to S3, or to a volume mounted into
// the egress container for local mode); this adapter covers key generation,
// egress output config, and playback reads.
const __dirname = dirname(fileURLToPath(import.meta.url))
const storageMode = process.env.WEBRTC_STORAGE_MODE === 's3' ? 's3' : 'local'
const recordingsDir = process.env.WEBRTC_RECORDINGS_DIR || join(__dirname, '..', 'data', 'recordings')
// Path prefix the egress CONTAINER writes to; docker-compose mounts it onto recordingsDir.
const egressLocalPrefix = process.env.WEBRTC_EGRESS_LOCAL_PREFIX || '/out'

const s3Bucket = process.env.WEBRTC_S3_BUCKET || ''
const s3Region = process.env.WEBRTC_S3_REGION || 'us-east-1'
const s3AccessKey = process.env.WEBRTC_S3_ACCESS_KEY || ''
const s3SecretKey = process.env.WEBRTC_S3_SECRET_KEY || ''
const s3Endpoint = process.env.WEBRTC_S3_ENDPOINT || ''
const s3ForcePathStyle = process.env.WEBRTC_S3_FORCE_PATH_STYLE === '1'
const presignTtlSeconds = Number(process.env.WEBRTC_S3_PRESIGN_TTL_SECONDS || 15 * 60)

if (storageMode === 'local') mkdirSync(recordingsDir, { recursive: true })

let s3ClientPromise = null
function s3Client() {
  // Lazy import keeps the AWS SDK out of local-mode startup entirely.
  if (!s3ClientPromise) {
    s3ClientPromise = import('@aws-sdk/client-s3').then(({ S3Client }) => new S3Client({
      region: s3Region,
      ...(s3Endpoint ? { endpoint: s3Endpoint } : {}),
      forcePathStyle: s3ForcePathStyle,
      credentials: s3AccessKey ? { accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey } : undefined,
    }))
  }
  return s3ClientPromise
}

export function activeStorageProvider() {
  return storageMode === 's3' ? 's3' : 'local_file'
}

// Object key for a new recording: stable, room-scoped, no user input.
export function recordingStorageKey(roomId, artifactId) {
  return `recordings/${roomId}/${artifactId}.mp4`
}

// LiveKit egress EncodedFileOutput fields for this storage target.
export function egressFileOutput(storageKey) {
  if (storageMode === 's3') {
    return {
      filepath: storageKey,
      output: {
        case: 's3',
        value: {
          accessKey: s3AccessKey,
          secret: s3SecretKey,
          region: s3Region,
          bucket: s3Bucket,
          ...(s3Endpoint ? { endpoint: s3Endpoint } : {}),
          forcePathStyle: s3ForcePathStyle,
        },
      },
    }
  }
  return { filepath: `${egressLocalPrefix}/${storageKey}` }
}

function localMediaPath(storageKey) {
  const resolved = normalize(join(recordingsDir, storageKey))
  if (!resolved.startsWith(normalize(recordingsDir))) {
    const error = new Error('Invalid storage key.')
    error.code = 'invalid_storage_key'
    error.status = 400
    throw error
  }
  return resolved
}

function mediaNotFound() {
  const error = new Error('Recording media is not available.')
  error.code = 'recording_media_not_found'
  error.status = 404
  return error
}

// Playback source for a stored recording:
//   local → { stream, byteSize } for direct piping
//   s3    → { redirectUrl } (short-lived presigned GET)
export async function openRecordingMedia(storageKey) {
  if (!storageKey) throw mediaNotFound()
  if (storageMode === 's3') {
    const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([
      import('@aws-sdk/client-s3'),
      import('@aws-sdk/s3-request-presigner'),
    ])
    const client = await s3Client()
    const redirectUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: s3Bucket, Key: storageKey }), {
      expiresIn: presignTtlSeconds,
    })
    return { redirectUrl }
  }
  const path = localMediaPath(storageKey)
  if (!existsSync(path)) throw mediaNotFound()
  return { stream: createReadStream(path), byteSize: statSync(path).size }
}

// Byte size after egress completes (S3 size arrives via the egress webhook
// payload instead, so callers treat null as "trust the webhook").
export function recordedByteSize(storageKey) {
  if (storageMode !== 'local') return null
  try {
    return statSync(localMediaPath(storageKey)).size
  } catch {
    return null
  }
}

// Raw media bytes for the STT provider (local file or S3 object).
export async function readRecordingMedia(storageKey) {
  if (storageMode === 's3') {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3')
    const client = await s3Client()
    const result = await client.send(new GetObjectCommand({ Bucket: s3Bucket, Key: storageKey }))
    return Buffer.from(await result.Body.transformToByteArray())
  }
  const path = localMediaPath(storageKey)
  if (!existsSync(path)) throw mediaNotFound()
  const { readFile } = await import('node:fs/promises')
  return readFile(path)
}
