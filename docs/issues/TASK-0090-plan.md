# Feature Implementation Plan — TASK-0090 Interactive API Docs (Swagger)

**Overall Progress:** `100%` — delivered; 42/42 tests, drift check green, try-it verified live

Companion docs: [issue](TASK-0090-api-docs-swagger.md) · [exploration notes](TASK-0090-exploration.md)

## TLDR

Admin-gated Swagger UI, linked from the Integrations page, backed by a
hand-written OpenAPI 3.1 spec covering all ~80 operations across the five
planes (participant / portal / integration / embed / admin) with full schemas,
error codes, auth, and rate-limit notes. "Try it out" works with integration
bearer keys and participant credential headers. A drift test keeps the spec in
lockstep with the live Express routes.

## Critical Decisions

- **Admin-only access** — docs page and `/api/openapi.json` sit behind the
  admin session; entry point on the Integrations page (owner decision).
- **Full coverage** — every endpoint documented in detail, admin plane included
  (owner decision).
- **Self-hosted `swagger-ui-dist`** via `express.static` — no CDN (CSP
  `script-src 'self'`), no `swagger-ui-react` (keeps the app bundle flat);
  custom static `swagger-initializer.js` replaces the stock inline one.
- **Route-scoped CSP relaxation** — docs route gets `style-src 'unsafe-inline'`
  only, following the existing per-route CSP pattern in `securityHeaders`.
- **Hand-written `docs/openapi.json`** served by an admin-gated endpoint;
  accuracy written from route handlers + store validation, not memory.
- **Security schemes:** `integrationBearer` (http bearer), `participantAuth`
  (AND-ed `x-participant-id` + `x-room-access-token` apiKey headers),
  `adminSession` (cookie; mutating admin ops marked documentation-only — CSRF).

## Tasks:

- [x] 🟩 **Step 1: OpenAPI spec — external planes** (implemented as a JS builder `server/openapi.mjs` exporting the 3.1 document — DRYer than raw JSON, same serving contract)
  - [x] 🟩 Spec skeleton: info, servers, tags (Participant / Portal / Integration / Embed / Admin / Webhooks), securitySchemes, shared error schema
  - [x] 🟩 Participant plane (19 ops): rooms create/info, access, livekit-token, access-status, chat, transcript/recording status+consent, live-captions, waiting list/decisions, end
  - [x] 🟩 Portal + Integration + Embed planes (7 ops) and LiveKit webhook ingest (documented as inbound-only)

- [x] 🟩 **Step 2: OpenAPI spec — admin plane (50 ops; 71 paths / 76 operations total)**
  - [x] 🟩 Auth/session group: bootstrap status/login, login, session, setup/password, logout
  - [x] 🟩 Rooms group: list/create/detail, interview-config, lifecycle commands, policy, end, waiting decisions
  - [x] 🟩 Artifact groups: chat, transcripts, recordings (incl. start/stop/media/transcribe), embed, integrations, global recordings/transcripts/audit
  - [x] 🟩 Each op: params, request/response schemas, error codes, required permission/scope, rate-limit notes; mutating ops marked CSRF documentation-only

- [x] 🟩 **Step 3: Serving + UI**
  - [x] 🟩 Install `swagger-ui-dist`; admin-gated routes: `GET /api/openapi.json` (spec) and `/api/admin/docs/*` (static UI assets + custom initializer)
  - [x] 🟩 Custom `swagger-initializer.js`: same-origin spec URL, credentials included, persistAuthorization
  - [x] 🟩 Route-scoped CSP: `style-src 'unsafe-inline'` for the docs route only
  - [x] 🟩 "API reference" link on the admin Integrations page

- [x] 🟩 **Step 4: Drift test + verification**
  - [x] 🟩 Test: walk Express router stacks (static mount prefixes), assert live routes ⊆ spec paths and spec paths ⊆ live routes (`:param` ↔ `{param}`)
  - [x] 🟩 Test: docs route requires admin session; spec endpoint denies anonymous
  - [x] 🟩 Lint, build, full suite green; preview walkthrough (open docs from Integrations, authorize with an API key, exercise one integration endpoint)
