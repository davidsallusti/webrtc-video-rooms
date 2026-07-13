# TASK-0090 — Exploration notes (pre-implementation)

Companion to [TASK-0090-api-docs-swagger.md](TASK-0090-api-docs-swagger.md).

## Settled decisions (owner-confirmed, 2026-07-12)

1. **Access: admin-only.** Docs page + `/api/openapi.json` live behind the admin
   session; entry point is a link on the admin Integrations page.
2. **Scope: everything.** All ~75–80 operations documented in full detail
   (params, request/response schemas, error codes, auth, rate limits), admin
   plane included. Drift test covers every route.

## Endpoint inventory (spec surface)

- **Top-level (index.mjs):** health; POST/GET rooms; room access;
  livekit-token; portal access; LiveKit webhook ingest (doc as inbound-only).
- **Admin plane (admin.mjs, ~50 routes):** bootstrap/login/session/setup/logout;
  rooms list/create/detail; interview-config; lifecycle commands; policy; end;
  waiting decisions; chat (view/export/redact/delete/settings); transcripts
  (settings, mock controls, list/detail/export/redact/delete); recordings
  (settings, mock controls, start/stop/media/transcribe, list/detail/delete);
  embed (view/configure/sessions/revoke); integrations (overview/clients/revoke);
  global recordings/transcripts lists; global audit.
- **Participant control (admin.mjs second router, ~13 routes):** access-status,
  chat, transcript/recording status+consent, live-captions, waiting list +
  decisions, end.
- **Embed plane (embed.mjs, 3):** session exchange, room status, room access.
- **Integration plane (integrations.mjs, 3):** session, room create, room status.

## Implementation facts

- `swagger-ui-dist@5.32.8`: serve via `express.static(node_modules/swagger-ui-dist)`
  under an admin-gated route; replace the stock inline initializer with our own
  static `swagger-initializer.js` (CSP `script-src 'self'` forbids inline).
- CSP: docs route needs `style-src 'self' 'unsafe-inline'` (Swagger UI inline
  styles). `securityHeaders` in index.mjs already does route-scoped CSP for
  `/embed/*` — same pattern, keyed on the docs path.
- Spec: hand-written `docs/openapi.json` (OpenAPI 3.1), served by an
  admin-gated `GET /api/openapi.json` (or under `/api/admin/…`; decide at plan
  time — Swagger UI fetches it same-origin with cookies via `requestInterceptor`
  or default credentials).
- Security schemes: `integrationBearer` (http bearer), `participantAuth`
  (two AND-ed apiKey headers: x-participant-id + x-room-access-token),
  `adminSession` (cookie; mark mutating admin ops "documentation-only — CSRF
  protected", GETs are try-able with the active session).
- Drift test: import the routers, walk `router.stack` (mount prefixes are
  static strings), assert every method+path exists in the spec paths (after
  `:param` → `{param}` conversion), and vice versa.
- Integrations page entry: add an "API reference" button in
  `src/admin/misc-pages.jsx` linking to the docs route (opens full-page UI).

## Risks

- Spec accuracy is the effort sink (~80 ops); write from the route handlers +
  store validation, not from memory.
- Keep swagger assets out of the client bundle (no swagger-ui-react).
- The webhook route documents LiveKit-signed inbound traffic — mark explicitly
  as not user-callable.
