# AWS Deployment Notes — TASK-0088

Target shape: one small app host (ECS/EC2/Lightsail) for this API + static
frontend, a LiveKit deployment, and an S3 bucket for recordings.

## Components

1. **App (this repo)** — `npm run build` then `NODE_ENV=production node server/index.mjs`
   (serves `dist/` and the API on one port).
2. **LiveKit** — either LiveKit Cloud or self-hosted
   ([livekit/livekit-server](https://github.com/livekit/livekit-server) behind a
   network load balancer; UDP range + 7880/7881). Register BOTH keypairs from
   `.env` (`webrtc-app` and the HirePortal pair) in the server's `keys:` config,
   and point its `webhook.urls` at `https://<app>/api/livekit/webhooks`
   (`webhook.api_key: <our key>`).
3. **Egress** — LiveKit egress workers with the S3 credentials; in s3 mode the
   app passes bucket coordinates per-egress, so egress needs outbound S3 access
   only.
4. **S3 bucket** — private; the app issues presigned GETs for playback
   (`WEBRTC_S3_PRESIGN_TTL_SECONDS`, default 15 min).

## Environment

Everything in [.env.example](../../.env.example), plus production values:

```bash
NODE_ENV=production
WEBRTC_PUBLIC_ORIGIN=https://video.example.com
WEBRTC_DB_PATH=/var/data/webrtc.sqlite        # persistent volume
WEBRTC_STORAGE_MODE=s3
WEBRTC_CORS_ORIGINS=https://hireportal.example.com
WEBRTC_EMBED_ALLOW_REMOTE_ORIGINS=1           # only if the portal iframes rooms
ADMIN_BOOTSTRAP_EMAIL=...                     # environment-owned
ADMIN_BOOTSTRAP_PASSWORD_HASH=...
WEBRTC_STT_PROVIDER=openai
WEBRTC_OPENAI_API_KEY=...                     # from Secrets Manager
```

## Durability

- SQLite lives on a mounted volume (EBS/EFS). Startup migrations are
  idempotent: `addColumnIfMissing` for new columns and a one-time rebuild of
  `transcript_artifacts`/`recording_artifacts` to widen their CHECK enums
  (existing rows preserved — see `rebuildTableForCheck` in server/store.mjs).
- Recordings in s3 mode never touch the app disk; local mode is dev-only.

## Connectivity

- TURN: enable LiveKit's built-in TURN (`turn:` block with TLS + certificate)
  so candidates behind strict NATs connect; no separate TURN vendor.
- The app's CSP `connect-src` automatically includes the configured LiveKit
  origin; HSTS is emitted when requests arrive over https.

## Checklist

- [ ] LiveKit reachable from candidate networks (wss + TURN/TLS 443)
- [ ] Webhooks arrive (create a room, join, watch `room_presence` fill)
- [ ] Recording end-to-end: start → stop → artifact finalized → media plays via presigned URL
- [ ] Transcript artifact finalizes after recording (or `transcribe` re-run works)
- [ ] Portal origin in CORS; portal token accepted at `POST /api/portal/access`
- [ ] Admin bootstrap rotated; `.env` secrets sourced from Secrets Manager
