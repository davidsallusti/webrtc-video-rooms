import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { fmtBytes, fmtDateTime, fmtDuration } from '../lib/api.js'
import { Badge, CopyField, DataTable, EmptyState, Field, Modal, Skeleton, StatusBadge, Tabs, useToast } from '../ui/kit.jsx'
import { IconFileText, IconPlay, IconRecord } from '../ui/icons.jsx'
import { useAdmin } from './portal.jsx'

const CLOSED_STATUSES = ['ended', 'expired', 'disabled']

// Zoom "Personal Room"-style detail: header with primary actions, tabbed
// sub-sections instead of one long column.
export function RoomDetailPage() {
  const { roomId } = useParams()
  const { call, can } = useAdmin()
  const toast = useToast()
  const [room, setRoom] = useState(null)
  const [audit, setAudit] = useState([])
  const [tab, setTab] = useState('details')

  const reload = useCallback(async () => {
    const body = await call(`/api/admin/rooms/${roomId}`)
    setRoom(body.room)
    setAudit(body.audit || [])
  }, [call, roomId])

  useEffect(() => {
    reload().catch((err) => toast(err.message, 'error'))
  }, [reload, toast])

  if (!room) return <div className="card"><Skeleton lines={6} /></div>

  const shareUrl = `${window.location.origin}/rooms/${room.id}`
  const closed = CLOSED_STATUSES.includes(room.status)

  const act = (fn, success) => async (...args) => {
    try {
      await fn(...args)
      if (success) toast(success, 'success')
      await reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const endForAll = act(
    () => call(`/api/admin/rooms/${room.id}/end`, { method: 'POST', body: JSON.stringify({ confirm: true, reason: 'admin ended room' }) }),
    'Room ended for all participants',
  )
  const lifecycle = (command, payload = {}) => act(
    () => call(`/api/admin/rooms/${room.id}/lifecycle/${command}`, { method: 'POST', body: JSON.stringify({ reason: 'admin operation', ...payload }) }),
    `Room ${command} applied`,
  )()

  const tabs = [
    { key: 'details', label: 'Details' },
    ...(can('recordings:view') || can('recordings:configure') ? [{ key: 'recordings', label: 'Recordings' }] : []),
    ...(can('transcripts:view') ? [{ key: 'transcripts', label: 'Transcripts' }] : []),
    ...(can('chat:view') ? [{ key: 'chat', label: 'Chat' }] : []),
    ...(can('waiting_room:view') ? [{ key: 'waiting', label: `Waiting room${room.waitingParticipants?.length ? ` (${room.waitingParticipants.length})` : ''}` }] : []),
    ...(can('embed:view') ? [{ key: 'embed', label: 'Embed' }] : []),
    { key: 'emails', label: 'Emails' },
    { key: 'audit', label: 'Audit' },
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="page-sub"><Link to="/admin/rooms">Rooms</Link> / <span className="mono">{room.id}</span></p>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{room.displayName} <StatusBadge status={room.status} /></h1>
        </div>
        <div className="inline-actions">
          {room.status === 'active' && can('rooms:lock') ? <button type="button" className="btn" onClick={() => lifecycle('lock')}>Lock</button> : null}
          {room.status === 'locked' && can('rooms:unlock') ? <button type="button" className="btn" onClick={() => lifecycle('unlock')}>Unlock</button> : null}
          {!closed && can('rooms:extend') ? (
            <button type="button" className="btn" onClick={() => lifecycle('extend', { expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() })}>Extend 2h</button>
          ) : null}
          {!closed && can('rooms:disable') ? <button type="button" className="btn btn-danger-soft" onClick={() => lifecycle('disable')}>Disable</button> : null}
          {!closed && can('rooms:end_any') ? <button type="button" className="btn btn-danger" onClick={endForAll}>End for all</button> : null}
        </div>
      </div>

      <div className="stat-row" style={{ marginBottom: 18 }}>
        <div className="card stat-card"><span className="stat-label">In room</span><div className="stat-value">{room.presenceCount} / {room.maxParticipants}</div></div>
        <div className="card stat-card"><span className="stat-label">Scheduled</span><div className="stat-value" style={{ fontSize: 15 }}>{room.scheduledStartAt ? fmtDateTime(room.scheduledStartAt) : 'Unscheduled'}</div></div>
        <div className="card stat-card"><span className="stat-label">Expires</span><div className="stat-value" style={{ fontSize: 15 }}>{fmtDateTime(room.expiresAt)}</div></div>
        <div className="card stat-card"><span className="stat-label">Invite link</span><div style={{ marginTop: 6 }}><CopyField value={shareUrl} label="invite link" /></div></div>
      </div>

      <div className="card">
        <Tabs items={tabs} active={tab} onChange={setTab} />
        <div className="card-pad">
          {tab === 'details' ? <DetailsTab room={room} act={act} /> : null}
          {tab === 'recordings' ? <RecordingsTab room={room} act={act} /> : null}
          {tab === 'transcripts' ? <TranscriptsTab room={room} act={act} /> : null}
          {tab === 'chat' ? <ChatTab room={room} act={act} /> : null}
          {tab === 'waiting' ? <WaitingTab room={room} act={act} /> : null}
          {tab === 'embed' ? <EmbedTab room={room} act={act} /> : null}
          {tab === 'emails' ? <EmailsTab room={room} /> : null}
          {tab === 'audit' ? <AuditTab audit={audit} lifecycle={room.lifecycle} /> : null}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Details — room facts, policy toggles, interview mapping editor.
// ---------------------------------------------------------------------------
function DetailsTab({ room, act }) {
  const { call, can } = useAdmin()
  const togglePolicy = (patch) => act(
    () => call(`/api/admin/rooms/${room.id}/policy`, { method: 'PATCH', body: JSON.stringify(patch) }),
    'Policy updated',
  )()

  return (
    <div>
      <dl className="detail-grid">
        <dt>Room ID</dt><dd><CopyField value={room.id} label="room id" /></dd>
        <dt>Media room</dt><dd className="mono">{room.livekitRoomName || '—'}</dd>
        <dt>Candidate</dt><dd>{room.candidateId || '—'}</dd>
        <dt>Recruiter</dt><dd>{room.recruiterId || '—'}</dd>
        <dt>Join window</dt>
        <dd>{room.scheduledStartAt ? `${room.joinWindowMinutes ?? '—'} minutes before ${fmtDateTime(room.scheduledStartAt)}` : 'No schedule'}</dd>
        <dt>Invitees</dt>
        <dd>
          {room.invitees?.length ? (
            <span className="chip-row">{room.invitees.map((invitee) => <Badge key={invitee.email} tone="blue">{invitee.email}</Badge>)}</span>
          ) : 'Open to anyone with link + password'}
        </dd>
        <dt>Waiting room</dt>
        <dd>
          {room.waitingRoomEnabled ? 'Enabled' : 'Off'}
          {can('rooms:update_policy') ? (
            <button type="button" className="btn btn-xs" onClick={() => togglePolicy({ waitingRoomEnabled: !room.waitingRoomEnabled })}>
              {room.waitingRoomEnabled ? 'Disable' : 'Enable'}
            </button>
          ) : null}
        </dd>
        <dt>Auto-admit first guest</dt>
        <dd>
          {room.autoAdmitFirstGuest ? 'On' : 'Off'}
          {can('rooms:update_policy') ? (
            <button type="button" className="btn btn-xs" onClick={() => togglePolicy({ autoAdmitFirstGuest: !room.autoAdmitFirstGuest })}>
              {room.autoAdmitFirstGuest ? 'Turn off' : 'Turn on'}
            </button>
          ) : null}
        </dd>
        {Object.keys(room.metadata || {}).length ? (
          <>
            <dt>Metadata</dt>
            <dd className="chip-row">
              {Object.entries(room.metadata).map(([key, value]) => (
                <Badge key={key}>{key}: {Array.isArray(value) ? value.join(', ') : value}</Badge>
              ))}
            </dd>
          </>
        ) : null}
        {room.externalLinks?.length ? (
          <>
            <dt>External links</dt>
            <dd className="chip-row">
              {room.externalLinks.map((link) => <Badge key={link.id} tone="blue">{link.systemKey} · {link.objectType}:{link.objectId}</Badge>)}
            </dd>
          </>
        ) : null}
      </dl>
      {can('rooms:update_policy') ? (
        <>
          <hr className="divider" />
          <InterviewMappingForm room={room} act={act} />
        </>
      ) : null}
    </div>
  )
}

function InterviewMappingForm({ room, act }) {
  const { call } = useAdmin()
  const toLocalInput = (iso) => {
    if (!iso) return ''
    const date = new Date(iso)
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  const [draft, setDraft] = useState({
    candidateId: room.candidateId || '',
    recruiterId: room.recruiterId || '',
    invitees: (room.invitees || []).map((invitee) => invitee.email).join(', '),
    scheduledStartAt: toLocalInput(room.scheduledStartAt),
    scheduledEndAt: toLocalInput(room.scheduledEndAt),
    joinWindowMinutes: room.joinWindowMinutes != null ? String(room.joinWindowMinutes) : '',
  })
  const set = (key) => (event) => setDraft({ ...draft, [key]: event.target.value })

  const save = act(
    () => call(`/api/admin/rooms/${room.id}/interview-config`, {
      method: 'PATCH',
      body: JSON.stringify({
        candidateId: draft.candidateId || null,
        recruiterId: draft.recruiterId || null,
        invitees: draft.invitees.split(',').map((email) => ({ email: email.trim() })).filter((entry) => entry.email),
        schedule: draft.scheduledStartAt ? {
          scheduledStartAt: new Date(draft.scheduledStartAt).toISOString(),
          scheduledEndAt: draft.scheduledEndAt ? new Date(draft.scheduledEndAt).toISOString() : null,
          joinWindowMinutes: draft.joinWindowMinutes === '' ? null : Number(draft.joinWindowMinutes),
        } : { scheduledStartAt: null, scheduledEndAt: null, joinWindowMinutes: null },
      }),
    }),
    'Interview mapping saved',
  )

  return (
    <form onSubmit={(event) => { event.preventDefault(); save() }}>
      <p className="section-title">Interview mapping</p>
      <div className="form-grid">
        <Field label="Candidate ID"><input value={draft.candidateId} onChange={set('candidateId')} /></Field>
        <Field label="Recruiter ID"><input value={draft.recruiterId} onChange={set('recruiterId')} /></Field>
        <div className="field-full">
          <Field label="Invitee emails" hint="Comma-separated; empty list opens the room to anyone with link + password.">
            <input value={draft.invitees} onChange={set('invitees')} />
          </Field>
        </div>
        <Field label="Scheduled start"><input type="datetime-local" value={draft.scheduledStartAt} onChange={set('scheduledStartAt')} /></Field>
        <Field label="Scheduled end"><input type="datetime-local" value={draft.scheduledEndAt} onChange={set('scheduledEndAt')} /></Field>
        <Field label="Join window (minutes)"><input inputMode="numeric" value={draft.joinWindowMinutes} onChange={set('joinWindowMinutes')} /></Field>
      </div>
      <div className="form-actions">
        <button className="btn btn-primary" type="submit">Save mapping</button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Recordings — start/stop egress, playback, transcription.
// ---------------------------------------------------------------------------
function RecordingsTab({ room }) {
  const { call, can } = useAdmin()
  const [data, setData] = useState(null)
  const toast = useToast()

  const load = useCallback(() => (
    can('recordings:view')
      ? call(`/api/admin/rooms/${room.id}/recordings`)
      : call(`/api/admin/rooms/${room.id}/recording-settings`).then((body) => ({ ...body, artifacts: [] }))
  ), [call, can, room.id])

  useEffect(() => {
    load().then(setData).catch((err) => toast(err.message, 'error'))
  }, [load, toast])

  if (!data) return <Skeleton lines={4} />
  const enabled = Boolean(data.settings?.recordingEnabled)
  const activeRecording = (data.artifacts || []).find((artifact) => artifact.status === 'active')

  const refresh = () => load().then(setData).catch(() => {})
  const run = (fn, message) => async () => {
    try {
      await fn()
      if (message) toast(message, 'success')
      refresh()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div>
      <div className="inline-actions" style={{ marginBottom: 14 }}>
        {can('recordings:configure') ? (
          <button
            type="button"
            className="btn"
            onClick={run(() => call(`/api/admin/rooms/${room.id}/recording-settings`, { method: 'PUT', body: JSON.stringify({ recordingEnabled: !enabled }) }), 'Recording settings updated')}
          >
            {enabled ? 'Disable recording' : 'Enable recording'}
          </button>
        ) : null}
        {can('recordings:manage') && (activeRecording ? (
          <button type="button" className="btn btn-danger" onClick={run(() => call(`/api/admin/rooms/${room.id}/recordings/${activeRecording.id}/stop`, { method: 'POST' }), 'Stopping recording')}>
            Stop recording
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={!enabled || room.status !== 'active'} onClick={run(() => call(`/api/admin/rooms/${room.id}/recordings/start`, { method: 'POST' }), 'Recording started')}>
            <IconRecord /> Start recording
          </button>
        ))}
      </div>
      <p className="muted" style={{ marginBottom: 14 }}>{data.settings?.participantNotice}</p>
      <DataTable
        columns={[
          { key: 'status', label: 'Status', render: (artifact) => <StatusBadge status={artifact.status} /> },
          { key: 'startedAt', label: 'Started', sortable: true, render: (artifact) => fmtDateTime(artifact.startedAt) },
          { key: 'durationMs', label: 'Duration', render: (artifact) => fmtDuration(artifact.durationMs) },
          { key: 'byteSize', label: 'Size', render: (artifact) => fmtBytes(artifact.byteSize) },
          {
            key: 'actions',
            label: '',
            render: (artifact) => (
              <span className="cell-actions">
                {artifact.mediaCaptured && can('recordings:playback') ? (
                  <a className="btn btn-xs" href={`/api/admin/rooms/${room.id}/recordings/${artifact.id}/media`} target="_blank" rel="noreferrer"><IconPlay /> Play</a>
                ) : null}
                {artifact.mediaCaptured && can('recordings:manage') ? (
                  <button type="button" className="btn btn-xs" onClick={run(() => call(`/api/admin/rooms/${room.id}/recordings/${artifact.id}/transcribe`, { method: 'POST' }), 'Transcription queued')}>Transcribe</button>
                ) : null}
                {can('recordings:delete') ? (
                  <button type="button" className="btn btn-danger-soft btn-xs" onClick={run(() => call(`/api/admin/rooms/${room.id}/recordings/${artifact.id}/delete`, { method: 'POST' }), 'Recording deleted')}>Delete</button>
                ) : null}
              </span>
            ),
          },
        ]}
        rows={data.artifacts || []}
        rowKey={(artifact) => artifact.id}
        empty={<EmptyState icon={IconRecord} title="No recordings yet" text={enabled ? 'Start a recording while the interview is live.' : 'Enable recording for this room first.'} />}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Transcripts — artifacts with expandable segments; export/redact/delete.
// ---------------------------------------------------------------------------
function TranscriptsTab({ room }) {
  const { call, can } = useAdmin()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [openArtifact, setOpenArtifact] = useState(null) // { artifact, segments }

  const load = useCallback(() => call(`/api/admin/rooms/${room.id}/transcripts`), [call, room.id])
  useEffect(() => {
    load().then(setData).catch((err) => toast(err.message, 'error'))
  }, [load, toast])

  if (!data) return <Skeleton lines={4} />

  const openSegments = async (artifact) => {
    try {
      const body = await call(`/api/admin/rooms/${room.id}/transcripts/${artifact.id}`)
      setOpenArtifact(body)
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const exportArtifact = async (artifact) => {
    try {
      const body = await call(`/api/admin/rooms/${room.id}/transcripts/${artifact.id}/export`)
      const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `transcript-${artifact.id}.json`
      link.click()
      URL.revokeObjectURL(link.href)
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const segmentAction = (artifactId, segmentId, action) => async () => {
    try {
      await call(`/api/admin/rooms/${room.id}/transcripts/${artifactId}/segments/${segmentId}/${action}`, { method: 'POST' })
      const body = await call(`/api/admin/rooms/${room.id}/transcripts/${artifactId}`)
      setOpenArtifact(body)
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div>
      <DataTable
        columns={[
          { key: 'status', label: 'Status', render: (artifact) => <StatusBadge status={artifact.status} /> },
          { key: 'providerKey', label: 'Provider', render: (artifact) => <span className="mono">{artifact.providerKey}</span> },
          { key: 'language', label: 'Language' },
          { key: 'createdAt', label: 'Created', sortable: true, render: (artifact) => fmtDateTime(artifact.createdAt) },
          {
            key: 'actions',
            label: '',
            render: (artifact) => (
              <span className="cell-actions">
                <button type="button" className="btn btn-xs" onClick={() => openSegments(artifact)}>View</button>
                {can('transcripts:export') ? <button type="button" className="btn btn-xs" onClick={() => exportArtifact(artifact)}>Export</button> : null}
              </span>
            ),
          },
        ]}
        rows={data.artifacts || []}
        rowKey={(artifact) => artifact.id}
        empty={<EmptyState icon={IconFileText} title="No transcripts yet" text="Transcripts are generated automatically after each recording finalizes." />}
      />
      {openArtifact ? (
        <Modal title={`Transcript ${openArtifact.artifact.id}`} onClose={() => setOpenArtifact(null)} wide>
          {openArtifact.segments.length ? (
            <div className="list-feed">
              {openArtifact.segments.map((segment) => (
                <article key={segment.id}>
                  <div>
                    <strong>{segment.redactedAt ? <em className="muted">[redacted]</em> : segment.text}</strong>
                    <span style={{ display: 'block' }}>{Math.round(segment.startMs / 1000)}s – {Math.round(segment.endMs / 1000)}s{segment.speakerLabel ? ` · ${segment.speakerLabel}` : ''}</span>
                  </div>
                  <span className="cell-actions">
                    {can('transcripts:redact') && !segment.redactedAt ? (
                      <button type="button" className="btn btn-xs" onClick={segmentAction(openArtifact.artifact.id, segment.id, 'redact')}>Redact</button>
                    ) : null}
                    {can('transcripts:delete') ? (
                      <button type="button" className="btn btn-danger-soft btn-xs" onClick={segmentAction(openArtifact.artifact.id, segment.id, 'delete')}>Delete</button>
                    ) : null}
                  </span>
                </article>
              ))}
            </div>
          ) : <p className="muted">No segments in this transcript.</p>}
        </Modal>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chat — retained history with redact/delete + retention toggle.
// ---------------------------------------------------------------------------
function ChatTab({ room }) {
  const { call, can } = useAdmin()
  const toast = useToast()
  const [data, setData] = useState(null)

  const load = useCallback(() => call(`/api/admin/rooms/${room.id}/chat`), [call, room.id])
  useEffect(() => {
    load().then(setData).catch((err) => toast(err.message, 'error'))
  }, [load, toast])

  if (!data) return <Skeleton lines={4} />
  const enabled = Boolean(data.retention?.retentionEnabled)

  const run = (fn, message) => async () => {
    try {
      await fn()
      if (message) toast(message, 'success')
      load().then(setData).catch(() => {})
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div>
      <div className="inline-actions" style={{ marginBottom: 14 }}>
        {can('chat:configure_retention') ? (
          <button type="button" className="btn" onClick={run(() => call(`/api/admin/rooms/${room.id}/chat-settings`, { method: 'PUT', body: JSON.stringify({ retentionEnabled: !enabled }) }), 'Chat retention updated')}>
            {enabled ? 'Disable retention' : 'Enable retention'}
          </button>
        ) : null}
      </div>
      {data.messages?.length ? (
        <div className="list-feed">
          {data.messages.map((message) => (
            <article key={message.id}>
              <div>
                <strong>{message.redactedAt ? <em className="muted">[redacted]</em> : message.body}</strong>
                <span style={{ display: 'block' }}>{message.senderRole} · {fmtDateTime(message.createdAt)}</span>
              </div>
              <span className="cell-actions">
                {can('chat:redact') && !message.redactedAt ? (
                  <button type="button" className="btn btn-xs" onClick={run(() => call(`/api/admin/rooms/${room.id}/chat/${message.id}/redact`, { method: 'POST' }), 'Message redacted')}>Redact</button>
                ) : null}
                {can('chat:delete') ? (
                  <button type="button" className="btn btn-danger-soft btn-xs" onClick={run(() => call(`/api/admin/rooms/${room.id}/chat/${message.id}/delete`, { method: 'POST' }), 'Message deleted')}>Delete</button>
                ) : null}
              </span>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState title={enabled ? 'No retained messages' : 'Retention is off'} text={enabled ? 'Messages appear here as participants chat.' : 'Enable retention to keep in-room chat for review.'} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Waiting room — admit/reject pending guests.
// ---------------------------------------------------------------------------
function WaitingTab({ room, act }) {
  const { call, can } = useAdmin()
  const waiting = room.waitingParticipants || []
  const decide = (participantId, decision) => act(
    () => call(`/api/admin/rooms/${room.id}/waiting/${participantId}/${decision}`, { method: 'POST' }),
    decision === 'admit' ? 'Guest admitted' : 'Guest rejected',
  )()

  if (!waiting.length) return <EmptyState title="No guests waiting" text="Guests held by the waiting room appear here for admission." />
  return (
    <div className="list-feed">
      {waiting.map((participant) => (
        <article key={participant.participantId}>
          <div>
            <strong className="mono">{participant.participantId}</strong>
            <span style={{ display: 'block' }}>requested {fmtDateTime(participant.issuedAt)}</span>
          </div>
          {can('waiting_room:admit') ? (
            <span className="cell-actions">
              <button type="button" className="btn btn-primary btn-xs" onClick={() => decide(participant.participantId, 'admit')}>Admit</button>
              <button type="button" className="btn btn-danger-soft btn-xs" onClick={() => decide(participant.participantId, 'reject')}>Reject</button>
            </span>
          ) : null}
        </article>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Embed — origins + scoped sessions.
// ---------------------------------------------------------------------------
function EmbedTab({ room }) {
  const { call, can } = useAdmin()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [origin, setOrigin] = useState(window.location.origin)
  const [issued, setIssued] = useState(null)

  const load = useCallback(() => call(`/api/admin/rooms/${room.id}/embed`), [call, room.id])
  useEffect(() => {
    load().then(setData).catch((err) => toast(err.message, 'error'))
  }, [load, toast])

  if (!data) return <Skeleton lines={4} />
  const enabled = Boolean(data.settings?.embedEnabled)

  const run = (fn, message) => async () => {
    try {
      const result = await fn()
      if (message) toast(message, 'success')
      load().then(setData).catch(() => {})
      return result
    } catch (err) {
      toast(err.message, 'error')
      return null
    }
  }

  return (
    <div>
      <div className="inline-actions" style={{ marginBottom: 14 }}>
        {can('embed:configure') ? (
          <>
            <input value={origin} onChange={(event) => setOrigin(event.target.value)} style={{ width: 260 }} aria-label="Embed origin" />
            <button type="button" className="btn" onClick={run(() => call(`/api/admin/rooms/${room.id}/embed`, { method: 'PUT', body: JSON.stringify({ embedEnabled: true, allowedOrigins: [origin] }) }), 'Embed settings saved')}>
              {enabled ? 'Update origin' : 'Enable embed'}
            </button>
          </>
        ) : null}
        {enabled && can('embed:issue_token') ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              const result = await run(() => call(`/api/admin/rooms/${room.id}/embed/sessions`, { method: 'POST', body: JSON.stringify({ allowedOrigin: origin, scope: ['embed:status', 'embed:join'] }) }), 'Embed session issued')()
              if (result) setIssued(result)
            }}
          >
            Issue session
          </button>
        ) : null}
      </div>
      {issued?.bootstrapToken ? (
        <div className="error-banner" style={{ background: 'var(--blue-50)', borderColor: 'var(--blue-500)', color: 'var(--blue-700)', marginBottom: 14 }}>
          One-time bootstrap token: <CopyField value={issued.bootstrapToken} label="bootstrap token" />
        </div>
      ) : null}
      <DataTable
        columns={[
          { key: 'id', label: 'Session', render: (session) => <span className="mono">{session.id}</span> },
          { key: 'allowedOrigin', label: 'Origin' },
          { key: 'expiresAt', label: 'Expires', render: (session) => fmtDateTime(session.expiresAt) },
          { key: 'revokedAt', label: 'State', render: (session) => <StatusBadge status={session.revokedAt ? 'disabled' : session.exchangedAt ? 'active' : 'waiting'} /> },
          {
            key: 'actions',
            label: '',
            render: (session) => can('embed:revoke') && !session.revokedAt ? (
              <span className="cell-actions">
                <button type="button" className="btn btn-danger-soft btn-xs" onClick={run(() => call(`/api/admin/rooms/${room.id}/embed/sessions/${session.id}/revoke`, { method: 'POST' }), 'Session revoked')}>Revoke</button>
              </span>
            ) : null,
          },
        ]}
        rows={data.sessions || []}
        rowKey={(session) => session.id}
        empty={<EmptyState title="No embed sessions" text={enabled ? 'Issue a session to test the iframe surface.' : 'Enable embedding for this room first.'} />}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Emails — invitation outbox + per-invitee resend.
// ---------------------------------------------------------------------------
function EmailsTab({ room }) {
  const { call, can } = useAdmin()
  const toast = useToast()
  const [data, setData] = useState(null)

  const load = useCallback(() => call(`/api/admin/rooms/${room.id}/emails`), [call, room.id])
  useEffect(() => {
    load().then(setData).catch((err) => toast(err.message, 'error'))
  }, [load, toast])

  if (!data) return <Skeleton lines={4} />

  const resend = async (email) => {
    try {
      await call(`/api/admin/rooms/${room.id}/invitees/${encodeURIComponent(email)}/resend-invite`, { method: 'POST' })
      toast(data.email.deliveryEnabled ? 'Invitation queued' : 'Invitation recorded (local mode — nothing is sent)', 'success')
      load().then(setData).catch(() => {})
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div>
      <p className="muted" style={{ marginBottom: 14 }}>
        Provider: <Badge tone={data.email.deliveryEnabled ? 'green' : 'gray'}>{data.email.provider}</Badge>{' '}
        {data.email.deliveryEnabled
          ? `— delivering via AWS SES as ${data.email.from}.`
          : '— local mode: emails are composed and recorded here, but nothing is sent. Set WEBRTC_EMAIL_PROVIDER=ses in production.'}
      </p>
      {(room.invitees || []).length && can('rooms:update_policy') ? (
        <div className="inline-actions" style={{ marginBottom: 14 }}>
          {(room.invitees || []).map((invitee) => (
            <button key={invitee.email} type="button" className="btn btn-xs" onClick={() => resend(invitee.email)}>
              Resend to {invitee.email}
            </button>
          ))}
        </div>
      ) : null}
      <DataTable
        columns={[
          { key: 'toEmail', label: 'To', sortable: true },
          { key: 'templateKey', label: 'Template', render: (row) => <span className="mono">{row.templateKey}</span> },
          { key: 'subject', label: 'Subject' },
          { key: 'status', label: 'Status', render: (row) => <StatusBadge status={row.status === 'local_recorded' ? 'waiting' : row.status === 'sent' ? 'finalized' : 'failed'} /> },
          { key: 'createdAt', label: 'When', sortable: true, render: (row) => fmtDateTime(row.createdAt) },
        ]}
        rows={data.emails}
        rowKey={(row) => row.id}
        empty={<EmptyState title="No emails yet" text="Invitation emails appear here when invitees are added to this room." />}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Audit — recent events + lifecycle history for this room.
// ---------------------------------------------------------------------------
function AuditTab({ audit, lifecycle }) {
  return (
    <div>
      {lifecycle?.length ? (
        <>
          <p className="section-title">Lifecycle</p>
          <div className="list-feed" style={{ marginBottom: 20 }}>
            {lifecycle.map((event) => (
              <article key={event.id}>
                <strong>{event.fromStatus || 'new'} → {event.toStatus}</strong>
                <span>{event.reason || 'No reason'} · {fmtDateTime(event.createdAt)}</span>
              </article>
            ))}
          </div>
        </>
      ) : null}
      <p className="section-title">Recent audit events</p>
      {audit.length ? (
        <div className="list-feed">
          {audit.map((event, index) => (
            <article key={`${event.action}-${event.createdAt}-${index}`}>
              <strong>{event.action}</strong>
              <span>{fmtDateTime(event.createdAt)}</span>
            </article>
          ))}
        </div>
      ) : <p className="muted">No audit events recorded yet.</p>}
    </div>
  )
}
