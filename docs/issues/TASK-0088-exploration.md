# TASK-0088 — Exploration notes (pre-implementation)

Codebase findings that constrain the design. Companion to
[TASK-0088-hireportal-video-service.md](TASK-0088-hireportal-video-service.md).

## How each feature maps to the code

### 1. Admin login — exists
Email/password sessions, CSRF, RBAC in `server/admin.mjs`. UI polish only.

### 2. Room creation + allowlist access
- Join gate order today: `assertRoomJoinable()` (store.mjs:560, locked → expired → active)
  → occupancy → rate limit → password (`validatePasswordAndIssueAccess`, store.mjs:2402)
  → waiting room → 15-min access token → WS auth (`authenticateAccess`, store.mjs:2441).
- Participants are **anonymous**: random `participantId`, no name/email captured anywhere.
  An email allowlist needs a new identity input at the access step plus storage
  (new `room_invitees` table or `metadata_json`).
- Room metadata: `rooms.metadata_json` exists, but the `room_metadata` key-value plane
  whitelists only `project|ticket|customer|sessionType|priority|tags` (store.mjs:2144).

### 3. HirePortal mapping
- Integration API (`POST /api/integrations/rooms`, bearer-auth, scoped) already supports
  `externalLink {objectType, objectId}` + `externalIdentity {externalUserId, emailHash}`
  (store.mjs:2884). candidate_id/recruiter_id fit as external identities/links, but the
  metadata whitelist blocks custom keys and there is **no scheduled-slot field**.
- Integration API gaps: cannot set TTL/schedule, no room-status read, no transcript/
  recording fetch, no participant allowlist control.
- Embed plane exists but origin allowlist is **hardcoded localhost-only**
  (store.mjs:1851 `normalizeLocalEmbedOrigin`).
- Webhooks are local-mock only — `room.created` recorded, never delivered
  (store.mjs:2709). Internal `onRoomEnded` callback exists (index.mjs:138) — natural
  hook point for a real outbound webhook.

### 4. Transcripts/recordings — mock, but schema is capture-ready
- `recording_artifacts` already has `storage_provider`/`storage_key`/`byte_size`/
  `duration_ms`/`source` placeholders (hardcoded `none`/null/0/`mock_metadata`).
- Per-participant consent tables + notice versioning + RBAC perms all real.
- Client: `localStreamRef` (main.jsx:556) and remote stream via `pc.ontrack`
  (main.jsx:610) are clean MediaRecorder tap points. No upload endpoint, no blob
  storage, no STT anywhere.
- README.md:34,143 explicitly review-gates real capture/storage/STT — TASK-0088 is
  that approval decision.
- Live captions = 3s polling (main.jsx:515), mock segments admin-injected only.

### 5. Admin end-call — exists
`endRoomForAll` (store.mjs:2541): status→ended, revokes all tokens, broadcasts
`room-ended`. UI exposure only.

### 6. Leave/rejoin + join window
- **Rejoin blocker:** disconnect revokes the access token (signaling.mjs:227 →
  `revokeAccess`, store.mjs:3116). Rejoin today = redo password flow. Seamless rejoin
  needs tokens that survive disconnect (revoke on room end/expiry instead) or a
  re-issuable participant credential.
- Occupancy is in-memory connected-peers only, so a leaver frees the slot — good.
- **No scheduling exists**: only `created_at` + `expires_at` (TTL default 24h, env
  `WEBRTC_ROOM_TTL_HOURS`). Join window needs `scheduled_start_at` (+ end, grace) on
  `rooms` and a new check inside `assertRoomJoinable` — which automatically covers all
  three enforcement points (public fetch, password, WS auth).

## Cross-cutting constraints discovered

- **1:1 hard cap** (`max_participants` default 2, P2P mesh not built for more).
- **No email-sending infrastructure** — invite mails / magic links would be net-new.
- **Everything is localhost-scoped by design** (embed origins, mock webhooks, no TURN,
  SQLite via node:sqlite) with an explicit production review gate in README.md:143.
- HirePortal (untouchable) is a UI Bakery browser app, Postgres via `datasources.yml`,
  session in sessionStorage — it has **no backend of its own to call our integration
  API from**; any server-to-server story needs clarification.

## Settled decisions (owner-confirmed, 2026-07-12)

1. **HirePortal is never modified.** It is the *client*: it will connect to this app's
   WS/APIs. All integration surface must be callable from a browser (CORS/origin
   allowlists), not server-to-server only. Owner does the portal-side config wiring.
2. **Media server: self-hosted LiveKit.** Replaces the P2P mesh for calls. Chosen
   because HirePortal already ships livekit-client v2.9 and mints LiveKit HS256 JWTs
   (room `hp-<candidateId>`) — it connects to our server with config-only changes.
   Our app remains the control plane: admin console, room policy, allowlists, join
   windows, token issuance, recording orchestration (egress).
3. **Room size: small panels, up to ~5** (candidate + recruiter + interviewers).
4. **Two admission paths:** (a) portal-signed LiveKit token → auto-admit (user is
   already authenticated in the portal); (b) direct link + email-allowlist match +
   room password. Email verification is honor-system + password; no magic-link email
   infra in scope.
5. **Rejoin: re-enter password** (or re-present portal token). No persistent
   participant credential needed; disconnect-revocation stays.
6. **Join window:** per-room configurable X minutes before scheduled start; default is
   a per-room setting; admin/host bypasses the window.
7. **Recording: LiveKit egress** (server-side, composite). **Transcripts: post-call**
   from the recording — no live STT. Provider: **cloud STT (OpenAI Whisper API or AWS
   Transcribe** — deployment is AWS; pick one at plan time).
8. **Storage: S3-compatible abstraction.** Local dev writes to a folder inside the
   WebRTC project; production uses an S3 bucket (AWS deploy).
9. **Consent: standard practice** — recorded interview rooms require consent to join
   (acknowledge-to-enter); existing consent tables/notice versioning reused.
10. **Deployment target: AWS.** Lift localhost-only assumptions (embed origins,
    HTTPS/origins, TURN via LiveKit's built-in) as part of the work.

Next step: /create-plan against these decisions.
