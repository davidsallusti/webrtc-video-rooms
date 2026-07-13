import { useState } from 'react'

// Participant-plane fetch: JSON in/out, normalized Error with code/status.
export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.message || `Request failed (${response.status})`)
    error.code = body?.error || 'request_failed'
    error.status = response.status
    throw error
  }
  return body
}

// Admin-plane fetch: cookie session + CSRF header for mutations.
export async function adminApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(options.csrfToken ? { 'x-csrf-token': options.csrfToken } : {}),
      ...(options.headers || {}),
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.message || `Request failed (${response.status})`)
    error.code = body?.error || 'request_failed'
    error.status = response.status
    throw error
  }
  return body
}

// Header pair every participant-scoped endpoint expects.
export function participantHeaders(access) {
  return {
    'x-participant-id': access.participantId,
    'x-room-access-token': access.accessToken,
  }
}

export function useClipboard() {
  const [copied, setCopied] = useState(false)
  return {
    copied,
    async copy(value) {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    },
  }
}

export function short(value) {
  return String(value || '').slice(0, 8)
}

export function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

export function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString([], { dateStyle: 'medium' })
}

export function fmtDuration(ms) {
  if (!ms) return '—'
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

export function fmtBytes(bytes) {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// "Opens at" copy for scheduled rooms whose join window has not opened.
export function joinWindowNotice(room) {
  if (!room?.scheduledStartAt || room.joinWindowMinutes == null) return null
  const opensAt = new Date(Date.parse(room.scheduledStartAt) - room.joinWindowMinutes * 60_000)
  if (Date.now() >= opensAt.getTime()) return null
  return `This room opens ${opensAt.toLocaleString()} (${room.joinWindowMinutes} minutes before the scheduled start).`
}

export function isLocalOrigin() {
  return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
}
