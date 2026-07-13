import {
  appendTranscriptSegments,
  attachEgressToRecording,
  attachStorageKeyToRecording,
  createEgressRecordingArtifact,
  createRecordingTranscriptArtifact,
  failEgressRecording,
  failTranscriptArtifact,
  finalizeEgressRecording,
  finalizeTranscriptArtifact,
  findActiveEgressRecording,
  findRecordingByEgressId,
  getRoom,
  recordingStorageCoordinates,
} from './store.mjs'
import { livekitConfigured, nowFromNanos, startRoomEgress, stopRoomEgress } from './livekit.mjs'
import { activeStorageProvider, egressFileOutput, readRecordingMedia, recordedByteSize, recordingStorageKey } from './storage.mjs'
import { sttProviderKey, transcribeRecording } from './stt.mjs'
import { readLimit } from './rate-limit.mjs'

const sttMaxAttempts = readLimit('WEBRTC_STT_MAX_ATTEMPTS', 3)
const sttRetryDelayMs = readLimit('WEBRTC_STT_RETRY_DELAY_MS', 30_000)

// Orchestrates the recording pipeline: control-plane artifact rows in the
// store, media via LiveKit egress, post-call transcripts via the STT provider.

export async function startRecording({ roomId, actorId, ip, userAgent }) {
  const room = getRoom(roomId)
  const artifact = createEgressRecordingArtifact({
    roomId,
    storageProvider: activeStorageProvider(),
    storageKey: null,
    actorId,
    ip,
    userAgent,
  })
  const storageKey = recordingStorageKey(roomId, artifact.id)
  try {
    const egress = await startRoomEgress({
      livekitRoomName: room.livekit_room_name,
      fileOutput: egressFileOutput(storageKey),
    })
    attachEgressToRecording({ roomId, recordingId: artifact.id, egressId: egress.egressId })
    // storage_key is only persisted once egress accepted the job, so
    // half-started recordings never point at media that will not exist.
    attachStorageKeyToRecording(roomId, artifact.id, storageKey)
    return { ...artifact, storageKey }
  } catch (error) {
    failEgressRecording({ roomId, recordingId: artifact.id, reason: error.code || 'egress_start_failed', actorType: 'admin', actorId })
    throw error
  }
}

export async function stopRecording({ roomId, recordingId }) {
  const coordinates = recordingStorageCoordinates(roomId, recordingId)
  if (coordinates.status !== 'active') {
    const error = new Error('Recording is not active.')
    error.code = 'recording_not_active'
    error.status = 409
    throw error
  }
  const row = findActiveEgressRecording(roomId)
  const egressId = row ? JSON.parse(row.metadata_json || '{}').egressId : null
  if (egressId) await stopRoomEgress(egressId)
  // Finalization happens when the egress_ended webhook lands; stopping is a
  // request, not a completion.
  return { stopping: true }
}

// Auto-stop hook for room end: fire-and-forget the egress stop request.
export function stopActiveRecordingForRoom(roomId) {
  const row = findActiveEgressRecording(roomId)
  if (!row) return
  const egressId = JSON.parse(row.metadata_json || '{}').egressId
  if (egressId && livekitConfigured()) {
    stopRoomEgress(egressId).catch(() => {})
  }
}

// LiveKit egress_ended webhook → finalize (or fail) the artifact, then kick
// off the post-call transcription job.
export async function handleEgressEnded(egressInfo) {
  const row = findRecordingByEgressId(egressInfo?.egressId)
  if (!row) return null
  const roomId = row.room_id
  const failed = String(egressInfo.status || '').includes('FAILED') || Boolean(egressInfo.error)
  if (failed) {
    return failEgressRecording({ roomId, recordingId: row.id, reason: egressInfo.error || 'egress_failed' })
  }
  const fileResult = (egressInfo.fileResults || [])[0] || egressInfo.file || {}
  const startedAtMs = Date.parse(nowFromNanos(egressInfo.startedAt) || row.started_at || 0)
  const endedAtMs = Date.parse(nowFromNanos(egressInfo.endedAt) || new Date().toISOString())
  const artifact = finalizeEgressRecording({
    roomId,
    recordingId: row.id,
    byteSize: Number(fileResult.size || 0) || recordedByteSize(row.storage_key) || 0,
    durationMs: Number(fileResult.duration ? fileResult.duration / 1e6 : Math.max(0, endedAtMs - startedAtMs)),
  })
  queueTranscription({ roomId, recordingId: row.id, storageKey: row.storage_key })
  return artifact
}

// Post-call STT with bounded retries. Failures land the artifact in status
// 'failed' with the reason in metadata; admins can re-trigger via the API.
export function queueTranscription({ roomId, recordingId, storageKey, attempt = 1 }) {
  runTranscription({ roomId, recordingId, storageKey, attempt }).catch(() => {})
}

async function runTranscription({ roomId, recordingId, storageKey, attempt }) {
  const artifactId = createRecordingTranscriptArtifact({ roomId, recordingId, providerKey: sttProviderKey() })
  try {
    const media = await readRecordingMedia(storageKey)
    const result = await transcribeRecording({ media, fileName: `${recordingId}.mp4` })
    appendTranscriptSegments({ roomId, artifactId, segments: result.segments })
    finalizeTranscriptArtifact({ roomId, artifactId, language: result.language })
    return artifactId
  } catch (error) {
    failTranscriptArtifact({ roomId, artifactId, reason: `${error.code || 'stt_failed'} (attempt ${attempt})` })
    if (attempt < sttMaxAttempts) {
      setTimeout(() => queueTranscription({ roomId, recordingId, storageKey, attempt: attempt + 1 }), sttRetryDelayMs).unref?.()
    }
    throw error
  }
}

// Manual re-run entry point (admin endpoint) for finalized recordings whose
// transcription failed all attempts.
export async function retryTranscription({ roomId, recordingId }) {
  const coordinates = recordingStorageCoordinates(roomId, recordingId)
  if (coordinates.source !== 'livekit_egress' || coordinates.status !== 'finalized' || !coordinates.storageKey) {
    const error = new Error('Only finalized recordings can be transcribed.')
    error.code = 'recording_not_transcribable'
    error.status = 409
    throw error
  }
  return runTranscription({ roomId, recordingId, storageKey: coordinates.storageKey, attempt: 1 })
}
