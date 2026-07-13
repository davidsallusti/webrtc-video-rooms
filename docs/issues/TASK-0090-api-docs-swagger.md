# TASK-0090 — Interactive API docs (Swagger/OpenAPI) under Integrations

**Type:** feature · **Priority:** normal · **Effort:** medium
**Status:** delivered 2026-07-12 (see [TASK-0090-plan.md](TASK-0090-plan.md)) · **Created:** 2026-07-12

## TL;DR

Add a Swagger-style interactive API reference: every endpoint documented
(params, bodies, responses, error codes, auth), with "Try it out" so an
operator can paste an integration API key (or participant credentials) and
exercise endpoints live. Surfaced from the admin **Integrations** section.

## Current state

- No machine-readable API spec exists; the only endpoint documentation is
  prose in [docs/integration/hireportal-contract.md](../integration/hireportal-contract.md) and README.
- Integration clients get an API key from the Integrations page but have no
  way to explore or test what it can call.
- API surface to cover: public participant endpoints (`/api/rooms/*`,
  access/livekit-token/chat/consent/status), portal access (`/api/portal/access`),
  integration API (`/api/integrations/*`, bearer auth), LiveKit webhook ingest
  (document-only), and the admin API (document; "try it" limited since it is
  cookie+CSRF).

## Expected outcome

- **OpenAPI 3.1 spec** checked into the repo (`docs/openapi.json` or built from
  route metadata) and served at `GET /api/openapi.json`.
- **Docs page** reachable from the admin Integrations page (e.g.
  `/admin/integrations` → "API reference" link/tab): rendered Swagger UI with
  endpoint list grouped by plane (Participant / Portal / Integration / Admin /
  Webhooks), full descriptions, schemas, auth requirements, and error codes.
- **Try it out** with auth inputs: bearer API key (integration plane) and
  `x-participant-id` / `x-room-access-token` headers (participant plane);
  requests run against the same origin.
- Every endpoint's description explains capabilities and constraints
  (rate limits, RBAC/scopes, join-window and consent behavior).

## Relevant files

- [server/index.mjs](../../server/index.mjs) — serve spec + swagger assets (mind CSP: bundle locally, no CDN; may need route-scoped `style-src 'unsafe-inline'`)
- [src/admin/misc-pages.jsx](../../src/admin/misc-pages.jsx) — Integrations page entry point/link
- `docs/openapi.json` (new) — the spec itself

## Risks / notes

- **CSP:** current policy is `script-src 'self'`/`style-src 'self'`; Swagger UI
  needs locally served assets (`swagger-ui-dist` npm package, no CDN) and uses
  inline styles — scope any CSP relaxation to the docs route only.
- **Spec drift:** hand-written spec will rot; add a test that asserts every
  Express route appears in the spec (route-inventory vs spec paths).
- **Secrets:** docs page must never embed real keys; keys are pasted by the
  user per-session. Admin "try it" is naturally limited by CSRF — acceptable to
  mark admin endpoints as documentation-only.
- Bundle: prefer `swagger-ui-dist` served by express over `swagger-ui-react`
  (keeps the 750KB+ app bundle from growing).
