# Local Release Prep Checklist

This checklist is local prep only. It does not approve npm publication, hosted examples, deploy/release, DNS/TLS, production credentials, vendors, paid resources, production persistence, object storage, TURN/SFU, real callbacks, real recording/media, broader public embed rollout, integration embed issuance, global security-header relaxation, or permission broadening.

## Current Private Package Boundary

- `package.json` must keep `"private": true`.
- The local browser SDK export is `./embed-sdk`, backed by `src/sdk/index.js`.
- Browser exports must stay limited to postMessage and iframe helper code from `src/embed-sdk.js`.
- Browser exports must not import `server/*`, database, filesystem, admin session/CSRF code, integration API-key logic, token minting helpers, or generated secrets.
- `examples/embed/server-helper.mjs` is trusted-backend-only guidance and must not be browser-bundled.

## Local Example Rules

- Examples remain in-repo source only.
- Examples must use local or review-configured origins and placeholders.
- Do not commit real room IDs, bootstrap tokens, session tokens, API keys, cookies, CSRF tokens, private endpoints, screenshots containing tokens, `.env` files, SQLite databases, logs, or build cache artifacts.
- Browser examples must distinguish iframe/browser SDK usage from trusted server-side session issuance.

## Required Local Gates Before Any Future Public Action

- `npm run lint`
- `npm test`
- `npm run build`
- `npm audit --omit=dev`
- `npm run release:inspect`
- Local production-mode smoke with `npm start`
- `/api/health` check against the local production server
- Static scan for forbidden publish/deploy/provider/storage/media/callback/TURN/SFU/DNS/credential surfaces
- Sentry review
- Rex review
- Tess QA
- David approval for any public/external/production action

## Future Hosted Review Checklist

These are planning notes only. Do not execute them in this local prep slice.

- Confirm no-spend or paid-resource posture with David.
- Confirm hosting provider, service shape, rollback plan, and cleanup plan with Rex.
- Confirm `WEBRTC_PUBLIC_ORIGIN`, trusted proxy behavior, and security headers with Sentry/Rex.
- Confirm production admin bootstrap procedure, secret ownership, and redaction rules.
- Confirm persistence plan. Ephemeral SQLite is only for disposable review; durable data requires a separate persistence/migration gate.
- Confirm whether TURN/SFU, object storage, real callbacks, real recording/media, integration embed issuance, or public SDK distribution are still out of scope or separately approved.

## Future Production Data Gates

- Add migration versioning before durable production persistence.
- Test backup/restore in a disposable environment before durable release.
- Re-review retained chat, transcripts, recording metadata, audit, integrations, and embed sessions with Sentry before production retention.
- Do not add managed databases, persistent disks, buckets, signed URLs, TURN/SFU credentials, provider SDKs, or vendor callbacks without Rex/Sentry/David approval.
