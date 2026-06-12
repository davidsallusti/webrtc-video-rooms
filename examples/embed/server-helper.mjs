// Server-only helper pattern. Do not bundle this file into browser code.
// It expects an already-authenticated local admin session and CSRF token.

export async function createLocalEmbedSession({ baseUrl, adminCookie, csrfToken, roomId, allowedOrigin }) {
  const response = await fetch(`${baseUrl}/api/admin/rooms/${encodeURIComponent(roomId)}/embed/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: adminCookie,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify({
      allowedOrigin,
      scope: ['embed:status', 'embed:join'],
    }),
  })
  if (!response.ok) throw new Error(`Local embed session failed: ${response.status}`)
  return response.json()
}
