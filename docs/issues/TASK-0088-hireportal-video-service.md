# TASK-0088 — Rethink WebRTC app as HirePortal's hosted video service (daily.co-style)

**Type:** feature (epic) · **Priority:** high · **Effort:** large (multi-sprint)
**Status:** scoped — requirements settled 2026-07-12 (see "Settled decisions") · **Created:** 2026-07-12

## TL;DR

Reposition the WebRTC app as the dedicated video-interview backend for HirePortal
(`/Users/ai/Desktop/HirePortal 2/`), replacing its current direct LiveKit integration.
Admin creates interview rooms, maps them to HirePortal candidates/recruiters, and controls
the call lifecycle (end, transcripts, recordings) — like a self-hosted daily.co.
**HirePortal itself must not be modified** — all integration happens from the WebRTC side
via its existing integration API plane.

## Current state

- 1:1 P2P rooms (native RTCPeerConnection, `ws` signaling at `/ws/signaling`), SQLite store.
- Already built: admin login (email/password, sessions, CSRF, 4-role RBAC), room creation
  with per-room scrypt passwords, access tokens, waiting room with host admit/reject,
  lock/disable/extend/end-for-all, room TTL, audit log, embed iframe SDK, and a
  server-to-server integration API (bearer auth, external room links, linked identities).
- Transcripts and recordings are **metadata-only mocks** — no real media capture, storage,
  or speech-to-text.
- No email-based participant allowlist, no join-window enforcement, no candidate/recruiter
  mapping, no scheduled-call semantics.
- HirePortal side (reference only, do not touch): candidates table has `id`, `recruiter_id`,
  `interview_status`, `scheduled_slot_id`; users in `app_users` (`role: recruiter|candidate`,
  `email`); video currently goes through LiveKit cloud
  (`src/app/config/livekit.ts`, `src/app/components/VideoCallPanel.tsx`) with the API secret
  exposed in frontend config.

## Expected outcome

1. **Admin login** — exists; polish into a first-class login page for the room console.
2. **Room creation & access control** — create rooms with password AND/OR invitee
   allowlist (specific emails/users), or open link+password. Per-room policy toggle.
3. **HirePortal session support** — rooms attachable to a HirePortal meeting/interview:
   store `candidate_id`, `recruiter_id`, and scheduled slot on the room (external-links
   plane already exists; extend it). HirePortal embeds via the existing iframe SDK or a
   join URL — no HirePortal code changes.
4. **Transcripts & recordings (real, daily.co-like)** — replace mocks: capture media
   (MediaRecorder or SFU-side), durable storage, speech-to-text pipeline, playback/export
   behind existing RBAC + consent flow.
5. **Admin end-call** — exists (`end-for-all`); expose prominently in console and audit it.
6. **Leave / rejoin / join window** — participants can leave and re-enter while the room is
   live; enforce "invited users only" and "link valid only within X minutes before the
   scheduled start" (configurable grace before/after).
7. **Additional features (proposed)** — lobby with device check (cam/mic preflight),
   scheduled auto-expiry after interview slot ends, recruiter-visible interview questions
   panel, post-call summary webhook back to the portal's `ai_summary`, screen share,
   in-call chat (exists — retained chat), participant network-quality indicators,
   TURN server for NAT-restricted candidates.

## Integration contract (WebRTC side only)

- Room links to portal entities: `candidate_id` (TEXT, e.g. `u2-candidate`),
  `recruiter_id` (TEXT), optional `scheduled_slot` `{date, startTime, endTime}` — used to
  drive the join-window rule.
- Portal creates rooms server-to-server via the existing bearer-auth integration API and
  receives back the join URL / embed config.
- Invitee identity = email match against room allowlist (portal users are keyed by email).

## Relevant files

- [server/store.mjs](server/store.mjs) — schema: room↔candidate/recruiter mapping, allowlists, join windows, recording artifacts
- [server/integrations.mjs](server/integrations.mjs) — extend server-to-server API for portal room provisioning
- [server/signaling.mjs](server/signaling.mjs) — rejoin semantics, join-window enforcement, >2 participants if needed

## Risks / notes

- **Real recording/transcription is the big lift** — needs media storage and an STT
  pipeline; P2P-only architecture makes server-side recording hard (client-side
  MediaRecorder upload is the pragmatic first step; SFU is the long-term answer).
- **P2P 1:1 cap** — fine for interviews (candidate + recruiter), but panel interviews
  (3+) would force an SFU migration. Decide early.
- **Join-window + rejoin interact with room TTL** — define precedence (scheduled slot
  should override generic TTL).
- **HirePortal's LiveKit API secret is exposed in its frontend config**
  (`src/app/config/livekit.ts`) — out of scope here (portal is untouchable), but flag to
  the portal owner; migrating to this self-hosted service removes that exposure.
- No TURN server today — remote candidates behind strict NATs will fail to connect.
