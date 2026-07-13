# Feature Implementation Plan — TASK-0088 HirePortal Video Service

**Overall Progress:** `100%` — all steps delivered; suite 38/38 green

Companion docs: [issue](TASK-0088-hireportal-video-service.md) · [exploration notes](TASK-0088-exploration.md)

## TLDR

Turn the WebRTC app into HirePortal's self-hosted interview video service (daily.co-style).
A self-hosted LiveKit server replaces the P2P mesh for media; this app stays the control
plane — admin console, room policy, candidate/recruiter mapping, join windows, invitee
allowlists, token issuance, recording (egress → S3) and post-call transcripts (cloud STT).
HirePortal is never modified: it already ships livekit-client and connects with
config-only changes on the owner's side.

## Critical Decisions

- **Self-hosted LiveKit SFU** — HirePortal already speaks LiveKit; gives server-side
  recording (egress), ~5-person panels, and built-in TURN. P2P mesh retired.
- **Two admission paths** — portal-signed LiveKit token → auto-admit; direct link →
  email-allowlist match + room password. Email is honor-system + password, no magic links.
- **Rejoin = re-enter password** (or re-present portal token); disconnect-revocation stays.
- **Join window** — per-room `scheduled_start_at` + grace minutes, enforced in
  `assertRoomJoinable` (covers all entry points); admin/host bypass.
- **Recording** — LiveKit egress → storage abstraction: local project folder in dev,
  S3-compatible bucket in prod (AWS deploy).
- **Transcripts** — post-call only, from the recording, via cloud STT (Whisper API or
  AWS Transcribe); stored in existing `transcript_*` tables behind existing RBAC.
- **Consent** — recorded rooms are acknowledge-to-enter (reuse consent tables/notice versioning).
- **No new scope** — no live captions/STT, no email sending, no HirePortal changes.

## Tasks:

- [x] 🟩 **Step 1: Schema & config foundation**
  - [x] 🟩 Add to `rooms`: `scheduled_start_at`, `scheduled_end_at`, `join_window_minutes`, `candidate_id`, `recruiter_id` (+ `livekit_room_name`)
  - [x] 🟩 New `room_invitees` table (room_id, email, role, created_at) + artifact CHECK-enum rebuild migration
  - [x] 🟩 Config/env plumbing: LiveKit URL + API key/secret, STT provider key, storage mode (local dir | S3), CORS origins
  - [x] 🟩 Store CRUD + validation for the new fields (create/update paths, admin + integration API)

- [x] 🟩 **Step 2: Participant identity & allowlist access**
  - [x] 🟩 Accept `email` (+ display name) in `POST /api/rooms/:roomId/access`; persist on access token/presence
  - [x] 🟩 Enforce allowlist in `validatePasswordAndIssueAccess` when room has invitees (email match + password)
  - [x] 🟩 Portal-token path: verify LiveKit-style HS256 JWT (shared secret) → auto-admit, map identity from claims (`POST /api/portal/access`)
  - [x] 🟩 Rejoin flow: same checks on re-auth; keep disconnect-revocation as-is

- [x] 🟩 **Step 3: Join window enforcement**
  - [x] 🟩 Add window check to `assertRoomJoinable` (too-early / after-end error codes)
  - [x] 🟩 Host/admin bypass; per-room default grace configurable at creation and editable in admin
  - [x] 🟩 Scheduled slot overrides generic TTL precedence (document in code where enforced)

- [x] 🟩 **Step 4: LiveKit media plane (replaces P2P)**
  - [x] 🟩 Dev setup: LiveKit server + egress via `docker-compose.livekit.yml`, `livekit/*.yaml`, `.env.example` (README pass in Step 9)
  - [x] 🟩 Server issues LiveKit room tokens after our access checks pass (`POST /api/rooms/:roomId/livekit-token`)
  - [x] 🟩 Client: swap RTCPeerConnection call UI to livekit-client (join, leave, mute, screen share, ~5 participants)
  - [x] 🟩 Map lifecycle: `endRoomForAll` → LiveKit room deletion; occupancy/presence from LiveKit webhooks
  - [x] 🟩 Retire signaling.mjs P2P relay (chat realtime moved to LiveKit data channel)

- [x] 🟩 **Step 5: Recording via egress + storage abstraction**
  - [x] 🟩 Storage adapter: `local` (data/recordings, gitignored) and `s3` (S3-compatible), one interface (server/storage.mjs)
  - [x] 🟩 Start/stop composite egress from admin console (new `recordings:manage` perm); auto-stop on room end
  - [x] 🟩 Write real values into `recording_artifacts` (source=livekit_egress, storage coords, byte_size, duration_ms)
  - [x] 🟩 Playback/download endpoint behind new `recordings:playback` perm (local stream / S3 presigned redirect)
  - [x] 🟩 Consent is acknowledge-to-enter for recording-enabled rooms (enforced at LiveKit token issuance)

- [x] 🟩 **Step 6: Post-call transcripts (cloud STT)**
  - [x] 🟩 STT job on egress_ended webhook: fetch media → provider (Whisper API; stub offline) → segments (server/stt.mjs)
  - [x] 🟩 Persist into existing `transcript_artifacts`/`transcript_segments` (source=recording_stt)
  - [x] 🟩 Job status tracking + bounded retries + manual re-run endpoint (`POST .../recordings/:id/transcribe`)
  - [x] 🟩 Export/redact/delete endpoints reused as-is; mock-segment injection stays gated behind `transcripts:manage_mock`

- [x] 🟩 **Step 7: Admin console & login polish**
  - [x] 🟩 Login page at /admin retained (route, layout, error states already first-class)
  - [x] 🟩 Room create form: schedule slot, join window, invitees, candidate_id/recruiter_id, max participants
  - [x] 🟩 Room detail: interview mapping editor, recording start/stop/play/transcribe, End for all, occupancy vs cap
  - [x] 🟩 Room list: search matches candidate_id/recruiter_id; schedule shown in detail

- [x] 🟩 **Step 8: Browser-callable integration surface (for HirePortal)**
  - [x] 🟩 CORS origin allowlist (`WEBRTC_CORS_ORIGINS`) for participant/portal/integration endpoints
  - [x] 🟩 Extend room-create API: schedule, invitees, candidate_id/recruiter_id, maxParticipants in request/response
  - [x] 🟩 `GET /api/integrations/rooms/:roomId` status endpoint (new `rooms:read` scope); remote embed origins behind `WEBRTC_EMBED_ALLOW_REMOTE_ORIGINS=1`
  - [x] 🟩 Connection contract documented in docs/integration/hireportal-contract.md

- [x] 🟩 **Step 9: AWS deployment readiness**
  - [x] 🟩 Production config: HTTPS origins, secrets via env, S3 storage mode, LiveKit deployment notes (docs/release/aws-deploy.md)
  - [x] 🟩 SQLite durability documented (volume mount); schema migrations are automatic at startup (addColumnIfMissing + artifact-table rebuild)
  - [x] 🟩 README rewritten: dev setup with docker-compose, scope, opened review gate

- [x] 🟩 **Step 10: Tests & verification**
  - [x] 🟩 tests/interview-rooms.test.mjs: allowlist gate, join window (early/bypass/opensAt), portal-token verify/tamper, consent-to-enter
  - [x] 🟩 Recording/transcript pipeline test with local storage + stubbed STT provider (egress webhook → finalized artifact → stub transcript)
  - [x] 🟩 End-to-end HTTP smoke: password join + portal join → media tokens → end-for-all → tokens refused (410); full suite 38/38
