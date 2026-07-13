# WebRTC Rooms — HirePortal Video Service

Password-protected interview video rooms (TASK-0080/0082/0086/0087), rebuilt in
TASK-0088 as HirePortal's self-hosted video service: LiveKit media plane,
candidate/recruiter mapping, invitee allowlists, join windows, real recordings
(egress → local folder or S3), and post-call transcripts.
Portal wiring contract: [docs/integration/hireportal-contract.md](docs/integration/hireportal-contract.md).
**Complete documentation with architecture diagrams: [DOCUMENTATION.md](DOCUMENTATION.md).**

## Run Locally

```bash
cp .env.example .env                              # LiveKit + storage config
docker compose -f docker-compose.livekit.yml up   # media plane (LiveKit + egress)
npm run dev:api
npm run dev:vite
```

Frontend: `http://127.0.0.1:5180`  
API: `http://127.0.0.1:4321` · LiveKit: `ws://127.0.0.1:7880`

Without a LiveKit server, everything except the in-call media works; the call
screen reports "Media server offline".

## Scope

- Vite + React frontend.
- Node/Express API (control plane).
- SQLite room and access-token storage via `node:sqlite`.
- LiveKit SFU media plane (`livekit-client` in the browser, `livekit-server-sdk`
  token issuance/egress/webhooks on the server); rooms up to 5 participants.
- Interview mapping per room: HirePortal `candidate_id`/`recruiter_id`, invitee
  email allowlist, scheduled slot with configurable join window (host/admin bypass).
- Room recordings via LiveKit composite egress into a storage adapter
  (`local` project folder for dev, S3-compatible bucket for production) with
  acknowledge-to-enter consent, playback/download RBAC, and audit.
- Post-call transcription of recordings (OpenAI Whisper API, offline stub for
  dev/tests) into the existing transcript tables and RBAC.
- Portal join paths: HirePortal-minted LiveKit JWTs accepted at
  `POST /api/portal/access` (auto-admit) or directly by the LiveKit server.
- Scrypt password hashing with per-room salt.
- Opaque short-lived access tokens.
- Server-side occupancy limit (per-room cap, 2–5).
- Separate admin/operator auth plane at `/admin` with bootstrap setup, session cookies, CSRF checks, RBAC foundations, audit events, room visibility, admin room creation, local lifecycle controls, room search/filtering, policy toggles, and lifecycle history.
- Separate local integration plane at `/api/integrations/*` with server-to-server bearer credentials, hashed API keys, scoped local clients, external room link records, linked external identities, admin-only projections, audit events, and local mock webhook delivery records.
- Local retained text chat, disabled by default per room, with explicit chat RBAC, participant admission/status checks, capped message size/rate/list/export behavior, audit events without message bodies, and redaction/delete projections.
- Local mock transcripts and live captions, disabled by default per room, with participant notice acknowledgement, explicit transcript RBAC, `mock_local` provider segments only, JSON export, audit events without segment bodies, and redaction/delete projections.
- Local mock recording metadata, disabled by default per room, with a separate participant notice acknowledgement, explicit recording RBAC, metadata-only mock start/finalize/fail/delete controls, and media-free audit events.
- Local-only iframe/embed foundations with route-scoped `/embed/*` frame policy, exact local origin allowlists, short-lived hashed scoped embed sessions, embed-safe APIs, validated postMessage helpers, explicit `embed:*` RBAC, and in-repo local examples only.

TASK-0088 opened the previous review gate for media capture: real recordings (LiveKit egress), media storage (local folder or S3), playback/download, and post-call cloud STT are now in scope and RBAC/consent-gated. Still excluded: live captions from real audio, browser speech APIs, real outbound webhooks, public SDK package, hosted public examples, and analytics.

## Admin Bootstrap

The admin console is a local platform operations slice, not a full production operations suite.

Local/development bootstrap can use:

```bash
ADMIN_BOOTSTRAP_EMAIL=admin@webrtc.local
ADMIN_BOOTSTRAP_PASSWORD=ChangeMe-Admin-0086!
```

Production/public admin activation must provide environment-owned bootstrap credentials using `ADMIN_BOOTSTRAP_EMAIL` plus either `ADMIN_BOOTSTRAP_PASSWORD` or `ADMIN_BOOTSTRAP_PASSWORD_HASH`. The known local default password is refused in production, and the first successful bootstrap login must rotate the password before normal admin room visibility is available.

Admin sessions are stored server-side, sent as `HttpOnly` same-site cookies, and protected by CSRF tokens for mutating admin actions. Participant room tokens do not authorize `/api/admin/*`, and admin sessions do not authorize participant media credentials (`/api/rooms/:roomId/livekit-token`).

Current local admin lifecycle commands include create, lock, unlock, expire, disable, extend, and end-for-all. These commands are RBAC-gated, CSRF-protected, audit logged, and recorded in room lifecycle history.

Local waiting-room controls are also available when room policy enables them. Guests can be held after password validation, hosts can admit or reject pending guests, admins with waiting-room permissions can assist, and pending guests cannot authenticate signaling until admitted.

Local retained chat is opt-in per room and text-only. Participants can read or send retained chat only with valid header-based room credentials, admitted access, and an active room. Admin chat body access is controlled by `chat:view`, export by `chat:export`, redaction by `chat:redact`, delete by `chat:delete`, and room retention settings by `chat:configure_retention`. Audit entries record chat actions without message bodies or previews.

Local mock transcripts and live captions are also opt-in per room. Participants can poll caption segments only after valid header credentials, admitted access, active room status, enabled room policy, and transcript notice acknowledgement. The only transcript provider in this local slice is `mock_local`; admins append deterministic mock text segments for testing. Transcript body access is controlled by `transcripts:view`, export by `transcripts:export`, redaction by `transcripts:redact`, delete by `transcripts:delete`, settings by `transcripts:configure`, and mock controls by `transcripts:manage_mock`.

Room recording is opt-in per room and acknowledge-to-enter: when recording is enabled, participants cannot obtain media credentials until they acknowledge the recording notice. Real recordings (`source=livekit_egress`) are started/stopped by admins with `recordings:manage`, auto-stop on room end, store media through the storage adapter (never in SQLite), and hide storage keys from all projections — playback goes through `GET /api/admin/rooms/:roomId/recordings/:id/media` behind `recordings:playback`. Finalized recordings are transcribed automatically (post-call, `source=recording_stt`); failed jobs retry with bounds and can be re-run via `recordings:manage`. Legacy mock metadata artifacts remain readable and gated behind `recordings:manage_mock`.

Local integration controls are server-to-server only. Admins with integration permissions can create scoped local clients and inspect client prefixes, linked systems, room external links, external identities, and local mock webhook attempts. API keys are returned only once at creation, stored hashed, and never exposed in admin projections or browser bundles. Webhook attempts are recorded locally for verification; the app does not send real external callbacks without a separate approval and security/release review.

Local embed controls are private-by-default and route-scoped. Non-embed routes keep `frame-ancestors 'none'`; only `/embed/rooms/:roomId` can be framed, and only by exact configured local origins. Admins with explicit `embed:*` permissions can configure local origins, issue short-lived one-time bootstrap tokens, inspect metadata-only sessions, and revoke sessions. Browser embed sessions are distinct from admin cookies, CSRF tokens, and integration API keys. In-repo examples live under `examples/embed/` and are local-only placeholders, not a published SDK or hosted demo.

## Local SDK And Release Prep

The package remains private and unpublished. The local browser SDK boundary is prepared for review through the private package export `./embed-sdk`, backed by `src/sdk/index.js` and `src/embed-sdk.js`. This export is browser-only helper code for embed frame creation and postMessage validation; it must not import server, admin, integration, database, filesystem, token-minting, CSRF, or secret-handling modules.

Local prep checks:

```bash
npm run release:inspect
```

The release inspection script verifies that the package is still private, the browser SDK export excludes server/admin/integration modules, examples remain configurable local source, and forbidden publish/deploy/provider/storage/media/callback surfaces were not added.

Release checklist:

- `docs/release/local-prep-checklist.md`
- `docs/release/hosted-review-prep-checklist.md`

These checklists are planning documentation only. They do not approve npm publication, hosted examples, deploy/release, DNS/TLS, production credentials, vendors, paid resources, production persistence, object storage, TURN/SFU, real callbacks, real recording/media, broader public embed rollout, integration embed issuance, global security-header relaxation, or permission broadening.

## Render Preparation

Rex guidance for the first public review is one no-spend Render Web Service rooted at `projects/WebRTC`. This section is hosted-review preparation only; Bernard must not create or modify provider resources from this repo without a separate deploy route.

Recommended manual settings:

- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Health check path: `/api/health`
- Node version: `24.14.1`
- Instance count: `1`
- Service tier: Free only for a disposable no-spend review

Required environment variables for no-spend review:

```bash
NODE_VERSION=24.14.1
NODE_ENV=production
WEBRTC_DB_PATH=/tmp/webrtc.sqlite
WEBRTC_PUBLIC_ORIGIN=https://your-render-service.onrender.com
WEBRTC_ROOM_TTL_HOURS=24
VITE_WEBRTC_ICE_SERVERS_JSON='[{"urls":"stun:stun.l.google.com:19302"}]'
```

Optional hardening/config variables:

```bash
WEBRTC_TRUST_PROXY=1
WEBRTC_ROOM_CREATE_LIMIT=12
WEBRTC_ROOM_CREATE_WINDOW_MS=300000
WEBRTC_ACCESS_ATTEMPT_LIMIT=30
WEBRTC_ACCESS_ATTEMPT_WINDOW_MS=60000
WEBRTC_PASSWORD_ATTEMPT_LIMIT=8
WEBRTC_PASSWORD_ATTEMPT_WINDOW_MS=60000
WEBRTC_WS_MAX_PAYLOAD_BYTES=32768
WEBRTC_WS_AUTH_TIMEOUT_MS=10000
WEBRTC_WS_CONNECT_LIMIT=60
WEBRTC_WS_AUTH_FAILURE_LIMIT=12
WEBRTC_WS_MESSAGE_LIMIT=120
WEBRTC_ADMIN_SESSION_TTL_MS=28800000
WEBRTC_ADMIN_IDLE_TTL_MS=2700000
WEBRTC_ADMIN_LOGIN_LIMIT=8
WEBRTC_ADMIN_LOGIN_WINDOW_MS=60000
WEBRTC_INTEGRATION_AUTH_LIMIT=20
WEBRTC_INTEGRATION_AUTH_WINDOW_MS=60000
WEBRTC_CHAT_MESSAGE_LIMIT=20
WEBRTC_CHAT_MESSAGE_WINDOW_MS=60000
WEBRTC_TRANSCRIPT_SEGMENT_LIMIT=20
WEBRTC_TRANSCRIPT_SEGMENT_WINDOW_MS=60000
WEBRTC_EMBED_SESSION_TTL_MS=600000
```

Deployment notes (AWS target — see [docs/release/aws-deploy.md](docs/release/aws-deploy.md)):

- SQLite is the durable store; mount `data/` (DB + local recordings) on a persistent volume, or set `WEBRTC_DB_PATH` and `WEBRTC_STORAGE_MODE=s3`. Schema migrations run automatically at startup (`addColumnIfMissing` + one-time artifact-table rebuild).
- Recording capture, media storage (local/S3), playback/download, and post-call cloud STT were approved and delivered under TASK-0088; they stay RBAC- and consent-gated. Live captions from real audio, real outbound webhook sends, and a public SDK remain review-gated.
- TURN is provided by the LiveKit deployment (built-in TURN/TLS) rather than a separate vendor.
- Remote embed origins require `WEBRTC_EMBED_ALLOW_REMOTE_ORIGINS=1` and https; browser API access from the portal requires its origin in `WEBRTC_CORS_ORIGINS`.
- Production admin bootstrap still requires environment-owned credentials (`ADMIN_BOOTSTRAP_EMAIL` + `ADMIN_BOOTSTRAP_PASSWORD[_HASH]`); the local default password is refused in production.
