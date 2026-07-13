import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fmtBytes, fmtDateTime, fmtDuration, useClipboard } from '../lib/api.js'
import { Avatar, Badge, DataTable, EmptyState, SearchInput, Skeleton, StatusBadge, useToast } from '../ui/kit.jsx'
import { IconCheck, IconCopy, IconFileText, IconList, IconPlay, IconPlug, IconRecord } from '../ui/icons.jsx'
import { useAdmin } from './portal.jsx'

// Copyable code/prompt block used by the guides.
export function CodeBlock({ label, text }) {
  const clipboard = useClipboard()
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{label}</span>
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => clipboard.copy(text)}>
          {clipboard.copied ? <IconCheck /> : <IconCopy />} {clipboard.copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  )
}

// Step-by-step HirePortal wiring guide + a paste-ready prompt for the portal's
// AI builder, parameterized with this deployment's own origin.
function HirePortalGuide() {
  const [open, setOpen] = useState(false)
  const serviceUrl = window.location.origin
  const livekitUrl = serviceUrl.startsWith('https')
    ? `wss://livekit.${window.location.hostname}`
    : 'ws://127.0.0.1:7880'

  const aiPrompt = `Integrate our self-hosted interview video service into this app. Do not remove any existing functionality — this only changes where video calls connect and adds interview-room provisioning. All service errors come back as { error, message } where error is a stable code.

New config (add to src/app/config/livekit.ts or a new videoService.ts):

export const VIDEO_SERVICE_URL = '${serviceUrl}'
export const VIDEO_SERVICE_API_KEY = 'PASTE_INTEGRATION_API_KEY'   // from the video service admin → Integrations
export const LIVEKIT_WS_URL = '${livekitUrl}'                       // replace the existing LiveKit Cloud wsUrl
// Keep LIVEKIT_API_KEY / LIVEKIT_API_SECRET but set them to the service's
// portal keypair (WEBRTC_PORTAL_API_KEY / WEBRTC_PORTAL_API_SECRET).

1. PROVISION A ROOM WHEN AN INTERVIEW IS SCHEDULED.
Wherever a recruiter confirms an interview slot for a candidate, call:
POST \${VIDEO_SERVICE_URL}/api/integrations/rooms
Authorization: Bearer \${VIDEO_SERVICE_API_KEY}
Body: {
  "displayName": "Interview — <candidate name>",
  "password": "<random 8+ char string, store it>",
  "candidateId": "<candidates.id>",
  "recruiterId": "<candidates.recruiter_id>",
  "invitees": [{ "email": "<candidate email>", "role": "candidate" }],
  "schedule": { "scheduledStartAt": "<slot start ISO>", "scheduledEndAt": "<slot end ISO>", "joinWindowMinutes": 15 },
  "maxParticipants": 3
}
From the 201 response store room.id as video_room_id and shareUrl as video_room_url on the candidate record.

2. REPLACE HOW THE CALL CONNECTS (keep the existing LiveKitFrame UI).
Before connecting, mint the portal token with the existing generateLiveKitToken helper, then:
POST \${VIDEO_SERVICE_URL}/api/portal/access
Authorization: Bearer <portal JWT>
Body: { "acknowledgeRecording": true }   // only after the user confirms a consent dialog
On 200: connect LiveKitFrame with res.livekit.url and res.livekit.token (NOT the self-minted token).
On 403 error=room_not_open: show "This interview opens 15 minutes before the scheduled start."
On 403 error=recording_consent_required: show the recording notice with an "I understand, join" button, then retry with acknowledgeRecording: true.
On 404: show "No interview room has been scheduled yet."

3. AFTER THE INTERVIEW, SURFACE RESULTS.
On the recruiter's candidate view, when video_room_id exists:
GET \${VIDEO_SERVICE_URL}/api/integrations/rooms/\${video_room_id}
Authorization: Bearer \${VIDEO_SERVICE_API_KEY}
Show room status, activeParticipants while live, and the recordings/transcripts arrays (status + duration). When a transcript reaches status "finalized", append "Interview transcript available" to the candidate's ai_summary.

Keep all video-service calls non-blocking: if the service is unreachable the rest of the portal must keep working.`

  return (
    <div className="metadata-card retained-chat-card" style={{ marginBottom: 16 }}>
      <div className="admin-section-heading compact-heading">
        <div>
          <h3>HirePortal integration guide</h3>
          <p className="muted">Wire the portal to this deployment in three steps, then hand the prompt to the portal&apos;s AI builder.</p>
        </div>
        <button type="button" className="btn btn-xs" onClick={() => setOpen((current) => !current)}>{open ? 'Hide' : 'Show'}</button>
      </div>
      {open ? (
        <div>
          <ol className="guide-steps">
            <li>
              <strong>Create an API client</strong> below (name it &quot;HirePortal&quot;) and copy the key — it is shown once. The portal uses it to provision rooms and read status.
            </li>
            <li>
              <strong>Allow the portal&apos;s origin.</strong> Set <code>WEBRTC_CORS_ORIGINS</code> to the portal&apos;s URL in this service&apos;s environment and restart — the portal calls these APIs from the browser.
            </li>
            <li>
              <strong>Match the portal keypair.</strong> The portal&apos;s <code>LIVEKIT_API_KEY/SECRET</code> must equal this service&apos;s <code>WEBRTC_PORTAL_API_KEY/SECRET</code>, and the same pair must be registered in the LiveKit server&apos;s <code>keys:</code> config. That is what lets portal-minted tokens prove portal login.
            </li>
            <li>
              <strong>Paste the prompt</strong> below into the portal&apos;s AI builder, replacing <code>PASTE_INTEGRATION_API_KEY</code> with the key from step 1. It is pre-filled with this deployment&apos;s URLs.
            </li>
          </ol>
          <CodeBlock label="Prompt for the HirePortal AI builder" text={aiPrompt} />
          <p className="muted" style={{ marginTop: 10 }}>
            Endpoint details and live testing: <a href="/api/admin/docs/" target="_blank" rel="noreferrer">API reference</a>. Hosting this service first: see the <Link to="/admin/deployment">Deployment guide</Link>.
          </p>
        </div>
      ) : null}
    </div>
  )
}

// Shared scaffold for the global list pages (Zoom "Logs"-style tables).
function ListPage({ title, sub, children }) {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="page-sub">{sub}</p>
        </div>
      </div>
      <div className="card">{children}</div>
    </div>
  )
}

function useFiltered(rows, query, keys) {
  return useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((row) => keys.some((key) => String(row[key] || '').toLowerCase().includes(needle)))
  }, [rows, query, keys])
}

// ---------------------------------------------------------------------------
// Recordings — all rooms.
// ---------------------------------------------------------------------------
export function RecordingsPage() {
  const { call, can } = useAdmin()
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    call('/api/admin/recordings')
      .then((body) => setRows(body.recordings))
      .catch((err) => toast(err.message, 'error'))
  }, [call, toast])

  const filtered = useFiltered(rows || [], query, ['roomDisplayName', 'roomId', 'candidateId', 'status'])

  return (
    <ListPage title="Recordings" sub="Every recording across rooms, with playback and transcription.">
      <div className="page-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Search room, candidate, status…" />
      </div>
      {!rows ? <Skeleton lines={5} /> : (
        <DataTable
          columns={[
            {
              key: 'roomDisplayName',
              label: 'Room',
              sortable: true,
              render: (row) => (
                <span>
                  <Link className="cell-main" to={`/admin/rooms/${row.roomId}`}>{row.roomDisplayName || row.roomId}</Link>
                  <span className="cell-sub">{row.candidateId ? `candidate ${row.candidateId}` : row.roomId}</span>
                </span>
              ),
            },
            { key: 'status', label: 'Status', sortable: true, render: (row) => <StatusBadge status={row.status} /> },
            { key: 'startedAt', label: 'Started', sortable: true, render: (row) => fmtDateTime(row.startedAt) },
            { key: 'durationMs', label: 'Duration', sortable: true, render: (row) => fmtDuration(row.durationMs) },
            { key: 'byteSize', label: 'Size', sortable: true, render: (row) => fmtBytes(row.byteSize) },
            {
              key: 'actions',
              label: '',
              render: (row) => (
                <span className="cell-actions">
                  {row.mediaCaptured && can('recordings:playback') ? (
                    <a className="btn btn-xs" href={`/api/admin/rooms/${row.roomId}/recordings/${row.id}/media`} target="_blank" rel="noreferrer"><IconPlay /> Play</a>
                  ) : null}
                  <Link className="btn btn-xs" to={`/admin/rooms/${row.roomId}`}>Open room</Link>
                </span>
              ),
            },
          ]}
          rows={filtered}
          rowKey={(row) => row.id}
          empty={<EmptyState icon={IconRecord} title="No recordings yet" text="Recordings from all rooms show up here once interviews are captured." />}
        />
      )}
    </ListPage>
  )
}

// ---------------------------------------------------------------------------
// Transcripts — all rooms.
// ---------------------------------------------------------------------------
export function TranscriptsPage() {
  const { call } = useAdmin()
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    call('/api/admin/transcripts')
      .then((body) => setRows(body.transcripts))
      .catch((err) => toast(err.message, 'error'))
  }, [call, toast])

  const filtered = useFiltered(rows || [], query, ['roomDisplayName', 'roomId', 'candidateId', 'status', 'providerKey'])

  return (
    <ListPage title="Transcripts" sub="Post-call transcripts generated from finalized recordings.">
      <div className="page-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Search room, provider, status…" />
      </div>
      {!rows ? <Skeleton lines={5} /> : (
        <DataTable
          columns={[
            {
              key: 'roomDisplayName',
              label: 'Room',
              sortable: true,
              render: (row) => (
                <span>
                  <Link className="cell-main" to={`/admin/rooms/${row.roomId}`}>{row.roomDisplayName || row.roomId}</Link>
                  <span className="cell-sub">{row.candidateId ? `candidate ${row.candidateId}` : row.roomId}</span>
                </span>
              ),
            },
            { key: 'status', label: 'Status', sortable: true, render: (row) => <StatusBadge status={row.status} /> },
            { key: 'providerKey', label: 'Provider', render: (row) => <span className="mono">{row.providerKey}</span> },
            { key: 'language', label: 'Language', sortable: true },
            { key: 'createdAt', label: 'Created', sortable: true, render: (row) => fmtDateTime(row.createdAt) },
            {
              key: 'actions',
              label: '',
              render: (row) => <span className="cell-actions"><Link className="btn btn-xs" to={`/admin/rooms/${row.roomId}`}>Open room</Link></span>,
            },
          ]}
          rows={filtered}
          rowKey={(row) => row.id}
          empty={<EmptyState icon={IconFileText} title="No transcripts yet" text="Transcripts appear automatically after recorded interviews finish." />}
        />
      )}
    </ListPage>
  )
}

// ---------------------------------------------------------------------------
// Integrations — clients, systems, links, webhook attempts.
// ---------------------------------------------------------------------------
export function IntegrationsPage() {
  const { call, can } = useAdmin()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [creating, setCreating] = useState(false)
  const [clientName, setClientName] = useState('')
  const [systemKey, setSystemKey] = useState('hireportal')
  const [issuedKey, setIssuedKey] = useState('')

  const load = useCallback(() => call('/api/admin/integrations').then(setData), [call])
  useEffect(() => {
    load().catch((err) => toast(err.message, 'error'))
  }, [load, toast])

  if (!data) return <ListPage title="Integrations" sub="API clients and portal linkage."><Skeleton lines={5} /></ListPage>

  const createClient = async (event) => {
    event.preventDefault()
    setCreating(true)
    try {
      const body = await call('/api/admin/integrations/clients', {
        method: 'POST',
        body: JSON.stringify({ name: clientName, systemKey }),
      })
      setIssuedKey(body.key || '')
      setClientName('')
      toast('Integration client created', 'success')
      await load()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setCreating(false)
    }
  }

  return (
    <ListPage title="Integrations" sub="Server-to-server clients (HirePortal provisioning) and linked records.">
      <div className="card-pad">
        <div className="inline-actions" style={{ marginBottom: 16 }}>
          <a className="btn" href="/api/admin/docs/" target="_blank" rel="noreferrer">
            <IconFileText /> API reference
          </a>
          <span className="muted">Interactive docs for every endpoint — test with your API keys.</span>
        </div>
        <HirePortalGuide />
        {can('integrations:manage') ? (
          <form className="inline-actions" onSubmit={createClient} style={{ marginBottom: 16 }}>
            <input value={clientName} onChange={(event) => setClientName(event.target.value)} placeholder="Client name (e.g. HirePortal)" required style={{ width: 240 }} />
            <input value={systemKey} onChange={(event) => setSystemKey(event.target.value)} placeholder="system key" style={{ width: 140 }} />
            <button className="btn btn-primary" type="submit" disabled={creating}>{creating ? 'Creating…' : 'New API client'}</button>
          </form>
        ) : null}
        {issuedKey ? (
          <div className="error-banner" style={{ background: 'var(--blue-50)', borderColor: 'var(--blue-500)', color: 'var(--blue-700)', marginBottom: 16 }}>
            API key (shown once): <code>{issuedKey}</code>
          </div>
        ) : null}
        <p className="section-title">Clients</p>
        <DataTable
          columns={[
            { key: 'name', label: 'Name', render: (client) => <span><span className="cell-main">{client.name}</span><span className="cell-sub mono">{client.keyPrefix}…</span></span> },
            { key: 'systemKey', label: 'System', render: (client) => client.systemKey || '—' },
            { key: 'permissionScope', label: 'Scopes', render: (client) => <span className="chip-row">{(client.permissionScope || []).map((scope) => <Badge key={scope}>{scope}</Badge>)}</span> },
            { key: 'status', label: 'Status', render: (client) => <StatusBadge status={client.status} /> },
            {
              key: 'actions',
              label: '',
              render: (client) => can('integrations:manage') && client.status === 'active' ? (
                <span className="cell-actions">
                  <button
                    type="button"
                    className="btn btn-danger-soft btn-xs"
                    onClick={async () => {
                      try {
                        await call(`/api/admin/integrations/clients/${client.id}/revoke`, { method: 'POST' })
                        toast('Client revoked', 'success')
                        await load()
                      } catch (err) {
                        toast(err.message, 'error')
                      }
                    }}
                  >
                    Revoke
                  </button>
                </span>
              ) : null,
            },
          ]}
          rows={data.clients || []}
          rowKey={(client) => client.id}
          empty={<EmptyState icon={IconPlug} title="No API clients" text="Create a client to let HirePortal provision rooms server-to-server." />}
        />
        {data.roomLinks?.length ? (
          <>
            <hr className="divider" />
            <p className="section-title">Recent room links</p>
            <div className="list-feed">
              {data.roomLinks.map((link) => (
                <article key={link.id}>
                  <strong>{link.systemKey} · {link.objectType}:{link.objectId}</strong>
                  <span><Link to={`/admin/rooms/${link.roomId}`}>{link.roomId}</Link> · {fmtDateTime(link.createdAt)}</span>
                </article>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </ListPage>
  )
}

// ---------------------------------------------------------------------------
// Audit — global feed.
// ---------------------------------------------------------------------------
export function AuditPage() {
  const { call } = useAdmin()
  const toast = useToast()
  const [events, setEvents] = useState(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    call('/api/admin/audit')
      .then((body) => setEvents(body.audit))
      .catch((err) => toast(err.message, 'error'))
  }, [call, toast])

  const filtered = useFiltered(events || [], query, ['action', 'actorType', 'resourceType', 'roomId'])

  return (
    <ListPage title="Audit log" sub="Immutable record of admin, participant, integration, and system actions.">
      <div className="page-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Search action, actor, room…" />
      </div>
      {!events ? <Skeleton lines={6} /> : (
        <DataTable
          columns={[
            { key: 'action', label: 'Action', sortable: true, render: (event) => <span className="mono">{event.action}</span> },
            { key: 'actorType', label: 'Actor', sortable: true },
            { key: 'resourceType', label: 'Resource', sortable: true },
            { key: 'roomId', label: 'Room', render: (event) => event.roomId ? <Link to={`/admin/rooms/${event.roomId}`} className="mono">{event.roomId}</Link> : '—' },
            { key: 'createdAt', label: 'When', sortable: true, render: (event) => fmtDateTime(event.createdAt) },
          ]}
          rows={filtered}
          rowKey={(event, index) => `${event.action}-${event.createdAt}-${index ?? Math.random()}`}
          empty={<EmptyState icon={IconList} title="No audit events" text="Actions across the platform are recorded here." />}
        />
      )}
    </ListPage>
  )
}

// ---------------------------------------------------------------------------
// Profile — identity, roles, permissions.
// ---------------------------------------------------------------------------
export function ProfilePage() {
  const { user } = useAdmin()
  return (
    <ListPage title="Profile" sub="Your admin identity and access.">
      <div className="card-pad">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
          <Avatar name={user.displayName} size={56} />
          <div>
            <h2 style={{ fontSize: 18 }}>{user.displayName}</h2>
            <p className="muted">{user.email}</p>
          </div>
        </div>
        <dl className="detail-grid">
          <dt>Roles</dt>
          <dd className="chip-row">{(user.roles || []).map((role) => <Badge key={role.key} tone="blue">{role.name}</Badge>)}</dd>
          <dt>Permissions</dt>
          <dd className="chip-row">{(user.permissions || []).map((permission) => <Badge key={permission}>{permission}</Badge>)}</dd>
        </dl>
      </div>
    </ListPage>
  )
}
