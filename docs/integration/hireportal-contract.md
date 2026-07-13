# HirePortal ↔ WebRTC Video Service — Connection Contract

How HirePortal (unmodified code; config-only wiring by the owner) uses this app
as its interview video service. All calls are browser-callable: set the portal's
origin in `WEBRTC_CORS_ORIGINS`.

## The two join paths

### 1. Portal users (auto-admit)

HirePortal already mints LiveKit HS256 JWTs in the browser
(`generateLiveKitToken()`, room name `hp-<candidateId>` via `liveKitRoomName()`).
This app accepts those tokens as proof of portal login when the portal's keypair
is configured (`WEBRTC_PORTAL_API_KEY` / `WEBRTC_PORTAL_API_SECRET` — must equal
the portal's LiveKit key/secret).

Two ways to use a portal token:

- **Direct media connection** — the same keypair is registered in
  `livekit/livekit.yaml`, so the portal's existing `LiveKitFrame` connects to
  this LiveKit server by changing only its `wsUrl` config. No calls to this app
  at all. Control-plane gates (allowlist, join window, consent) do NOT apply on
  this path; the token signature is the trust boundary.
- **`POST /api/portal/access`** — full control-plane admission:

  ```
  POST /api/portal/access
  Authorization: Bearer <portal LiveKit JWT>
  { "acknowledgeRecording": true }   // required to enter recorded rooms

  200 → { room, access: { accessToken, participantId, role }, livekit: { url, roomName, token } }
  404 room_not_found     — no active room maps to the token's room grant
  403 room_not_open      — join window not open yet (recruiters bypass)
  403 recording_consent_required — resend with acknowledgeRecording: true
  ```

  The token's identity is matched against the room's `recruiter_id`; a match
  joins as host (join-window bypass), anything else joins as guest.

### 2. Direct link + password (email allowlist)

Share `https://<this-app>/rooms/<roomId>`. The join page collects email (when
the room is invitee-only), display name, and password. Programmatically:

```
POST /api/rooms/:roomId/access        { password, email?, displayName? }
POST /api/rooms/:roomId/livekit-token headers: x-participant-id, x-room-access-token
```

Rejoin after leaving = repeat both calls (tokens are revoked on disconnect).

## Provisioning rooms (server-to-server or browser with a scoped key)

```
POST /api/integrations/rooms
Authorization: Bearer <integration API key>   // admin console → Integrations
{
  "displayName": "Interview — Jane Doe",
  "password": "candidate-pass",
  "candidateId": "u2-candidate",              // sets LiveKit room hp-u2candidate
  "recruiterId": "u1",
  "invitees": [{ "email": "jane@example.com", "role": "candidate" }],
  "schedule": {
    "scheduledStartAt": "2026-07-15T14:00:00Z",
    "scheduledEndAt":   "2026-07-15T15:00:00Z", // expiry = end + overrun grace
    "joinWindowMinutes": 15
  },
  "maxParticipants": 3
}
201 → { room, shareUrl, access (host credentials), ... }
```

Room status (requires `rooms:read` scope):

```
GET /api/integrations/rooms/:roomId
200 → { room, candidateId, recruiterId, livekitRoomName, activeParticipants,
        recordings: [{id, status, durationMs, finalizedAt}],
        transcripts: [{id, status, language, finalizedAt}] }
```

## Recordings & transcripts

- Admin console (or `recordings:manage` RBAC): start/stop recording per room;
  recording auto-stops when the room ends.
- Media playback/download: `GET /api/admin/rooms/:roomId/recordings/:id/media`
  (admin session, `recordings:playback`).
- Transcription runs automatically after each recording finalizes (post-call,
  no live captions); segments are readable/exportable via the existing admin
  transcript endpoints.

## Environment quick reference

See [.env.example](../../.env.example). The portal-relevant values:

| Variable | Meaning |
|---|---|
| `WEBRTC_CORS_ORIGINS` | Portal origins allowed to call these APIs from the browser |
| `WEBRTC_PORTAL_API_KEY/SECRET` | Portal's LiveKit keypair (token trust + LiveKit server registration) |
| `WEBRTC_LIVEKIT_URL` | LiveKit server the portal's `LiveKitFrame` also points at |
