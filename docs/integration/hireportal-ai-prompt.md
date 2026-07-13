# Paste-ready prompt for the HirePortal AI (UI Bakery)

Prerequisites done on the video-service side: integration API key created,
portal origin added to `WEBRTC_CORS_ORIGINS`, portal LiveKit keypair matching
the service's `WEBRTC_PORTAL_API_KEY/SECRET`. Replace the placeholder values
before pasting.

---

Integrate our self-hosted interview video service into this app. Do not remove
any existing functionality — this replaces only where video calls connect.
Full API reference: the service exposes interactive docs, and all endpoints
return errors as `{ error, message }` where `error` is a stable code.

**New config (add to `src/app/config/livekit.ts` or a new `videoService.ts`):**

```ts
export const VIDEO_SERVICE_URL = 'http://127.0.0.1:4321'          // deployed: https://video.example.com
export const VIDEO_SERVICE_API_KEY = 'wrtc_...'                    // integration API key
// Change the existing LiveKit wsUrl to our self-hosted server:
export const LIVEKIT_WS_URL = 'ws://127.0.0.1:7880'
// Keep the existing LiveKit API key/secret values — they must equal the
// service's portal keypair (used only to prove portal login).
```

**1. Provision a room when an interview is scheduled.**
Wherever a recruiter confirms an interview slot for a candidate, call:

```
POST {VIDEO_SERVICE_URL}/api/integrations/rooms
Authorization: Bearer {VIDEO_SERVICE_API_KEY}
Content-Type: application/json
{
  "displayName": "Interview — {candidate name}",
  "password": "{generate a random 8+ char string, store it}",
  "candidateId": "{candidates.id}",
  "recruiterId": "{candidates.recruiter_id}",
  "invitees": [{ "email": "{candidate email}", "role": "candidate" }],
  "schedule": {
    "scheduledStartAt": "{slot start, ISO}",
    "scheduledEndAt": "{slot end, ISO}",
    "joinWindowMinutes": 15
  },
  "maxParticipants": 3
}
```

Store from the `201` response: `room.id` as `video_room_id` and `shareUrl` as
`video_room_url` on the candidate record (add columns or reuse a JSON field).
The room password is a fallback for joining outside the portal — include it in
the interview email if we send one.

**2. Replace how the video call connects (keep the existing UI).**
Where `VideoCallPanel` / `LiveKitFrame` currently connects using a self-minted
token, change the flow to:

```
const portalJwt = await generateLiveKitToken(...)   // existing helper, unchanged
const res = await fetch(`${VIDEO_SERVICE_URL}/api/portal/access`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${portalJwt}` },
  body: JSON.stringify({ acknowledgeRecording: true }),
})
```

- On `200`: connect the LiveKit room using `res.livekit.url` and
  `res.livekit.token` (NOT the self-minted token — the returned one carries the
  service's access control).
- On `403` with `error === 'room_not_open'`: show "This interview opens 15
  minutes before the scheduled start" instead of connecting.
- On `403` with `error === 'recording_consent_required'`: show the recording
  notice with an "I understand, join" button that retries with
  `acknowledgeRecording: true` (only send the flag after the user has seen the
  notice — show a consent dialog first rather than always sending true).
- On `404`: show "No interview room has been scheduled yet."

**3. After the interview, surface results.**
On the candidate detail view (recruiter-facing), if `video_room_id` exists:

```
GET {VIDEO_SERVICE_URL}/api/integrations/rooms/{video_room_id}
Authorization: Bearer {VIDEO_SERVICE_API_KEY}
```

Show a small "Interview recording" section: room status, `activeParticipants`
while live, and the `recordings` / `transcripts` arrays (status + duration).
When a transcript reaches status `finalized`, note it in the candidate's
`ai_summary` (e.g. append "Interview transcript available").

Keep all error handling non-blocking: if the video service is unreachable, the
rest of the portal must work normally.
