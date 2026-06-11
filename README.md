# WebRTC Rooms

Password-protected 1:1 WebRTC room MVP for TASK-0080/TASK-0082.

## Run Locally

Use two terminals:

```bash
npm run dev:api
npm run dev:vite
```

Frontend: `http://127.0.0.1:5180`  
API/signaling: `http://127.0.0.1:4321`

## Scope

- Vite + React frontend.
- Node/Express API.
- SQLite room and access-token storage via `node:sqlite`.
- `ws` signaling at `/ws/signaling`.
- Native `RTCPeerConnection` P2P with configurable ICE servers and public STUN by default.
- Scrypt password hashing with per-room salt.
- Opaque short-lived access tokens.
- Server-side two-participant occupancy limit.

No TURN/SFU, paid service, production credentials, media recording, SDP/ICE persistence, or analytics are included in this slice.

## Render Preparation

Rex guidance for the first public review is one Render Web Service rooted at `projects/WebRTC`.

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
WEBRTC_ROOM_TTL_HOURS=24
VITE_WEBRTC_ICE_SERVERS_JSON='[{"urls":"stun:stun.l.google.com:19302"}]'
```

Optional hardening/config variables:

```bash
WEBRTC_PUBLIC_ORIGIN=https://your-render-service.onrender.com
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
```

Public review limitations:

- `/tmp/webrtc.sqlite` is ephemeral. Rooms, tokens, and presence can disappear on restart, redeploy, rollback, or free-service spin-down.
- Direct P2P with public STUN is not guaranteed across restrictive NAT/firewall networks. TURN requires separate David approval for provider choice, credentials, and possible spending.
- Do not publish, create paid resources, add persistent disks/Postgres, configure TURN, inject secrets, or change DNS without explicit approval.
