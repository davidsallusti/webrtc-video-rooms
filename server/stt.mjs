// Post-call speech-to-text. Transcription runs once per finalized recording;
// there is no live captioning path. Providers:
//   openai — Whisper API (verbose_json gives timed segments)
//   stub   — deterministic fake segments for tests and offline dev
const sttProvider = process.env.WEBRTC_STT_PROVIDER || (process.env.WEBRTC_OPENAI_API_KEY ? 'openai' : 'stub')
const openaiApiKey = process.env.WEBRTC_OPENAI_API_KEY || ''
const openaiBaseUrl = process.env.WEBRTC_OPENAI_BASE_URL || 'https://api.openai.com/v1'
const openaiModel = process.env.WEBRTC_STT_MODEL || 'whisper-1'

export function sttProviderKey() {
  return sttProvider === 'openai' ? `openai:${openaiModel}` : 'stub_local'
}

function sttError(message, code) {
  const error = new Error(message)
  error.code = code
  error.status = 502
  return error
}

// media: Buffer of the finalized recording. Returns normalized segments
// ({ startMs, endMs, text }) regardless of provider.
export async function transcribeRecording({ media, language = 'en', fileName = 'recording.mp4' }) {
  if (sttProvider === 'openai') return transcribeWithOpenai({ media, language, fileName })
  return transcribeWithStub({ media })
}

async function transcribeWithOpenai({ media, language, fileName }) {
  if (!openaiApiKey) throw sttError('STT provider is not configured.', 'stt_not_configured')
  const form = new FormData()
  form.append('file', new Blob([media], { type: 'video/mp4' }), fileName)
  form.append('model', openaiModel)
  form.append('language', language)
  form.append('response_format', 'verbose_json')
  const response = await fetch(`${openaiBaseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${openaiApiKey}` },
    body: form,
  })
  if (!response.ok) {
    throw sttError(`Transcription failed (${response.status}).`, 'stt_provider_error')
  }
  const payload = await response.json()
  const segments = Array.isArray(payload.segments) ? payload.segments : []
  return {
    language: payload.language || language,
    segments: segments.map((segment) => ({
      startMs: Math.max(0, Math.round(Number(segment.start || 0) * 1000)),
      endMs: Math.max(0, Math.round(Number(segment.end || 0) * 1000)),
      text: String(segment.text || '').trim(),
    })).filter((segment) => segment.text),
  }
}

// Deterministic output keyed on media size so tests can assert without a network.
async function transcribeWithStub({ media }) {
  return {
    language: 'en',
    segments: [
      { startMs: 0, endMs: 4000, text: `Stub transcript segment for ${media?.length || 0} bytes of media.` },
    ],
  }
}
