import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fmtDateTime } from '../lib/api.js'
import { DataTable, EmptyState, Field, Modal, SearchInput, Skeleton, StatusBadge, Tabs, useToast } from '../ui/kit.jsx'
import { IconPlus, IconVideo } from '../ui/icons.jsx'
import { useAdmin } from './portal.jsx'

const CLOSED_STATUSES = ['ended', 'expired', 'disabled']

// Zoom-style Meetings page: tabbed table of rooms with search + create modal.
export function RoomsPage() {
  const { call, can } = useAdmin()
  const navigate = useNavigate()
  const toast = useToast()
  const [rooms, setRooms] = useState(null)
  const [tab, setTab] = useState('upcoming')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async (q = query) => {
    const params = q ? `?${new URLSearchParams({ q })}` : ''
    const body = await call(`/api/admin/rooms${params}`)
    setRooms(body.rooms)
  }, [call, query])

  useEffect(() => {
    load('').catch((err) => toast(err.message, 'error'))
    // Initial load only; searches re-run through the form below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const grouped = useMemo(() => {
    const all = rooms || []
    return {
      upcoming: all.filter((room) => !CLOSED_STATUSES.includes(room.status)),
      previous: all.filter((room) => CLOSED_STATUSES.includes(room.status)),
      all,
    }
  }, [rooms])

  const visible = grouped[tab] || []

  const columns = [
    {
      key: 'displayName',
      label: 'Room',
      sortable: true,
      render: (room) => (
        <span>
          <span className="cell-main">{room.displayName}</span>
          <span className="cell-sub mono">{room.id}</span>
        </span>
      ),
    },
    { key: 'candidateId', label: 'Candidate', sortable: true, render: (room) => room.candidateId || '—' },
    { key: 'recruiterId', label: 'Recruiter', sortable: true, render: (room) => room.recruiterId || '—' },
    {
      key: 'scheduledStartAt',
      label: 'Scheduled',
      sortable: true,
      render: (room) => (
        room.scheduledStartAt ? (
          <span>
            <span className="cell-main">{fmtDateTime(room.scheduledStartAt)}</span>
            {room.joinWindowMinutes != null ? <span className="cell-sub">opens {room.joinWindowMinutes}m early</span> : null}
          </span>
        ) : <span className="muted">Unscheduled</span>
      ),
    },
    { key: 'status', label: 'Status', sortable: true, render: (room) => <StatusBadge status={room.status} /> },
    { key: 'presenceCount', label: 'In room', sortable: true, render: (room) => `${room.presenceCount} / ${room.maxParticipants}` },
    { key: 'createdAt', label: 'Created', sortable: true, render: (room) => fmtDateTime(room.createdAt) },
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Rooms</h1>
          <p className="page-sub">Interview rooms, their schedules, and live occupancy.</p>
        </div>
        {can('rooms:create') ? (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><IconPlus /> Create room</button>
        ) : null}
      </div>

      <div className="card">
        <Tabs
          active={tab}
          onChange={setTab}
          items={[
            { key: 'upcoming', label: 'Upcoming', count: grouped.upcoming.length },
            { key: 'previous', label: 'Previous', count: grouped.previous.length },
            { key: 'all', label: 'All', count: grouped.all.length },
          ]}
        />
        <form
          className="page-toolbar"
          onSubmit={(event) => { event.preventDefault(); load().catch((err) => toast(err.message, 'error')) }}
        >
          <SearchInput value={query} onChange={setQuery} placeholder="Search name, candidate, recruiter…" />
          <button className="btn" type="submit">Search</button>
        </form>
        {!rooms ? <Skeleton lines={5} /> : (
          <DataTable
            columns={columns}
            rows={visible}
            rowKey={(room) => room.id}
            onRowClick={(room) => navigate(`/admin/rooms/${room.id}`)}
            empty={(
              <EmptyState
                icon={IconVideo}
                title={tab === 'upcoming' ? 'No upcoming interviews' : 'Nothing here yet'}
                text={tab === 'upcoming' ? 'Create a room and share the invite link, or provision one from HirePortal.' : 'Rooms will appear here as their status changes.'}
                action={can('rooms:create') && tab === 'upcoming' ? (
                  <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><IconPlus /> Create room</button>
                ) : null}
              />
            )}
          />
        )}
      </div>

      {creating ? (
        <CreateRoomModal
          onClose={() => setCreating(false)}
          onCreated={async (room) => {
            setCreating(false)
            toast('Room created', 'success')
            await load().catch(() => {})
            navigate(`/admin/rooms/${room.id}`)
          }}
        />
      ) : null}
    </div>
  )
}

// Create-room wizard: identity mapping + schedule + access in one modal.
function CreateRoomModal({ onClose, onCreated }) {
  const { call } = useAdmin()
  const [draft, setDraft] = useState({
    displayName: '',
    password: '',
    candidateId: '',
    recruiterId: '',
    invitees: '',
    scheduledStartAt: '',
    durationMinutes: '60',
    joinWindowMinutes: '15',
    maxParticipants: '2',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (key) => (event) => setDraft({ ...draft, [key]: event.target.value })

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const startMs = draft.scheduledStartAt ? Date.parse(draft.scheduledStartAt) : null
      const body = await call('/api/admin/rooms', {
        method: 'POST',
        body: JSON.stringify({
          displayName: draft.displayName,
          password: draft.password,
          candidateId: draft.candidateId || undefined,
          recruiterId: draft.recruiterId || undefined,
          invitees: draft.invitees
            ? draft.invitees.split(',').map((email) => ({ email: email.trim() })).filter((entry) => entry.email)
            : undefined,
          schedule: startMs ? {
            scheduledStartAt: new Date(startMs).toISOString(),
            scheduledEndAt: new Date(startMs + Math.max(15, Number(draft.durationMinutes) || 60) * 60_000).toISOString(),
            joinWindowMinutes: Number(draft.joinWindowMinutes) || 15,
          } : undefined,
          maxParticipants: Number(draft.maxParticipants) || 2,
        }),
      })
      await onCreated(body.room)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <Modal title="Create interview room" onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Room name">
            <input value={draft.displayName} onChange={set('displayName')} placeholder="Interview — Jane Doe" required autoFocus />
          </Field>
          <Field label="Room password" hint="Guests need this with the link.">
            <input type="password" value={draft.password} onChange={set('password')} minLength="4" required />
          </Field>
          <Field label="Candidate ID" hint="HirePortal candidate id (drives the media room name).">
            <input value={draft.candidateId} onChange={set('candidateId')} placeholder="u2-candidate" />
          </Field>
          <Field label="Recruiter ID" hint="Portal identity that joins as host.">
            <input value={draft.recruiterId} onChange={set('recruiterId')} placeholder="u1" />
          </Field>
          <div className="field-full">
            <Field label="Invitee emails" hint="Comma-separated. When set, only these emails can join.">
              <input value={draft.invitees} onChange={set('invitees')} placeholder="jane@example.com, panel@company.com" />
            </Field>
          </div>
          <Field label="Scheduled start (optional)">
            <input type="datetime-local" value={draft.scheduledStartAt} onChange={set('scheduledStartAt')} />
          </Field>
          <Field label="Max participants" hint="2–5">
            <input inputMode="numeric" value={draft.maxParticipants} onChange={set('maxParticipants')} />
          </Field>
          {draft.scheduledStartAt ? (
            <>
              <Field label="Duration (minutes)">
                <input inputMode="numeric" value={draft.durationMinutes} onChange={set('durationMinutes')} />
              </Field>
              <Field label="Join window (minutes before start)">
                <input inputMode="numeric" value={draft.joinWindowMinutes} onChange={set('joinWindowMinutes')} />
              </Field>
            </>
          ) : null}
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create room'}</button>
        </div>
      </form>
    </Modal>
  )
}
