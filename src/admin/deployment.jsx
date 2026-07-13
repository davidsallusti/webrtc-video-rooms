import { Link } from 'react-router-dom'
import { CodeBlock } from './misc-pages.jsx'

// Complete AWS hosting guide for this service: app + LiveKit media plane +
// egress + S3 recordings. Static content — everything actionable is copyable.
export function DeploymentPage() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Deployment guide — AWS</h1>
          <p className="page-sub">Everything needed to host the full stack: control-plane app, LiveKit media server, egress recorder, and S3 storage.</p>
        </div>
      </div>

      <div className="card card-pad guide-card">
        <p className="section-title">Architecture</p>
        <p className="muted">
          Four pieces run in production. The <strong>app</strong> (this Node/Express service + built frontend) is the control plane.
          A <strong>LiveKit server</strong> carries the actual audio/video (SFU). An <strong>egress worker</strong> records calls.
          An <strong>S3 bucket</strong> stores the recordings. LiveKit, egress, and their redis run fine on one EC2 host next to the app for interview-scale traffic.
        </p>
        <CodeBlock
          label="Minimal single-host layout"
          text={`EC2 instance (t3.large+, Ubuntu 24, ports below)
├─ app            node server/index.mjs        :4321 (behind nginx/ALB :443)
├─ livekit        docker livekit/livekit-server :7880 ws/http, :7881 tcp, :50000-50100/udp
├─ egress         docker livekit/egress         (writes to S3)
└─ redis          docker redis:7                :6379 (internal only)
S3 bucket         interview recordings (private)
DNS               app.example.com → app, livekit.example.com → livekit`}
        />
      </div>

      <div className="card card-pad guide-card">
        <p className="section-title">1 · Provision</p>
        <ol className="guide-steps">
          <li><strong>EC2:</strong> t3.large (2 vCPU/8GB) handles a handful of concurrent interviews; scale up for more. Ubuntu 24 LTS, 40GB+ disk, an Elastic IP.</li>
          <li><strong>S3:</strong> one private bucket (e.g. <code>hireportal-interview-recordings</code>), block public access, default SSE encryption. An IAM user/role with <code>GetObject/PutObject</code> on that bucket only.</li>
          <li><strong>Security group:</strong> open the ports below; everything else stays closed.</li>
        </ol>
        <CodeBlock
          label="Security group inbound rules"
          text={`443/tcp    ALB or nginx → app (HTTPS)
80/tcp     redirect to 443 (certbot/ALB)
7880/tcp   LiveKit websocket+https (or terminate TLS at 443 on the livekit domain)
7881/tcp   LiveKit RTC over TCP (fallback)
50000-50100/udp  LiveKit RTC media
5349/tcp   LiveKit TURN/TLS (NAT-restricted candidates)
22/tcp     SSH, your IP only`}
        />
      </div>

      <div className="card card-pad guide-card">
        <p className="section-title">2 · LiveKit media plane</p>
        <p className="muted">Copy the repo&apos;s <code>docker-compose.livekit.yml</code> + <code>livekit/</code> configs to the host, then make them production-real:</p>
        <CodeBlock
          label="livekit/livekit.yaml — production changes"
          text={`port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true            # was false in dev
redis:
  address: redis:6379
keys:
  webrtc-app: <GENERATE 32+ char secret>      # this app's keypair
  hireportal: <GENERATE 32+ char secret>      # must equal the portal's LIVEKIT_API_SECRET
turn:
  enabled: true                    # lets NAT-restricted candidates connect
  domain: livekit.example.com
  tls_port: 5349
  cert_file: /certs/fullchain.pem  # mount your Let's Encrypt certs
  key_file: /certs/privkey.pem
webhook:
  api_key: webrtc-app
  urls:
    - https://app.example.com/api/livekit/webhooks   # was host.docker.internal in dev`}
        />
        <CodeBlock
          label="livekit/egress.yaml — production changes"
          text={`redis:
  address: redis:6379
api_key: webrtc-app
api_secret: <same webrtc-app secret as livekit.yaml>
ws_url: wss://livekit.example.com
# remove "insecure: true"; S3 credentials arrive per-egress from the app`}
        />
        <CodeBlock label="Start the media plane" text={`docker compose -f docker-compose.livekit.yml up -d\ndocker compose -f docker-compose.livekit.yml ps   # all three Up`} />
      </div>

      <div className="card card-pad guide-card">
        <p className="section-title">3 · Deploy the app</p>
        <CodeBlock
          label="Build and run"
          text={`# on the host (Node 24+ required)
git clone <your repo> && cd WebRTC
npm ci
npm run build                      # frontend → dist/, served by the API in production
cp .env.example .env               # then fill the production values (next section)
sudo mkdir -p /var/data && sudo chown $USER /var/data   # durable SQLite + local fallback`}
        />
        <CodeBlock
          label="systemd unit — /etc/systemd/system/interviewrooms.service"
          text={`[Unit]
Description=InterviewRooms video service
After=network.target docker.service

[Service]
WorkingDirectory=/opt/WebRTC
EnvironmentFile=/opt/WebRTC/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server/index.mjs
Restart=always
User=ubuntu

[Install]
WantedBy=multi-user.target

# then: sudo systemctl enable --now interviewrooms`}
        />
      </div>

      <div className="card card-pad guide-card">
        <p className="section-title">4 · Environment</p>
        <p className="muted">The full production <code>.env</code>. Generate fresh secrets; source sensitive values from AWS Secrets Manager or SSM if you prefer.</p>
        <CodeBlock
          label="Production .env"
          text={`NODE_ENV=production
WEBRTC_PUBLIC_ORIGIN=https://app.example.com
WEBRTC_DB_PATH=/var/data/webrtc.sqlite

# Media plane
WEBRTC_LIVEKIT_URL=wss://livekit.example.com
WEBRTC_LIVEKIT_API_KEY=webrtc-app
WEBRTC_LIVEKIT_API_SECRET=<webrtc-app secret from livekit.yaml>

# HirePortal trust (must equal the portal's LiveKit key/secret)
WEBRTC_PORTAL_API_KEY=hireportal
WEBRTC_PORTAL_API_SECRET=<hireportal secret from livekit.yaml>

# Recording storage
WEBRTC_STORAGE_MODE=s3
WEBRTC_S3_BUCKET=hireportal-interview-recordings
WEBRTC_S3_REGION=us-east-1
WEBRTC_S3_ACCESS_KEY=<IAM access key>
WEBRTC_S3_SECRET_KEY=<IAM secret>

# Post-call transcription
WEBRTC_STT_PROVIDER=openai
WEBRTC_OPENAI_API_KEY=<OpenAI key>

# Browser access from the portal
WEBRTC_CORS_ORIGINS=https://hireportal.example.com
WEBRTC_EMBED_ALLOW_REMOTE_ORIGINS=1

# Admin bootstrap (first login forces rotation)
ADMIN_BOOTSTRAP_EMAIL=you@example.com
ADMIN_BOOTSTRAP_PASSWORD=<strong one-time password>`}
        />
      </div>

      <div className="card card-pad guide-card">
        <p className="section-title">5 · DNS + TLS</p>
        <ol className="guide-steps">
          <li><code>app.example.com</code> → the instance. Terminate TLS with nginx + certbot (below) or an ALB with an ACM cert forwarding to :4321.</li>
          <li><code>livekit.example.com</code> → the same instance. Point clients at <code>wss://livekit.example.com</code> (either give LiveKit the cert directly in its config, or proxy 443 → 7880 with websocket upgrade).</li>
          <li>Certificates: <code>certbot certonly --standalone -d app.example.com -d livekit.example.com</code>; mount them into the LiveKit container for TURN/TLS.</li>
        </ol>
        <CodeBlock
          label="nginx server block for the app"
          text={`server {
  listen 443 ssl http2;
  server_name app.example.com;
  ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:4321;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}`}
        />
      </div>

      <div className="card card-pad guide-card">
        <p className="section-title">6 · Wire HirePortal</p>
        <p className="muted">
          Once the domains resolve and the stack is up, follow the <Link to="/admin/integrations">Integrations page</Link> guide —
          it generates the AI-builder prompt pre-filled with this deployment&apos;s URLs, and covers the API key, CORS origin, and portal keypair steps.
        </p>
      </div>

      <div className="card card-pad guide-card">
        <p className="section-title">7 · Verify</p>
        <ol className="guide-steps">
          <li><code>https://app.example.com/api/health</code> returns <code>transport: livekit-sfu</code>.</li>
          <li>Admin bootstrap login works and forces rotation; then create a test room.</li>
          <li>Join from two devices (one on mobile data — proves TURN); both see video.</li>
          <li>Presence appears in the room detail (proves LiveKit webhooks reach the app).</li>
          <li>Start → stop a recording; the artifact finalizes and plays via the presigned URL (proves egress + S3).</li>
          <li>A transcript reaches <em>finalized</em> after the recording (proves STT).</li>
          <li>From the portal&apos;s origin, <code>POST /api/portal/access</code> with a portal token succeeds (proves CORS + keypair).</li>
        </ol>
      </div>
    </div>
  )
}
