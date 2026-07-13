# Hosted Review Prep Checklist

This checklist prepares a future hosted review. It does not deploy, create a public URL, create provider resources, change DNS/TLS, create production credentials, spend money, enable production persistence, or change production.

## Approved Prep Boundary

- Target shape: one no-spend Node web service for disposable review only.
- Service count: `1`.
- Package posture: keep `package.json` private and do not publish to npm, a CDN, or hosted SDK docs.
- Data posture: use disposable SQLite only. Do not add managed databases, persistent disks, backups, object storage, media storage, or durable production data promises.
- Network posture: keep exact `WEBRTC_PUBLIC_ORIGIN` and trusted proxy settings documented for a later approved review URL.
- Security posture: preserve non-embed `frame-ancestors 'none'`, route-scoped embed ancestors, same-origin admin/API access, admin CSRF, admin cookie scoping, production refusal of the known local bootstrap password, and body-free audit boundaries.

## Future Manual Settings

These values are documentation for a separately approved deploy route. Do not create or modify provider resources in this prep slice.

| Setting | Required value |
| --- | --- |
| Root directory | `projects/WebRTC` |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Health path | `/api/health` |
| Runtime | Node `24.14.1` |
| Instance count | `1` |
| Tier | No-spend/free review tier only |

## Required Environment Variables

Use placeholder values in docs and task records. Do not commit, print, screenshot, or transmit real secrets.

```bash
NODE_VERSION=24.14.1
NODE_ENV=production
WEBRTC_DB_PATH=/tmp/webrtc.sqlite
WEBRTC_PUBLIC_ORIGIN=https://REVIEW-SERVICE.example.invalid
WEBRTC_TRUST_PROXY=1
WEBRTC_ROOM_TTL_HOURS=24
VITE_WEBRTC_ICE_SERVERS_JSON='[{"urls":"stun:stun.l.google.com:19302"}]'
```

Admin bootstrap for any later hosted review must use environment-owned values and a separate credential-handling route. Do not place `ADMIN_BOOTSTRAP_EMAIL`, bootstrap passwords, password hashes, API keys, cookies, CSRF tokens, room access tokens, integration client secrets, or embed session tokens in committed files, screenshots, logs, package artifacts, or public handoffs.

## Recommended Review Knobs

Keep these configurable for a future review service:

```bash
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

## Local Verification Before Review

Run these locally before any later hosted route:

```bash
npm run release:inspect
npm run lint
npm test
npm run build
npm audit --omit=dev
PORT=4420 WEBRTC_DB_PATH=/tmp/webrtc-hosted-review-prep.sqlite WEBRTC_PUBLIC_ORIGIN=http://127.0.0.1:4420 NODE_ENV=production npm start
```

With the disposable production server running, collect local-only evidence:

```bash
curl -i http://127.0.0.1:4420/api/health
curl -i http://127.0.0.1:4420/
curl -i http://127.0.0.1:4420/api/debug/rooms
curl -i -H 'Host: evil.example' http://127.0.0.1:4420/api/health
curl -i -X POST http://127.0.0.1:4420/api/admin/rooms
```

Expected local evidence:

- `/api/health` returns `200`.
- `/` returns `200` after `npm run build`.
- Non-embed routes include `frame-ancestors 'none'`.
- `/api/debug/rooms` returns `404`.
- Bad host/origin probes return `403 origin_not_allowed` when `WEBRTC_PUBLIC_ORIGIN` is set.
- Mutating admin requests without CSRF/session fail.
- WebSocket origin/auth denial remains covered by automated tests or a separate local smoke.
- No real admin credentials are shown in logs, screenshots, package artifacts, or task records.

Stop the server and remove the disposable SQLite file after the smoke:

```bash
rm -f /tmp/webrtc-hosted-review-prep.sqlite
```

## Rollback Plan For A Later Approved Review Service

- Roll back code by redeploying the previously approved commit or reverting the review commit.
- Treat `/tmp/webrtc.sqlite` as disposable. Room, token, admin bootstrap, retained chat, transcript, recording metadata, embed, and integration review state can be lost on restart, redeploy, rollback, free-tier sleep, or service recreation.
- Do not promise restore, backup, or durable retained data for the no-spend review baseline.
- Durable production data requires a separate persistence, migration, backup, restore, redaction/delete, and rollback checkpoint.

## Cleanup Plan For A Later Approved Review Service

- Delete the temporary review service after acceptance or timeout.
- Remove any environment variables from the provider dashboard.
- Confirm the temporary URL no longer serves `/`, `/api/health`, `/embed/*`, `/api/admin/*`, `/api/integrations/*`, `/api/portal/*`, or `/api/livekit/webhooks`.
- Record the service name, URL, commit, deploy ID, cleanup date, and owner in the release handoff without secret values.
- Do not leave paid resources, persistent disks, managed databases, buckets, TURN/SFU allocations, callback endpoints, or monitoring vendors running.

## Separate Checkpoints Required

Stop for David/Rex/Sentry routing before any of these become concrete:

- Actual deploy, public URL creation, hosted demo distribution, or public package publication.
- Paid tier, payment method, usage-based provider, persistent disk, managed database, object storage, monitoring vendor, analytics vendor, email/SMS provider, TURN/SFU, media service, or other spend.
- DNS record, custom domain, custom TLS/certificate, HSTS domain policy, or global security-header relaxation.
- Production credential creation, rotation, storage, delivery, provider API token use, or admin bootstrap secret handling.
- Production persistence, migrations, backup/restore, durable retained-data promises, or production rollout.
- Real callbacks, real external callbacks, vendor egress, public callback endpoints, or integration-issued embed sessions.
- Real media, real speech-to-text, browser speech APIs, media capture, recording bytes, upload, playback, download/export, signed URLs, or media retention.
- Permission broadening, broader public embed rollout, hosted SDK distribution, or production integration API key issuance.
