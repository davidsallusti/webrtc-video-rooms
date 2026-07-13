import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, isLocalOrigin, joinWindowNotice } from '../lib/api.js'
import { Field } from '../ui/kit.jsx'
import { IconClock, IconVideo } from '../ui/icons.jsx'
import { CallRoom } from './call.jsx'

// Focused topbar for the join/call flow (marketing shell lives in marketing.jsx).
function PublicTopbar() {
  return (
    <header className="public-topbar">
      <Link className="brand" to="/">
        <span className="brand-mark"><IconVideo /></span>
        InterviewRooms
      </Link>
      <div className="topbar-actions">
        <a className="btn btn-ghost" href="/admin">Sign in</a>
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------
// Room flow — /rooms/:roomId: gate → waiting → device check → call.
// ---------------------------------------------------------------------------
export function RoomFlowPage({ initialAccess = null, initialRoom = null }) {
  const { roomId } = useParams()
  const [room, setRoom] = useState(initialRoom)
  const [access, setAccess] = useState(initialAccess)
  const [waitingAccess, setWaitingAccess] = useState(null)
  const [deviceChecked, setDeviceChecked] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api(`/api/rooms/${roomId}`)
      .then((body) => { if (!cancelled) { setRoom(body.room); setError('') } })
      .catch((err) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [roomId])

  const handleAccess = (payload) => {
    setRoom(payload.room)
    if (payload.waiting) {
      setWaitingAccess(payload.access)
      setAccess(null)
    } else {
      setAccess(payload.access)
      setWaitingAccess(null)
    }
    setError('')
  }

  if (access && deviceChecked) return <CallRoom room={room} access={access} />

  return (
    <div>
      <PublicTopbar />
      <main className="gate-page">
        {error && !room ? (
          <div className="card gate-card">
            <div className="gate-head">
              <p className="gate-kicker">Room unavailable</p>
              <h1>We can&apos;t open this room</h1>
              <p>{error}</p>
            </div>
            <Link className="btn" to="/">Back to home</Link>
          </div>
        ) : waitingAccess ? (
          <WaitingCard room={room} access={waitingAccess} onAdmitted={(next) => { setAccess({ ...next, admissionStatus: 'admitted' }); setWaitingAccess(null) }} onRejected={setError} error={error} />
        ) : access ? (
          <DeviceCheckCard room={room} onReady={() => setDeviceChecked(true)} />
        ) : (
          <JoinGateCard room={room} roomId={roomId} onAccess={handleAccess} />
        )}
      </main>
    </div>
  )
}

function JoinGateCard({ room, roomId, onAccess }) {
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const windowNotice = room ? joinWindowNotice(room) : null

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = await api(`/api/rooms/${roomId}/access`, {
        method: 'POST',
        body: JSON.stringify({ password, email: email || undefined, displayName: displayName || undefined }),
      })
      onAccess(body)
    } catch (err) {
      setError(err.code === 'room_not_open' && windowNotice ? windowNotice : err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card gate-card">
      <div className="gate-head">
        <p className="gate-kicker">{room?.inviteeOnly ? 'Invite-only room' : 'Protected room'}</p>
        <h1>{room?.displayName || 'Join room'}</h1>
        <p>Your camera stays off until access is confirmed.</p>
      </div>
      {windowNotice ? (
        <div className="gate-steps"><span className="gate-step"><IconClock /> {windowNotice}</span></div>
      ) : null}
      <form onSubmit={submit}>
        {room?.inviteeOnly ? (
          <Field label="Invited email">
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoFocus required />
          </Field>
        ) : null}
        <Field label="Your name (optional)">
          <input value={displayName} maxLength={120} onChange={(event) => setDisplayName(event.target.value)} />
        </Field>
        <Field label="Room password">
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus={!room?.inviteeOnly} required />
        </Field>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button>
      </form>
      <div className="gate-steps">
        <span className="gate-step done"><i />Room link opened</span>
        {room?.inviteeOnly ? <span className={`gate-step${email ? ' done' : ''}`}><i />Invited email</span> : null}
        <span className={`gate-step${password ? ' done' : ''}`}><i />Password</span>
        <span className="gate-step"><i />Device check</span>
        <span className="gate-step"><i />Join call</span>
      </div>
    </div>
  )
}

function WaitingCard({ room, access, onAdmitted, onRejected, error }) {
  const [status, setStatus] = useState(access.admissionStatus || 'waiting')

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const body = await api(`/api/rooms/${room.id}/access-status`, {
          headers: {
            'x-participant-id': access.participantId,
            'x-room-access-token': access.accessToken,
          },
        })
        if (cancelled) return
        setStatus(body.admissionStatus)
        if (body.admissionStatus === 'admitted') onAdmitted(access)
        if (['rejected', 'removed'].includes(body.admissionStatus)) onRejected('The host did not admit this request.')
      } catch (err) {
        if (!cancelled && err.code === 'invalid_access') onRejected('The host did not admit this request.')
      }
    }
    check()
    const timer = window.setInterval(check, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [access, onAdmitted, onRejected, room.id])

  return (
    <div className="card gate-card">
      <span className="waiting-pulse"><IconClock /></span>
      <div className="gate-head">
        <h1>Waiting for the host</h1>
        <p>Your password was accepted. The host will admit you shortly — keep this tab open.</p>
      </div>
      <div className="gate-steps">
        <span className="gate-step done"><i />Password accepted</span>
        <span className={`gate-step${status === 'admitted' ? ' done' : ''}`}><i />Host admission</span>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  )
}

// Pre-join device check: camera preview + live mic level, then hand off to the
// call (which acquires its own tracks through LiveKit).
function DeviceCheckCard({ room, onReady }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [state, setState] = useState('idle') // idle | requesting | ready | denied
  const [micLevel, setMicLevel] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  const start = async () => {
    setState('requesting')
    setError('')
    if (!window.isSecureContext && !isLocalOrigin()) {
      setState('denied')
      setError('Camera and microphone access require localhost or HTTPS.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      // Lightweight mic meter via WebAudio; closed with the stream on join.
      const audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        if (!streamRef.current) { audioContext.close().catch(() => {}); return }
        analyser.getByteFrequencyData(data)
        setMicLevel(Math.min(100, Math.round((data.reduce((sum, value) => sum + value, 0) / data.length) * 1.6)))
        requestAnimationFrame(tick)
      }
      tick()
      setState('ready')
    } catch {
      setState('denied')
      setError('Camera or microphone permission was denied.')
    }
  }

  const join = () => {
    // Release preflight devices before LiveKit acquires its own.
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    onReady()
  }

  return (
    <div className="card gate-card" style={{ maxWidth: 480 }}>
      <div className="gate-head">
        <p className="gate-kicker">Device check</p>
        <h1>Ready to join {room?.displayName}?</h1>
        <p>Check how you look and sound before entering the room.</p>
      </div>
      <div className="devicecheck-preview">
        <video ref={videoRef} autoPlay playsInline muted />
        {state !== 'ready' ? (
          <div className="preview-off">{state === 'requesting' ? 'Opening camera…' : 'Camera preview appears here'}</div>
        ) : null}
      </div>
      {state === 'ready' ? (
        <Field label="Microphone level">
          <span className="mic-meter"><i style={{ width: `${micLevel}%` }} /></span>
        </Field>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
      {state === 'ready' ? (
        <button className="btn btn-primary btn-lg" type="button" onClick={join}>Join now</button>
      ) : (
        <button className="btn btn-primary btn-lg" type="button" onClick={start} disabled={state === 'requesting'}>
          {state === 'requesting' ? 'Requesting devices…' : 'Enable camera & mic'}
        </button>
      )}
    </div>
  )
}
