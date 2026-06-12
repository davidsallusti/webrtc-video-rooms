import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

function iceServersFromEnv() {
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }]
  const raw = import.meta.env.VITE_WEBRTC_ICE_SERVERS_JSON
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length ? parsed : fallback
  } catch {
    return fallback
  }
}

const ICE_SERVERS = iceServersFromEnv()

function roomIdFromPath() {
  const match = window.location.pathname.match(/^\/rooms\/([^/]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

function isAdminPath() {
  return window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/')
}

function short(value) {
  return String(value || '').slice(0, 8)
}

function isLocalOrigin() {
  return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.message || `Request failed (${response.status})`)
    error.code = body?.error || 'request_failed'
    error.status = response.status
    throw error
  }
  return body
}

async function adminApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(options.csrfToken ? { 'x-csrf-token': options.csrfToken } : {}),
      ...(options.headers || {}),
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.message || `Request failed (${response.status})`)
    error.code = body?.error || 'request_failed'
    error.status = response.status
    throw error
  }
  return body
}

function useClipboard() {
  const [copied, setCopied] = useState(false)
  return {
    copied,
    async copy(value) {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    },
  }
}

function Root() {
  if (isAdminPath()) return <AdminApp />
  return <App />
}

function App() {
  const initialRoomId = roomIdFromPath()
  const [roomId, setRoomId] = useState(initialRoomId)
  const [room, setRoom] = useState(null)
  const [access, setAccess] = useState(null)
  const [waitingAccess, setWaitingAccess] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!roomId) return
    let cancelled = false
    api(`/api/rooms/${roomId}`)
      .then((body) => {
        if (!cancelled) {
          setRoom(body.room)
          setError('')
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [roomId])

  const handleRoomCreated = (created) => {
    setRoom(created.room)
    setAccess(created.access)
    setRoomId(created.room.id)
    setError('')
    window.history.pushState(null, '', `/rooms/${created.room.id}`)
  }

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

  const handleAdmitted = (nextAccess) => {
    setAccess({ ...nextAccess, admissionStatus: 'admitted' })
    setWaitingAccess(null)
    setError('')
  }

  return (
    <div className="app-shell">
      <TopBar />
      <main className="product-shell">
        <section className="hero">
          <div>
            <p className="eyebrow">Local-first WebRTC</p>
            <h1>Secure 1:1 video rooms in one clean flow.</h1>
          </div>
          <div className="hero-points" aria-label="MVP guarantees">
            <span>API-backed rooms</span>
            <span>Password before camera</span>
            <span>Ephemeral review rooms</span>
          </div>
        </section>

        {error ? <div className="error-banner" role="alert">{error}</div> : null}

        {!roomId ? (
          <CreateRoom onCreated={handleRoomCreated} />
        ) : waitingAccess ? (
          <WaitingForAdmission room={room} access={waitingAccess} onAdmitted={handleAdmitted} onRejected={setError} />
        ) : !access ? (
          <JoinRoom room={room} roomId={roomId} onAccess={handleAccess} />
        ) : (
          <CallRoom room={room} access={access} />
        )}
      </main>
    </div>
  )
}

function TopBar() {
  return (
    <header className="topbar">
      <a className="brand" href="/" onClick={(event) => {
        event.preventDefault()
        window.history.pushState(null, '', '/')
        window.location.reload()
      }}>
        <span>WR</span>
        <strong>WebRTC Rooms</strong>
      </a>
      <span className="boundary-pill">Local demo · P2P · no recording</span>
      <a className="admin-link" href="/admin">Admin</a>
    </header>
  )
}

function CreateRoom({ onCreated }) {
  const [displayName, setDisplayName] = useState('Focus room')
  const [password, setPassword] = useState('')
  const [metadataProject, setMetadataProject] = useState('')
  const [metadataTicket, setMetadataTicket] = useState('')
  const [created, setCreated] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const clipboard = useClipboard()

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = await api('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({
          displayName,
          password,
          metadata: {
            project: metadataProject,
            ticket: metadataTicket,
          },
        }),
      })
      setCreated(body)
      onCreated(body)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="stage-grid">
      <form className="panel form-panel" onSubmit={submit}>
        <p className="eyebrow">Create room</p>
        <h2>Start a protected room</h2>
        <label>
          <span>Room name</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Design review" />
        </label>
        <label>
          <span>Room password</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength="4" placeholder="Minimum 4 characters" required />
        </label>
        <div className="metadata-fields">
          <label>
            <span>Project metadata</span>
            <input value={metadataProject} onChange={(event) => setMetadataProject(event.target.value)} placeholder="Optional project or customer" />
          </label>
          <label>
            <span>Ticket metadata</span>
            <input value={metadataTicket} onChange={(event) => setMetadataTicket(event.target.value)} placeholder="Optional ticket or task ID" />
          </label>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Creating...' : 'Create secure room'}</button>
      </form>
      <aside className="panel share-panel">
        <p className="eyebrow">Room link</p>
        <h2>{created ? created.room.displayName : 'Share after creation'}</h2>
        <p>Passwords never appear in room links. Guests validate access before the browser asks for camera or microphone permission.</p>
        <p className="muted">Public review rooms are short-lived and can reset on restart or redeploy. Direct P2P uses public STUN only, so restrictive networks may need a later approved TURN upgrade.</p>
        {created ? (
          <div className="share-box">
            <code>{created.shareUrl}</code>
            <button type="button" onClick={() => clipboard.copy(created.shareUrl)}>{clipboard.copied ? 'Copied' : 'Copy link'}</button>
          </div>
        ) : null}
      </aside>
    </section>
  )
}

function JoinRoom({ room, roomId, onAccess }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = await api(`/api/rooms/${roomId}/access`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      })
      onAccess(body)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="stage-grid">
      <form className="panel form-panel" onSubmit={submit}>
        <p className="eyebrow">Password gate</p>
        <h2>{room?.displayName || 'Join protected room'}</h2>
        <p className="muted">Camera and microphone access is requested only after this password is accepted.</p>
        <label>
          <span>Room password</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus required />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Checking...' : 'Continue to camera'}</button>
      </form>
      <aside className="panel status-panel">
        <StatusStep done label="Room link opened" />
        <StatusStep done={Boolean(password)} label="Password entered" />
        <StatusStep label="Camera prompt after validation" />
        <StatusStep label="1:1 peer connection" />
      </aside>
    </section>
  )
}

function StatusStep({ done, label }) {
  return <span className={`status-step${done ? ' done' : ''}`}><i />{label}</span>
}

function WaitingForAdmission({ room, access, onAdmitted, onRejected }) {
  const [status, setStatus] = useState(access.admissionStatus || 'waiting')
  const [error, setError] = useState('')

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
        if (!cancelled) {
          setError(err.message)
          if (err.code === 'invalid_access') onRejected('The host did not admit this request.')
        }
      }
    }
    check()
    const timer = window.setInterval(check, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [access, onAdmitted, onRejected, room.id])

  return (
    <section className="stage-grid">
      <div className="panel permission-card">
        <p className="eyebrow">Waiting room</p>
        <h2>{room?.displayName || 'Waiting for host'}</h2>
        <p>Your password was accepted. The host needs to admit you before camera, microphone, or signaling starts.</p>
        <StatusStep done={status === 'waiting'} label="Request sent to host" />
        {error ? <p className="form-error">{error}</p> : null}
      </div>
      <aside className="panel status-panel">
        <StatusStep done label="Room password accepted" />
        <StatusStep done={status === 'admitted'} label="Host admission" />
        <StatusStep label="Camera prompt after admission" />
      </aside>
    </section>
  )
}

function CallRoom({ room, access }) {
  const [permissionState, setPermissionState] = useState('idle')
  const [connectionState, setConnectionState] = useState('waiting')
  const [error, setError] = useState('')
  const [micOn, setMicOn] = useState(true)
  const [cameraOn, setCameraOn] = useState(true)
  const [hasRemoteStream, setHasRemoteStream] = useState(false)
  const [chatMessages, setChatMessages] = useState([])
  const [chatDraft, setChatDraft] = useState('')
  const [chatRetention, setChatRetention] = useState(null)
  const [transcriptStatus, setTranscriptStatus] = useState(null)
  const [recordingStatus, setRecordingStatus] = useState(null)
  const [captionSegments, setCaptionSegments] = useState([])
  const [endingRoom, setEndingRoom] = useState(false)
  const [waitingParticipants, setWaitingParticipants] = useState([])
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const localStreamRef = useRef(null)
  const peerRef = useRef(null)
  const wsRef = useRef(null)
  const makingOfferRef = useRef(false)
  const ignoreOfferRef = useRef(false)
  const remoteParticipantRef = useRef(null)
  const pendingCandidatesRef = useRef([])
  const clipboard = useClipboard()
  const shareUrl = `${window.location.origin}/rooms/${room.id}`

  const loadWaitingParticipants = useCallback(async () => {
    if (access.role !== 'host') return
    const body = await api(`/api/rooms/${room.id}/waiting`, {
      headers: {
        'x-participant-id': access.participantId,
        'x-room-access-token': access.accessToken,
      },
    })
    setWaitingParticipants(body.waitingParticipants || [])
  }, [access, room.id])

  useEffect(() => {
    if (access.role !== 'host') return undefined
    let cancelled = false
    const tick = async () => {
      try {
        if (!cancelled) await loadWaitingParticipants()
      } catch {
        if (!cancelled) setWaitingParticipants([])
      }
    }
    tick()
    const timer = window.setInterval(tick, 2500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [access.role, loadWaitingParticipants])

  const chatCredentials = useCallback(() => ({
    'x-participant-id': access.participantId,
    'x-room-access-token': access.accessToken,
  }), [access.accessToken, access.participantId])

  const loadRetainedChat = useCallback(async () => {
    const body = await api(`/api/rooms/${room.id}/chat`, {
      headers: chatCredentials(),
    })
    setChatRetention(body.retention)
    setChatMessages((body.messages || []).map((message) => ({
      id: message.id,
      text: message.body,
      sentAt: message.createdAt,
      author: message.participantId === access.participantId ? 'You' : (message.senderRole === 'host' ? 'Host' : 'Guest'),
      self: message.participantId === access.participantId,
      retained: true,
    })))
  }, [access.participantId, chatCredentials, room.id])

  useEffect(() => {
    let cancelled = false
    loadRetainedChat().catch(() => {
      if (!cancelled) setChatRetention(null)
    })
    return () => {
      cancelled = true
    }
  }, [loadRetainedChat])

  const loadTranscriptStatus = useCallback(async () => {
    const body = await api(`/api/rooms/${room.id}/transcript/status`, {
      headers: chatCredentials(),
    })
    setTranscriptStatus(body)
  }, [chatCredentials, room.id])

  useEffect(() => {
    let cancelled = false
    loadTranscriptStatus().catch(() => {
      if (!cancelled) setTranscriptStatus(null)
    })
    return () => {
      cancelled = true
    }
  }, [loadTranscriptStatus])

  const recordTranscriptConsent = async (status) => {
    try {
      const body = await api(`/api/rooms/${room.id}/transcript/consent`, {
        method: 'POST',
        headers: chatCredentials(),
        body: JSON.stringify({ status }),
      })
      setTranscriptStatus(body)
    } catch (err) {
      setError(err.message)
    }
  }

  const loadRecordingStatus = useCallback(async () => {
    const body = await api(`/api/rooms/${room.id}/recording/status`, {
      headers: chatCredentials(),
    })
    setRecordingStatus(body)
  }, [chatCredentials, room.id])

  useEffect(() => {
    let cancelled = false
    loadRecordingStatus().catch(() => {
      if (!cancelled) setRecordingStatus(null)
    })
    return () => {
      cancelled = true
    }
  }, [loadRecordingStatus])

  const recordRecordingConsent = async (status) => {
    try {
      const body = await api(`/api/rooms/${room.id}/recording/consent`, {
        method: 'POST',
        headers: chatCredentials(),
        body: JSON.stringify({ status }),
      })
      setRecordingStatus(body)
    } catch (err) {
      setError(err.message)
    }
  }

  const loadCaptions = useCallback(async () => {
    const body = await api(`/api/rooms/${room.id}/live-captions`, {
      headers: chatCredentials(),
    })
    setCaptionSegments(body.segments || [])
  }, [chatCredentials, room.id])

  useEffect(() => {
    if (transcriptStatus?.consent?.status !== 'acknowledged' || !transcriptStatus?.settings?.liveCaptionsEnabled) return undefined
    let cancelled = false
    const tick = async () => {
      try {
        if (!cancelled) await loadCaptions()
      } catch {
        if (!cancelled) setCaptionSegments([])
      }
    }
    tick()
    const timer = window.setInterval(tick, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [loadCaptions, transcriptStatus])

  const start = useCallback(async () => {
    setPermissionState('requesting')
    setError('')
    if (!window.isSecureContext && !isLocalOrigin()) {
      setPermissionState('denied')
      setConnectionState('media_blocked')
      setError('Camera and microphone access require localhost or HTTPS. For this local MVP, open the room from http://127.0.0.1:5180 on the review machine.')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermissionState('denied')
      setConnectionState('media_blocked')
      setError('This browser does not expose camera or microphone access to the app.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      localStreamRef.current = stream
      if (localVideoRef.current) localVideoRef.current.srcObject = stream
      setPermissionState('granted')
      setConnectionState('connecting')
    } catch {
      setPermissionState('denied')
      setConnectionState('media_blocked')
      setError('Camera or microphone permission was denied.')
    }
  }, [])

  useEffect(() => {
    if (permissionState !== 'granted' || !localVideoRef.current || !localStreamRef.current) return
    if (localVideoRef.current.srcObject !== localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current
    }
  }, [permissionState])

  useEffect(() => {
    if (permissionState !== 'granted') return undefined
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${wsProtocol}://${window.location.host}/ws/signaling`)
    peerRef.current = pc
    wsRef.current = ws
    remoteParticipantRef.current = null
    pendingCandidatesRef.current = []

    const shouldMakeOffer = (remoteParticipantId = remoteParticipantRef.current) => {
      return Boolean(remoteParticipantId) && access.participantId < remoteParticipantId
    }

    const flushPendingCandidates = async () => {
      if (!pc.remoteDescription) return
      const candidates = pendingCandidatesRef.current.splice(0)
      for (const candidate of candidates) {
        await pc.addIceCandidate(candidate)
      }
    }

    const sendOffer = async () => {
      if (!shouldMakeOffer() || ws.readyState !== WebSocket.OPEN || pc.signalingState !== 'stable') return
      try {
        makingOfferRef.current = true
        await pc.setLocalDescription()
        ws.send(JSON.stringify({ type: 'offer', description: pc.localDescription }))
      } finally {
        makingOfferRef.current = false
      }
    }

    localStreamRef.current?.getTracks().forEach((track) => pc.addTrack(track, localStreamRef.current))

    pc.ontrack = (event) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0]
        setHasRemoteStream(true)
      }
    }
    pc.onconnectionstatechange = () => {
      setConnectionState(pc.connectionState)
    }
    pc.onicecandidate = (event) => {
      if (event.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ice-candidate', candidate: event.candidate }))
      }
    }
    pc.onnegotiationneeded = async () => {
      await sendOffer()
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'auth',
        roomId: room.id,
        participantId: access.participantId,
        accessToken: access.accessToken,
      }))
    }
    ws.onmessage = async (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'error') {
        setError(message.message)
        setConnectionState(message.code)
        return
      }
      if (message.type === 'authenticated') {
        remoteParticipantRef.current = message.peers[0]?.participantId || null
        setConnectionState(message.peers.length ? 'connecting' : 'waiting')
        ws.send(JSON.stringify({ type: 'ready' }))
        await sendOffer()
        return
      }
      if (message.type === 'peer-joined') {
        remoteParticipantRef.current = message.peer?.participantId || remoteParticipantRef.current
        setConnectionState('connecting')
        await sendOffer()
        return
      }
      if (message.type === 'ready') {
        remoteParticipantRef.current = message.from || remoteParticipantRef.current
        setConnectionState('connecting')
        await sendOffer()
        return
      }
      if (message.type === 'peer-left') {
        remoteParticipantRef.current = null
        pendingCandidatesRef.current = []
        setHasRemoteStream(false)
        setConnectionState('waiting')
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
        return
      }
      if (message.type === 'room-ended') {
        remoteParticipantRef.current = null
        pendingCandidatesRef.current = []
        setHasRemoteStream(false)
        setConnectionState('room_ended')
        setError('This room has ended for everyone.')
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
        return
      }
      if (message.type === 'chat-message') {
        setChatMessages((current) => [
          ...current,
          {
            id: message.id || `${Date.now()}-${current.length}`,
            text: message.text,
            sentAt: message.sentAt || new Date().toISOString(),
            author: message.fromRole === 'host' ? 'Host' : 'Guest',
            self: false,
          },
        ])
        return
      }
      if (message.type === 'offer' || message.type === 'answer') {
        remoteParticipantRef.current = message.from || remoteParticipantRef.current
        const description = message.description
        const offerCollision = description.type === 'offer' && (makingOfferRef.current || pc.signalingState !== 'stable')
        ignoreOfferRef.current = offerCollision && shouldMakeOffer(message.from)
        if (ignoreOfferRef.current) return
        if (offerCollision) {
          await pc.setLocalDescription({ type: 'rollback' })
        }
        await pc.setRemoteDescription(description)
        if (description.type === 'offer') {
          await pc.setLocalDescription()
          ws.send(JSON.stringify({ type: 'answer', description: pc.localDescription }))
        }
        await flushPendingCandidates()
        return
      }
      if (message.type === 'ice-candidate' && message.candidate) {
        try {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(message.candidate)
          } else {
            pendingCandidatesRef.current.push(message.candidate)
          }
        } catch (err) {
          if (!ignoreOfferRef.current) throw err
        }
      }
    }
    ws.onclose = () => {
      if (!['closed', 'failed'].includes(pc.connectionState)) setConnectionState('left')
    }

    return () => {
      ws.close()
      pc.close()
    }
  }, [access, permissionState, room])

  const toggleMic = () => {
    const next = !micOn
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = next })
    setMicOn(next)
  }

  const toggleCamera = () => {
    const next = !cameraOn
    localStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = next })
    setCameraOn(next)
  }

  const leave = () => {
    wsRef.current?.send(JSON.stringify({ type: 'leave' }))
    wsRef.current?.close()
    peerRef.current?.close()
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    window.history.pushState(null, '', '/')
    window.location.reload()
  }

  const endForAll = async () => {
    if (access.role !== 'host') return
    setEndingRoom(true)
    setError('')
    try {
      await api(`/api/rooms/${room.id}/end`, {
        method: 'POST',
        headers: {
          'x-participant-id': access.participantId,
          'x-room-access-token': access.accessToken,
        },
        body: JSON.stringify({ reason: 'host ended room' }),
      })
      wsRef.current?.close()
      peerRef.current?.close()
      setConnectionState('room_ended')
      setError('You ended this room for everyone.')
    } catch (err) {
      setError(err.message)
    } finally {
      setEndingRoom(false)
    }
  }

  const sendChat = async (event) => {
    event.preventDefault()
    const text = chatDraft.trim()
    if (!text || wsRef.current?.readyState !== WebSocket.OPEN) return
    const message = {
      id: `${access.participantId}-${Date.now()}`,
      type: 'chat-message',
      text,
    }
    try {
      const retained = await api(`/api/rooms/${room.id}/chat`, {
        method: 'POST',
        headers: chatCredentials(),
        body: JSON.stringify({ body: text }),
      })
      wsRef.current.send(JSON.stringify(message))
      if (retained.message) {
        setChatRetention(retained.retention)
        setChatMessages((current) => [
          ...current,
          {
            id: retained.message.id,
            text: retained.message.body,
            sentAt: retained.message.createdAt,
            author: 'You',
            self: true,
            retained: true,
          },
        ])
      } else {
        setChatMessages((current) => [
          ...current,
          {
            id: message.id,
            text,
            sentAt: new Date().toISOString(),
            author: 'You',
            self: true,
          },
        ])
      }
      setChatDraft('')
    } catch (err) {
      setError(err.message)
    }
  }

  const decideWaiting = async (participantId, decision) => {
    await api(`/api/rooms/${room.id}/waiting/${participantId}/${decision}`, {
      method: 'POST',
      headers: {
        'x-participant-id': access.participantId,
        'x-room-access-token': access.accessToken,
      },
    })
    await loadWaitingParticipants()
  }

  return (
    <section className="call-shell">
      <div className="call-header panel">
        <div>
          <p className="eyebrow">Room {short(room.id)}</p>
          <h2>{room.displayName}</h2>
          <button className="link-button" type="button" onClick={() => clipboard.copy(shareUrl)}>
            {clipboard.copied ? 'Copied room link' : 'Copy room link'}
          </button>
        </div>
        <span className={`call-state state-${connectionState}`}>{connectionCopy(connectionState)}</span>
      </div>

      {permissionState !== 'granted' ? (
        <div className="panel permission-card">
          <p className="eyebrow">Device permission</p>
          <h2>Ready to turn on camera and microphone?</h2>
          <p>Access is validated. The browser permission prompt starts only when you continue. Rooms are ephemeral during public review, and no-TURN P2P may fail on restrictive networks.</p>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="primary" type="button" onClick={start} disabled={permissionState === 'requesting'}>
            {permissionState === 'requesting' ? 'Opening devices...' : 'Enable camera and mic'}
          </button>
        </div>
      ) : (
        <>
          <div className="room-grid">
            <section className="stage-panel">
              <VideoTile
                label="Remote participant"
                refObj={remoteVideoRef}
                muted={false}
                variant="main"
                empty={!hasRemoteStream}
                emptyTitle={connectionState === 'waiting' ? 'Waiting for participant' : 'Connecting remote video'}
                emptyText={connectionState === 'waiting'
                  ? 'Your camera is on in the self-preview. The guest appears here after joining with the room link and password.'
                  : 'Keep this room open while the peer connection finishes.'}
              />
            </section>
            <aside className="room-rail">
              <VideoTile
                label="You"
                refObj={localVideoRef}
                muted
                variant="self"
                cameraOn={cameraOn}
              />
              <ChatPanel
                messages={chatMessages}
                draft={chatDraft}
                onDraft={setChatDraft}
                onSubmit={sendChat}
                retention={chatRetention}
                disabled={wsRef.current?.readyState !== WebSocket.OPEN}
              />
            <TranscriptNoticePanel
              status={transcriptStatus}
              segments={captionSegments}
              onConsent={recordTranscriptConsent}
            />
            <RecordingNoticePanel
              status={recordingStatus}
              onConsent={recordRecordingConsent}
            />
            {access.role === 'host' ? (
                <WaitingHostPanel participants={waitingParticipants} onDecision={decideWaiting} />
              ) : null}
            </aside>
          </div>
          {error ? <div className="error-banner" role="alert">{error}</div> : null}
          <div className="controls panel">
            <button type="button" onClick={toggleMic}>{micOn ? 'Mute mic' : 'Unmute mic'}</button>
            <button type="button" onClick={toggleCamera}>{cameraOn ? 'Turn camera off' : 'Turn camera on'}</button>
            {access.role === 'host' ? (
              <button type="button" className="danger" onClick={endForAll} disabled={endingRoom}>
                {endingRoom ? 'Ending...' : 'End for all'}
              </button>
            ) : null}
            <button type="button" className="danger" onClick={leave}>Leave room</button>
          </div>
        </>
      )}
    </section>
  )
}

function connectionCopy(state) {
  if (state === 'connected') return 'Connected'
  if (state === 'connecting') return 'Connecting'
  if (state === 'waiting') return 'Waiting for peer'
  if (state === 'media_blocked') return 'Camera blocked'
  if (state === 'room_full') return 'Room full'
  if (state === 'room_ended') return 'Room ended'
  if (state === 'failed') return 'Connection failed'
  return state || 'Preparing'
}

function AdminApp() {
  const [bootstrap, setBootstrap] = useState(null)
  const [user, setUser] = useState(null)
  const [csrfToken, setCsrfToken] = useState('')
  const [rooms, setRooms] = useState([])
  const [selectedRoom, setSelectedRoom] = useState(null)
  const [audit, setAudit] = useState([])
  const [integrations, setIntegrations] = useState(null)
  const [roomChat, setRoomChat] = useState(null)
  const [roomTranscripts, setRoomTranscripts] = useState(null)
  const [roomRecordings, setRoomRecordings] = useState(null)
  const [roomEmbed, setRoomEmbed] = useState(null)
  const [roomFilters, setRoomFilters] = useState({ status: '', q: '' })
  const [error, setError] = useState('')

  const loadBootstrap = useCallback(async () => {
    const body = await adminApi('/api/admin/bootstrap/status')
    setBootstrap(body)
    return body
  }, [])

  const loadSession = useCallback(async () => {
    try {
      const body = await adminApi('/api/admin/session')
      setUser(body.user)
      setCsrfToken(body.csrfToken)
      setError('')
      return body.user
    } catch {
      setUser(null)
      setCsrfToken('')
      return null
    }
  }, [])

  const loadRooms = useCallback(async (filters = roomFilters) => {
    const params = new URLSearchParams()
    if (filters.status) params.set('status', filters.status)
    if (filters.q) params.set('q', filters.q)
    const body = await adminApi(`/api/admin/rooms${params.toString() ? `?${params}` : ''}`)
    setRooms(body.rooms)
  }, [roomFilters])

  const loadIntegrations = useCallback(async (currentUser = user) => {
    if (!currentUser?.permissions?.includes('integrations:view')) return null
    const body = await adminApi('/api/admin/integrations')
    setIntegrations(body)
    return body
  }, [user])

  useEffect(() => {
    let cancelled = false
    Promise.all([loadBootstrap(), loadSession()])
      .then(([, currentUser]) => {
        if (!cancelled && currentUser && !currentUser.setupRequired) return Promise.all([loadRooms(), loadIntegrations(currentUser)])
        return null
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [loadBootstrap, loadIntegrations, loadRooms, loadSession])

  const refreshAfterAuth = async (body) => {
    setUser(body.user)
    setCsrfToken(body.csrfToken)
    setError('')
    if (!body.user.setupRequired) await Promise.all([loadRooms(), loadIntegrations(body.user)])
  }

  const openRoom = async (roomId) => {
    const body = await adminApi(`/api/admin/rooms/${roomId}`)
    setSelectedRoom(body.room)
    setAudit(body.audit)
    if (user?.permissions?.includes('chat:view')) {
      const chat = await adminApi(`/api/admin/rooms/${roomId}/chat`)
      setRoomChat(chat)
    } else {
      setRoomChat(null)
    }
    if (user?.permissions?.includes('transcripts:view')) {
      const transcripts = await adminApi(`/api/admin/rooms/${roomId}/transcripts`)
      setRoomTranscripts(transcripts)
    } else if (user?.permissions?.includes('transcripts:configure')) {
      const settings = await adminApi(`/api/admin/rooms/${roomId}/transcript-settings`)
      setRoomTranscripts(settings)
    } else {
      setRoomTranscripts(null)
    }
    if (user?.permissions?.includes('recordings:view')) {
      const recordings = await adminApi(`/api/admin/rooms/${roomId}/recordings`)
      setRoomRecordings(recordings)
    } else if (user?.permissions?.includes('recordings:configure')) {
      const settings = await adminApi(`/api/admin/rooms/${roomId}/recording-settings`)
      setRoomRecordings(settings)
    } else {
      setRoomRecordings(null)
    }
    if (user?.permissions?.includes('embed:view')) {
      const embed = await adminApi(`/api/admin/rooms/${roomId}/embed`)
      setRoomEmbed(embed)
    } else {
      setRoomEmbed(null)
    }
  }

  const endRoom = async (roomId) => {
    const body = await adminApi(`/api/admin/rooms/${roomId}/end`, {
      method: 'POST',
      csrfToken,
      body: JSON.stringify({ confirm: true, reason: 'admin ended room' }),
    })
    setSelectedRoom(body.room)
    await loadRooms()
  }

  const createAdminRoom = async (payload) => {
    const body = await adminApi('/api/admin/rooms', {
      method: 'POST',
      csrfToken,
      body: JSON.stringify(payload),
    })
    await loadRooms()
    await openRoom(body.room.id)
  }

  const lifecycleCommand = async (roomId, command, payload = {}) => {
    const body = await adminApi(`/api/admin/rooms/${roomId}/lifecycle/${command}`, {
      method: 'POST',
      csrfToken,
      body: JSON.stringify(payload),
    })
    setSelectedRoom(body.room)
    await loadRooms()
    await openRoom(roomId)
  }

  const updatePolicy = async (roomId, patch) => {
    const body = await adminApi(`/api/admin/rooms/${roomId}/policy`, {
      method: 'PATCH',
      csrfToken,
      body: JSON.stringify(patch),
    })
    setSelectedRoom(body.room)
    await loadRooms()
    await openRoom(roomId)
  }

  const updateChatRetention = async (roomId, patch) => {
    await adminApi(`/api/admin/rooms/${roomId}/chat-settings`, {
      method: 'PUT',
      csrfToken,
      body: JSON.stringify(patch),
    })
    await openRoom(roomId)
  }

  const exportChat = async (roomId) => {
    const exported = await adminApi(`/api/admin/rooms/${roomId}/chat/export`)
    setRoomChat(exported)
  }

  const redactChatMessage = async (roomId, messageId) => {
    await adminApi(`/api/admin/rooms/${roomId}/chat/${messageId}/redact`, {
      method: 'POST',
      csrfToken,
    })
    await openRoom(roomId)
  }

  const deleteChatMessage = async (roomId, messageId) => {
    await adminApi(`/api/admin/rooms/${roomId}/chat/${messageId}/delete`, {
      method: 'POST',
      csrfToken,
    })
    await openRoom(roomId)
  }

  const updateTranscriptSettings = async (roomId, patch) => {
    await adminApi(`/api/admin/rooms/${roomId}/transcript-settings`, {
      method: 'PUT',
      csrfToken,
      body: JSON.stringify(patch),
    })
    await openRoom(roomId)
  }

  const startTranscriptMock = async (roomId) => {
    await adminApi(`/api/admin/rooms/${roomId}/transcripts/mock/start`, {
      method: 'POST',
      csrfToken,
      body: JSON.stringify({ providerKey: 'mock_local', language: 'en' }),
    })
    await openRoom(roomId)
  }

  const appendTranscriptMock = async (roomId, artifactId, text) => {
    await adminApi(`/api/admin/rooms/${roomId}/transcripts/${artifactId}/mock-segments`, {
      method: 'POST',
      csrfToken,
      body: JSON.stringify({ text, speakerLabel: 'Mock speaker', startMs: Date.now() % 100000, endMs: (Date.now() % 100000) + 1200 }),
    })
    await openRoom(roomId)
  }

  const finalizeTranscriptMock = async (roomId, artifactId) => {
    await adminApi(`/api/admin/rooms/${roomId}/transcripts/${artifactId}/finalize`, {
      method: 'POST',
      csrfToken,
    })
    await openRoom(roomId)
  }

  const exportTranscript = async (roomId, artifactId) => {
    const exported = await adminApi(`/api/admin/rooms/${roomId}/transcripts/${artifactId}/export`)
    setRoomTranscripts({ ...roomTranscripts, selectedExport: exported })
  }

  const redactTranscriptSegment = async (roomId, artifactId, segmentId) => {
    await adminApi(`/api/admin/rooms/${roomId}/transcripts/${artifactId}/segments/${segmentId}/redact`, {
      method: 'POST',
      csrfToken,
    })
    await openRoom(roomId)
  }

  const deleteTranscriptSegment = async (roomId, artifactId, segmentId) => {
    await adminApi(`/api/admin/rooms/${roomId}/transcripts/${artifactId}/segments/${segmentId}/delete`, {
      method: 'POST',
      csrfToken,
    })
    await openRoom(roomId)
  }

  const updateRecordingSettings = async (roomId, patch) => {
    await adminApi(`/api/admin/rooms/${roomId}/recording-settings`, {
      method: 'PUT',
      csrfToken,
      body: JSON.stringify(patch),
    })
    await openRoom(roomId)
  }

  const startRecordingMock = async (roomId) => {
    await adminApi(`/api/admin/rooms/${roomId}/recordings/mock/start`, {
      method: 'POST',
      csrfToken,
    })
    await openRoom(roomId)
  }

  const finalizeRecordingMock = async (roomId, recordingId) => {
    await adminApi(`/api/admin/rooms/${roomId}/recordings/${recordingId}/mock-finalize`, {
      method: 'POST',
      csrfToken,
      body: JSON.stringify({ durationMs: 120000 }),
    })
    await openRoom(roomId)
  }

  const failRecordingMock = async (roomId, recordingId) => {
    await adminApi(`/api/admin/rooms/${roomId}/recordings/${recordingId}/mock-fail`, {
      method: 'POST',
      csrfToken,
      body: JSON.stringify({ reason: 'local mock failure' }),
    })
    await openRoom(roomId)
  }

  const deleteRecordingMock = async (roomId, recordingId) => {
    await adminApi(`/api/admin/rooms/${roomId}/recordings/${recordingId}/delete`, {
      method: 'POST',
      csrfToken,
    })
    await openRoom(roomId)
  }

  const updateEmbedSettings = async (roomId, patch) => {
    await adminApi(`/api/admin/rooms/${roomId}/embed`, {
      method: 'PUT',
      csrfToken,
      body: JSON.stringify(patch),
    })
    await openRoom(roomId)
  }

  const issueEmbedSessionForRoom = async (roomId, allowedOrigin) => {
    const issued = await adminApi(`/api/admin/rooms/${roomId}/embed/sessions`, {
      method: 'POST',
      csrfToken,
      body: JSON.stringify({ allowedOrigin, scope: ['embed:status', 'embed:join'] }),
    })
    await openRoom(roomId)
    setRoomEmbed((current) => ({ ...(current || {}), issued }))
  }

  const revokeEmbedSessionForRoom = async (roomId, sessionId) => {
    await adminApi(`/api/admin/rooms/${roomId}/embed/sessions/${sessionId}/revoke`, {
      method: 'POST',
      csrfToken,
    })
    await openRoom(roomId)
  }

  const logout = async () => {
    await adminApi('/api/admin/logout', { method: 'POST', csrfToken })
    setUser(null)
    setCsrfToken('')
    setRooms([])
    setSelectedRoom(null)
    setIntegrations(null)
    setRoomChat(null)
    setRoomTranscripts(null)
    setRoomRecordings(null)
    setRoomEmbed(null)
    await loadBootstrap()
  }

  return (
    <div className="app-shell admin-shell">
      <header className="topbar">
        <a className="brand" href="/admin"><span>WR</span><strong>WebRTC Admin</strong></a>
        <div className="admin-top-actions">
          <a className="admin-link" href="/">Public rooms</a>
          {user ? <button type="button" className="link-button" onClick={logout}>Log out</button> : null}
        </div>
      </header>
      <main className="product-shell admin-main">
        <section className="admin-hero">
          <p className="eyebrow">Operator plane</p>
          <h1>Room operations with separate admin auth.</h1>
          <p>Admin sessions are cookie-backed, CSRF-protected, role-gated, and isolated from participant room tokens.</p>
        </section>
        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        {!user ? (
          <AdminLogin bootstrap={bootstrap} onAuthed={refreshAfterAuth} onError={setError} />
        ) : user.setupRequired ? (
          <AdminSetup csrfToken={csrfToken} onSetup={refreshAfterAuth} onError={setError} />
        ) : (
          <AdminDashboard
            user={user}
            rooms={rooms}
            selectedRoom={selectedRoom}
            audit={audit}
            roomChat={roomChat}
            roomTranscripts={roomTranscripts}
            roomRecordings={roomRecordings}
            roomEmbed={roomEmbed}
            integrations={integrations}
            filters={roomFilters}
            onFilters={setRoomFilters}
            onLoadRooms={loadRooms}
            onOpenRoom={openRoom}
            onEndRoom={endRoom}
            onCreateRoom={createAdminRoom}
            onLifecycle={lifecycleCommand}
            onUpdatePolicy={updatePolicy}
            onUpdateChatRetention={updateChatRetention}
            onExportChat={exportChat}
            onRedactChatMessage={redactChatMessage}
            onDeleteChatMessage={deleteChatMessage}
            onUpdateTranscriptSettings={updateTranscriptSettings}
            onStartTranscriptMock={startTranscriptMock}
            onAppendTranscriptMock={appendTranscriptMock}
            onFinalizeTranscriptMock={finalizeTranscriptMock}
            onExportTranscript={exportTranscript}
            onRedactTranscriptSegment={redactTranscriptSegment}
            onDeleteTranscriptSegment={deleteTranscriptSegment}
            onUpdateRecordingSettings={updateRecordingSettings}
            onStartRecordingMock={startRecordingMock}
            onFinalizeRecordingMock={finalizeRecordingMock}
            onFailRecordingMock={failRecordingMock}
            onDeleteRecordingMock={deleteRecordingMock}
            onUpdateEmbedSettings={updateEmbedSettings}
            onIssueEmbedSession={issueEmbedSessionForRoom}
            onRevokeEmbedSession={revokeEmbedSessionForRoom}
            onLoadIntegrations={loadIntegrations}
          />
        )}
      </main>
    </div>
  )
}

function IntegrationPanel({ integrations, onRefresh }) {
  const clients = integrations?.clients || []
  const systems = integrations?.systems || []
  const roomLinks = integrations?.roomLinks || []
  const webhookAttempts = integrations?.webhookAttempts || []
  return (
    <section className="panel integration-panel">
      <div className="admin-section-heading">
        <div>
          <p className="eyebrow">Integrations</p>
          <h2>Local linkage</h2>
        </div>
        <button type="button" className="small-action" onClick={onRefresh}>Refresh</button>
      </div>
      <div className="integration-stats">
        <span><strong>{clients.length}</strong>Clients</span>
        <span><strong>{systems.length}</strong>Systems</span>
        <span><strong>{roomLinks.length}</strong>Links</span>
        <span><strong>{webhookAttempts.length}</strong>Mock events</span>
      </div>
      <div className="integration-list">
        {clients.map((client) => (
          <article key={client.id}>
            <strong>{client.name}</strong>
            <span>{client.systemKey || 'unlinked'} · {client.status}</span>
            <small>{client.keyPrefix}... · {client.permissionScope.join(', ')}</small>
          </article>
        ))}
        {!clients.length ? <p className="muted">No local integration clients yet.</p> : null}
      </div>
      {webhookAttempts.length ? (
        <div className="integration-list compact">
          {webhookAttempts.slice(0, 3).map((attempt) => (
            <article key={attempt.id}>
              <strong>{attempt.eventType}</strong>
              <span>{attempt.status}</span>
              <small>{attempt.signaturePreview}</small>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function RetainedChatAdminPanel({ room, chat, can, onToggle, onExport, onRedact, onDelete }) {
  const retention = chat?.retention
  const messages = chat?.messages || []
  const enabled = Boolean(retention?.retentionEnabled)
  return (
    <div className="metadata-card retained-chat-card">
      <div className="admin-section-heading compact-heading">
        <div>
          <h3>Retained chat</h3>
          <p className="muted">{retention?.participantNotice || 'Chat retention is off for this room.'}</p>
        </div>
        <span>{messages.length}</span>
      </div>
      <div className="admin-command-panel chat-admin-actions">
        <button type="button" onClick={() => onToggle(!enabled)} disabled={!can('chat:configure_retention') || room.status === 'ended'}>
          {enabled ? 'Disable retention' : 'Enable retention'}
        </button>
        <button type="button" onClick={onExport} disabled={!enabled || !can('chat:export')}>Export JSON</button>
      </div>
      {messages.length ? messages.map((message) => (
        <article className="retained-chat-message" key={message.id}>
          <div>
            <strong>{message.senderRole}</strong>
            <span>{new Date(message.createdAt).toLocaleString()}</span>
          </div>
          <p>{message.body}</p>
          <div className="chat-message-actions">
            <button type="button" onClick={() => onRedact(message.id)} disabled={message.redacted || message.deleted || !can('chat:redact')}>Redact</button>
            <button type="button" onClick={() => onDelete(message.id)} disabled={message.deleted || !can('chat:delete')}>Delete</button>
          </div>
        </article>
      )) : <p className="muted">{enabled ? 'No retained messages yet.' : 'Retention is disabled; no chat bodies are retained.'}</p>}
    </div>
  )
}

function TranscriptAdminPanel({ room, transcripts, can, onToggle, onStart, onAppend, onFinalize, onExport, onRedact, onDeleteSegment }) {
  const [mockText, setMockText] = useState('Local mock caption segment')
  const settings = transcripts?.settings
  const artifacts = transcripts?.artifacts || []
  const enabled = Boolean(settings?.transcriptEnabled)
  const activeArtifact = artifacts.find((artifact) => artifact.status === 'active') || artifacts[0]
  const exportedSegments = transcripts?.selectedExport?.segments || []
  return (
    <div className="metadata-card retained-chat-card">
      <div className="admin-section-heading compact-heading">
        <div>
          <h3>Local mock transcripts</h3>
          <p className="muted">{settings?.participantNotice || 'Local mock transcripts are off for this room.'}</p>
        </div>
        <span>{artifacts.length}</span>
      </div>
      <div className="admin-command-panel chat-admin-actions">
        <button type="button" onClick={() => onToggle(!enabled)} disabled={!can('transcripts:configure') || room.status === 'ended'}>
          {enabled ? 'Disable mock transcripts' : 'Enable mock transcripts'}
        </button>
        <button type="button" onClick={onStart} disabled={!enabled || !can('transcripts:manage_mock')}>Start mock</button>
      </div>
      {activeArtifact ? (
        <div className="transcript-admin-tool">
          <input value={mockText} onChange={(event) => setMockText(event.target.value)} placeholder="Mock caption segment" maxLength="2000" />
          <div className="chat-admin-actions">
            <button type="button" onClick={() => onAppend(activeArtifact.id, mockText)} disabled={!mockText.trim() || activeArtifact.status !== 'active' || !can('transcripts:manage_mock')}>Append</button>
            <button type="button" onClick={() => onFinalize(activeArtifact.id)} disabled={activeArtifact.status !== 'active' || !can('transcripts:manage_mock')}>Finalize</button>
            <button type="button" onClick={() => onExport(activeArtifact.id)} disabled={!can('transcripts:export')}>Export JSON</button>
          </div>
        </div>
      ) : <p className="muted">{enabled ? 'No mock transcript session yet.' : 'Transcript policy is disabled.'}</p>}
      {exportedSegments.length ? (
        <div className="caption-list">
          {exportedSegments.slice(0, 6).map((segment) => (
            <article key={segment.id}>
              <strong>{segment.speakerLabel || 'Mock speaker'}</strong>
              <p>{segment.text}</p>
              <div className="chat-message-actions">
                <button type="button" onClick={() => onRedact(activeArtifact.id, segment.id)} disabled={segment.redacted || segment.deleted || !can('transcripts:redact')}>Redact</button>
                <button type="button" onClick={() => onDeleteSegment(activeArtifact.id, segment.id)} disabled={segment.deleted || !can('transcripts:delete')}>Delete</button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function RecordingAdminPanel({ room, recordings, can, onToggle, onStart, onFinalize, onFail, onDelete }) {
  const settings = recordings?.settings
  const artifacts = recordings?.artifacts || []
  const enabled = Boolean(settings?.recordingEnabled)
  const activeArtifact = artifacts.find((artifact) => artifact.status === 'mock_active') || artifacts[0]
  return (
    <div className="metadata-card retained-chat-card">
      <div className="admin-section-heading compact-heading">
        <div>
          <h3>Local mock recording metadata</h3>
          <p className="muted">{settings?.participantNotice || 'Recording metadata is off for this room. No audio or video is captured or stored.'}</p>
        </div>
        <span>{artifacts.length}</span>
      </div>
      <p className="chat-retention-note">Metadata only. No recording bytes, playback, download, storage key, or media file is captured or stored.</p>
      <div className="admin-command-panel chat-admin-actions">
        <button type="button" onClick={() => onToggle(!enabled)} disabled={!can('recordings:configure') || room.status === 'ended'}>
          {enabled ? 'Disable metadata' : 'Enable metadata'}
        </button>
        <button type="button" onClick={onStart} disabled={!enabled || !can('recordings:manage_mock')}>Start mock metadata</button>
      </div>
      {activeArtifact ? (
        <div className="caption-list">
          {artifacts.slice(0, 6).map((artifact) => (
            <article key={artifact.id}>
              <strong>{artifact.status}</strong>
              <p>{artifact.source} · {artifact.storageProvider} · {artifact.byteSize} bytes</p>
              <span>{artifact.startedAt ? new Date(artifact.startedAt).toLocaleString() : 'Not started'}</span>
              {artifact.failureReason ? <span>{artifact.failureReason}</span> : null}
              <div className="chat-message-actions">
                <button type="button" onClick={() => onFinalize(artifact.id)} disabled={artifact.status !== 'mock_active' || !can('recordings:manage_mock')}>Finalize</button>
                <button type="button" onClick={() => onFail(artifact.id)} disabled={artifact.status !== 'mock_active' || !can('recordings:manage_mock')}>Fail</button>
                <button type="button" onClick={() => onDelete(artifact.id)} disabled={!can('recordings:delete')}>Delete</button>
              </div>
            </article>
          ))}
        </div>
      ) : <p className="muted">{enabled ? 'No local mock recording metadata yet.' : 'Recording metadata policy is disabled.'}</p>}
    </div>
  )
}

function EmbedAdminPanel({ room, embed, can, onConfigure, onIssue, onRevoke }) {
  const settings = embed?.settings
  const sessions = embed?.sessions || []
  const enabled = Boolean(settings?.embedEnabled)
  const [originDraft, setOriginDraft] = useState(settings?.allowedOrigins?.[0] || window.location.origin)
  const issued = embed?.issued
  useEffect(() => {
    if (settings?.allowedOrigins?.[0]) setOriginDraft(settings.allowedOrigins[0])
  }, [settings?.allowedOrigins])
  return (
    <div className="metadata-card retained-chat-card">
      <div className="admin-section-heading compact-heading">
        <div>
          <h3>Local embed</h3>
          <p className="muted">Local iframe sessions only. Exact origins, short-lived tokens, no admin or integration credentials.</p>
        </div>
        <span>{sessions.length}</span>
      </div>
      <div className="transcript-admin-tool">
        <input value={originDraft} onChange={(event) => setOriginDraft(event.target.value)} placeholder="http://127.0.0.1:5173" />
        <div className="chat-admin-actions">
          <button type="button" onClick={() => onConfigure({ embedEnabled: !enabled, allowedOrigins: [originDraft] })} disabled={!can('embed:configure') || room.status === 'ended'}>
            {enabled ? 'Disable embed' : 'Enable local embed'}
          </button>
          <button type="button" onClick={() => onIssue(originDraft)} disabled={!enabled || !can('embed:issue_token')}>Issue one-time token</button>
        </div>
      </div>
      {issued?.bootstrapToken ? (
        <p className="chat-retention-note">One-time bootstrap token: {issued.bootstrapToken}</p>
      ) : null}
      {settings?.allowedOrigins?.length ? (
        <div className="integration-list compact">
          {settings.allowedOrigins.map((origin) => <article key={origin}><strong>{origin}</strong><span>allowed origin</span></article>)}
        </div>
      ) : <p className="muted">No local embed origins configured.</p>}
      {sessions.length ? (
        <div className="integration-list compact">
          {sessions.slice(0, 6).map((session) => (
            <article key={session.id}>
              <strong>{session.allowedOrigin}</strong>
              <span>{session.revokedAt ? 'revoked' : session.exchangedAt ? 'exchanged' : 'issued'} · expires {new Date(session.expiresAt).toLocaleTimeString()}</span>
              <small>{session.scope.join(', ')}</small>
              <button type="button" onClick={() => onRevoke(session.id)} disabled={Boolean(session.revokedAt) || !can('embed:revoke')}>Revoke</button>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function AdminLogin({ bootstrap, onAuthed, onError }) {
  const [email, setEmail] = useState(bootstrap?.bootstrapEmail || '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const isBootstrap = bootstrap?.bootstrapRequired

  useEffect(() => {
    if (bootstrap?.bootstrapEmail) setEmail(bootstrap.bootstrapEmail)
  }, [bootstrap])

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    onError('')
    try {
      const endpoint = isBootstrap ? '/api/admin/bootstrap/login' : '/api/admin/login'
      const body = await adminApi(endpoint, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      await onAuthed(body)
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="stage-grid admin-auth-grid">
      <form className="panel form-panel" onSubmit={submit}>
        <p className="eyebrow">{isBootstrap ? 'Bootstrap admin' : 'Admin login'}</p>
        <h2>{isBootstrap ? 'Start with the setup credential' : 'Sign in to admin'}</h2>
        {bootstrap && !bootstrap.bootstrapAvailable ? <p className="form-error">{bootstrap.reason}</p> : null}
        <label>
          <span>Admin email</span>
          <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required />
        </label>
        <label>
          <span>Password</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
        </label>
        <button className="primary" type="submit" disabled={busy || bootstrap?.bootstrapAvailable === false}>
          {busy ? 'Checking...' : 'Continue'}
        </button>
      </form>
      <aside className="panel share-panel">
        <p className="eyebrow">First slice boundary</p>
        <h2>Bootstrap-only access</h2>
        <p>The known local default is accepted only for local bootstrap. Public production activation requires environment-provided bootstrap credentials and then forced password rotation.</p>
      </aside>
    </section>
  )
}

function AdminSetup({ csrfToken, onSetup, onError }) {
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    onError('')
    try {
      const body = await adminApi('/api/admin/setup/password', {
        method: 'POST',
        csrfToken,
        body: JSON.stringify({ newPassword }),
      })
      await onSetup(body)
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel form-panel admin-setup-card" onSubmit={submit}>
      <p className="eyebrow">Required setup</p>
      <h2>Rotate the bootstrap password</h2>
      <p className="muted">Normal admin room visibility stays locked until this bootstrap credential is consumed.</p>
      <label>
        <span>New admin password</span>
        <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength="12" autoComplete="new-password" required />
      </label>
      <button className="primary" type="submit" disabled={busy}>{busy ? 'Saving...' : 'Finish setup'}</button>
    </form>
  )
}

function AdminDashboard({
  user,
  rooms,
  selectedRoom,
  audit,
  roomChat,
  roomTranscripts,
  roomRecordings,
  roomEmbed,
  integrations,
  filters,
  onFilters,
  onLoadRooms,
  onOpenRoom,
  onEndRoom,
  onCreateRoom,
  onLifecycle,
  onUpdatePolicy,
  onUpdateChatRetention,
  onExportChat,
  onRedactChatMessage,
  onDeleteChatMessage,
  onUpdateTranscriptSettings,
  onStartTranscriptMock,
  onAppendTranscriptMock,
  onFinalizeTranscriptMock,
  onExportTranscript,
  onRedactTranscriptSegment,
  onDeleteTranscriptSegment,
  onUpdateRecordingSettings,
  onStartRecordingMock,
  onFinalizeRecordingMock,
  onFailRecordingMock,
  onDeleteRecordingMock,
  onUpdateEmbedSettings,
  onIssueEmbedSession,
  onRevokeEmbedSession,
  onLoadIntegrations,
}) {
  const [newRoom, setNewRoom] = useState({ displayName: '', password: '', project: '', ticket: '' })
  const [extendHours, setExtendHours] = useState('2')
  const [reason, setReason] = useState('admin operation')

  const can = (permission) => user.permissions.includes(permission)
  const submitFilters = (event) => {
    event.preventDefault()
    onLoadRooms(filters)
  }
  const submitCreate = async (event) => {
    event.preventDefault()
    await onCreateRoom({
      displayName: newRoom.displayName,
      password: newRoom.password,
      metadata: { project: newRoom.project, ticket: newRoom.ticket },
    })
    setNewRoom({ displayName: '', password: '', project: '', ticket: '' })
  }
  const extendSelected = () => {
    const hours = Math.max(1, Math.min(168, Number(extendHours) || 2))
    onLifecycle(selectedRoom.id, 'extend', {
      reason,
      expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
    })
  }

  return (
    <section className="admin-grid">
      <aside className="panel admin-profile">
        <p className="eyebrow">Signed in</p>
        <h2>{user.displayName}</h2>
        <p>{user.email}</p>
        <div className="permission-stack">
          {user.roles.map((role) => <span key={role.key}>{role.name}</span>)}
        </div>
        {can('rooms:create') ? (
          <form className="admin-create-room" onSubmit={submitCreate}>
            <p className="eyebrow">Create room</p>
            <input value={newRoom.displayName} onChange={(event) => setNewRoom({ ...newRoom, displayName: event.target.value })} placeholder="Room name" required />
            <input type="password" value={newRoom.password} onChange={(event) => setNewRoom({ ...newRoom, password: event.target.value })} placeholder="Room password" minLength="4" required />
            <input value={newRoom.project} onChange={(event) => setNewRoom({ ...newRoom, project: event.target.value })} placeholder="Project metadata" />
            <input value={newRoom.ticket} onChange={(event) => setNewRoom({ ...newRoom, ticket: event.target.value })} placeholder="Ticket metadata" />
            <button className="primary compact-primary" type="submit">Create</button>
          </form>
        ) : null}
      </aside>
      <section className="panel admin-room-list">
        <div className="admin-section-heading">
          <div>
            <p className="eyebrow">Rooms</p>
            <h2>All rooms</h2>
          </div>
          <span>{rooms.length}</span>
        </div>
        <form className="admin-filters" onSubmit={submitFilters}>
          <input value={filters.q} onChange={(event) => onFilters({ ...filters, q: event.target.value })} placeholder="Search rooms or metadata" />
          <select value={filters.status} onChange={(event) => onFilters({ ...filters, status: event.target.value })}>
            <option value="">All status</option>
            <option value="active">Active</option>
            <option value="locked">Locked</option>
            <option value="ended">Ended</option>
            <option value="expired">Expired</option>
            <option value="disabled">Disabled</option>
          </select>
          <button type="submit">Filter</button>
        </form>
        <div className="room-table">
          {rooms.map((room) => (
            <button type="button" key={room.id} onClick={() => onOpenRoom(room.id)}>
              <strong>{room.displayName}</strong>
              <span>{room.status}</span>
              <small>{room.metadata.project || room.metadata.ticket || 'No metadata'}</small>
            </button>
          ))}
        </div>
      </section>
      {can('integrations:view') ? (
        <IntegrationPanel integrations={integrations} onRefresh={() => onLoadIntegrations(user)} />
      ) : null}
      <section className="panel admin-room-detail">
        {selectedRoom ? (
          <>
            <div className="admin-section-heading">
              <div>
                <p className="eyebrow">Room detail</p>
                <h2>{selectedRoom.displayName}</h2>
              </div>
              <button type="button" className="danger small-action" onClick={() => onEndRoom(selectedRoom.id)} disabled={selectedRoom.status === 'ended'}>
                End for all
              </button>
            </div>
            <dl className="detail-grid">
              <div><dt>Status</dt><dd>{selectedRoom.status}</dd></div>
              <div><dt>Participants</dt><dd>{selectedRoom.presenceCount}</dd></div>
              <div><dt>Waiting room</dt><dd>{selectedRoom.waitingRoomEnabled ? 'Enabled' : 'Off'}</dd></div>
              <div><dt>Auto-admit first guest</dt><dd>{selectedRoom.autoAdmitFirstGuest ? 'On' : 'Off'}</dd></div>
              <div><dt>Expires</dt><dd>{new Date(selectedRoom.expiresAt).toLocaleString()}</dd></div>
              <div><dt>Retained chat</dt><dd>{roomChat?.retention?.retentionEnabled ? 'Enabled' : 'Off'}</dd></div>
            </dl>
            <div className="admin-command-panel">
              <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Lifecycle reason" />
              <button type="button" onClick={() => onLifecycle(selectedRoom.id, 'lock', { reason })} disabled={!can('rooms:lock') || selectedRoom.status !== 'active'}>Lock</button>
              <button type="button" onClick={() => onLifecycle(selectedRoom.id, 'unlock', { reason })} disabled={!can('rooms:unlock') || selectedRoom.status !== 'locked'}>Unlock</button>
              <button type="button" onClick={() => onLifecycle(selectedRoom.id, 'expire', { reason })} disabled={!can('rooms:expire') || ['ended', 'expired', 'disabled'].includes(selectedRoom.status)}>Expire</button>
              <button type="button" onClick={() => onLifecycle(selectedRoom.id, 'disable', { reason })} disabled={!can('rooms:disable') || ['ended', 'expired', 'disabled'].includes(selectedRoom.status)}>Disable</button>
              <input value={extendHours} onChange={(event) => setExtendHours(event.target.value)} inputMode="numeric" aria-label="Extend hours" />
              <button type="button" onClick={extendSelected} disabled={!can('rooms:extend') || ['ended', 'expired', 'disabled'].includes(selectedRoom.status)}>Extend hours</button>
            </div>
            <div className="admin-command-panel">
              <button type="button" onClick={() => onUpdatePolicy(selectedRoom.id, { waitingRoomEnabled: !selectedRoom.waitingRoomEnabled })} disabled={!can('rooms:update_policy')}>
                {selectedRoom.waitingRoomEnabled ? 'Disable waiting room' : 'Enable waiting room'}
              </button>
              <button type="button" onClick={() => onUpdatePolicy(selectedRoom.id, { autoAdmitFirstGuest: !selectedRoom.autoAdmitFirstGuest })} disabled={!can('rooms:update_policy')}>
                {selectedRoom.autoAdmitFirstGuest ? 'Disable auto-admit' : 'Enable auto-admit'}
              </button>
            </div>
            <div className="lifecycle-list">
              <h3>Lifecycle history</h3>
              {selectedRoom.lifecycle?.length ? selectedRoom.lifecycle.map((event) => (
                <article key={event.id}>
                  <strong>{event.fromStatus || 'new'} {'->'} {event.toStatus}</strong>
                  <span>{event.reason || 'No reason'} · {new Date(event.createdAt).toLocaleString()}</span>
                </article>
              )) : <p className="muted">No lifecycle events yet.</p>}
            </div>
            <div className="metadata-card">
              <h3>Custom metadata</h3>
              {Object.keys(selectedRoom.metadata || {}).length ? (
                Object.entries(selectedRoom.metadata).map(([key, value]) => (
                  <span key={key}><strong>{key}</strong>{Array.isArray(value) ? value.join(', ') : value}</span>
                ))
              ) : <p className="muted">No metadata attached.</p>}
            </div>
            {selectedRoom.externalLinks ? (
              <div className="metadata-card">
                <h3>External links</h3>
                {selectedRoom.externalLinks.length ? selectedRoom.externalLinks.map((link) => (
                  <span key={link.id}><strong>{link.systemKey}</strong>{link.objectType}:{link.objectId}</span>
                )) : <p className="muted">No external links attached.</p>}
              </div>
            ) : null}
            {can('chat:view') ? (
              <RetainedChatAdminPanel
                room={selectedRoom}
                chat={roomChat}
                can={can}
                onToggle={(retentionEnabled) => onUpdateChatRetention(selectedRoom.id, { retentionEnabled })}
                onExport={() => onExportChat(selectedRoom.id)}
                onRedact={(messageId) => onRedactChatMessage(selectedRoom.id, messageId)}
                onDelete={(messageId) => onDeleteChatMessage(selectedRoom.id, messageId)}
              />
            ) : null}
            {can('transcripts:view') || can('transcripts:configure') ? (
              <TranscriptAdminPanel
                room={selectedRoom}
                transcripts={roomTranscripts}
                can={can}
                onToggle={(enabled) => onUpdateTranscriptSettings(selectedRoom.id, {
                  transcriptEnabled: enabled,
                  liveCaptionsEnabled: enabled,
                  mockProviderEnabled: enabled,
                })}
                onStart={() => onStartTranscriptMock(selectedRoom.id)}
                onAppend={(artifactId, text) => onAppendTranscriptMock(selectedRoom.id, artifactId, text)}
                onFinalize={(artifactId) => onFinalizeTranscriptMock(selectedRoom.id, artifactId)}
                onExport={(artifactId) => onExportTranscript(selectedRoom.id, artifactId)}
                onRedact={(artifactId, segmentId) => onRedactTranscriptSegment(selectedRoom.id, artifactId, segmentId)}
                onDeleteSegment={(artifactId, segmentId) => onDeleteTranscriptSegment(selectedRoom.id, artifactId, segmentId)}
              />
            ) : null}
            {can('recordings:view') || can('recordings:configure') ? (
              <RecordingAdminPanel
                room={selectedRoom}
                recordings={roomRecordings}
                can={can}
                onToggle={(enabled) => onUpdateRecordingSettings(selectedRoom.id, {
                  recordingEnabled: enabled,
                  mockRecordingEnabled: enabled,
                })}
                onStart={() => onStartRecordingMock(selectedRoom.id)}
                onFinalize={(recordingId) => onFinalizeRecordingMock(selectedRoom.id, recordingId)}
                onFail={(recordingId) => onFailRecordingMock(selectedRoom.id, recordingId)}
                onDelete={(recordingId) => onDeleteRecordingMock(selectedRoom.id, recordingId)}
              />
            ) : null}
            {can('embed:view') ? (
              <EmbedAdminPanel
                room={selectedRoom}
                embed={roomEmbed}
                can={can}
                onConfigure={(patch) => onUpdateEmbedSettings(selectedRoom.id, patch)}
                onIssue={(allowedOrigin) => onIssueEmbedSession(selectedRoom.id, allowedOrigin)}
                onRevoke={(sessionId) => onRevokeEmbedSession(selectedRoom.id, sessionId)}
              />
            ) : null}
            <div className="audit-list">
              <h3>Recent audit</h3>
              {audit.map((event) => (
                <article key={`${event.action}-${event.createdAt}`}>
                  <strong>{event.action}</strong>
                  <span>{new Date(event.createdAt).toLocaleString()}</span>
                </article>
              ))}
            </div>
          </>
        ) : (
          <p className="muted">Select a room to inspect metadata, participants, controls, and audit events.</p>
        )}
      </section>
    </section>
  )
}

function ChatPanel({ messages, draft, onDraft, onSubmit, retention, disabled }) {
  return (
    <section className="chat-panel panel" aria-label="In-room chat">
      <div className="chat-header">
        <div>
          <p className="eyebrow">Room chat</p>
          <strong>Messages</strong>
        </div>
        <span>{messages.length}</span>
      </div>
      {retention ? (
        <p className="chat-retention-note">
          {retention.retentionEnabled ? retention.participantNotice : 'Retention off: messages are only shown during this live room.'}
        </p>
      ) : null}
      <div className="chat-log" role="log" aria-live="polite">
        {messages.length ? messages.map((message) => (
          <article className={`chat-message${message.self ? ' self' : ''}`} key={message.id}>
            <span>{message.author}</span>
            <p>{message.text}</p>
          </article>
        )) : (
          <p className="chat-empty">Chat appears here after someone sends a message during the room.</p>
        )}
      </div>
      <form className="chat-form" onSubmit={onSubmit}>
        <input
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          placeholder="Message the room"
          maxLength="2000"
          aria-label="Message the room"
        />
        <button type="submit" disabled={disabled || !draft.trim()}>Send</button>
      </form>
    </section>
  )
}

function TranscriptNoticePanel({ status, segments, onConsent }) {
  const settings = status?.settings
  const consent = status?.consent?.status
  if (!settings?.transcriptEnabled && !settings?.liveCaptionsEnabled) return null
  return (
    <section className="transcript-panel panel" aria-label="Local mock captions">
      <div className="chat-header">
        <div>
          <p className="eyebrow">Mock captions</p>
          <strong>Local transcript</strong>
        </div>
        <span>{segments.length}</span>
      </div>
      <p className="chat-retention-note">{settings.participantNotice}</p>
      {consent !== 'acknowledged' ? (
        <div className="transcript-consent-actions">
          <button type="button" onClick={() => onConsent('acknowledged')}>Acknowledge</button>
          <button type="button" onClick={() => onConsent('declined')}>Decline</button>
        </div>
      ) : (
        <div className="caption-list">
          {segments.length ? segments.map((segment) => (
            <article key={segment.id}>
              <strong>{segment.speakerLabel || 'Mock speaker'}</strong>
              <p>{segment.text}</p>
            </article>
          )) : <p className="muted">No local mock captions yet.</p>}
        </div>
      )}
      {consent === 'declined' ? <p className="form-error">Captions stay hidden after declining this notice.</p> : null}
    </section>
  )
}

function RecordingNoticePanel({ status, onConsent }) {
  const settings = status?.settings
  const consent = status?.consent?.status
  if (!settings?.recordingEnabled) return null
  return (
    <section className="transcript-panel panel" aria-label="Local mock recording metadata notice">
      <div className="chat-header">
        <div>
          <p className="eyebrow">Recording metadata</p>
          <strong>Local mock only</strong>
        </div>
        <span>{consent === 'acknowledged' ? 'Ack' : 'Notice'}</span>
      </div>
      <p className="chat-retention-note">{settings.participantNotice}</p>
      <p className="muted">No audio or video is captured or stored by this metadata notice.</p>
      {consent !== 'acknowledged' ? (
        <div className="transcript-consent-actions">
          <button type="button" onClick={() => onConsent('acknowledged')}>Acknowledge</button>
          <button type="button" onClick={() => onConsent('declined')}>Decline</button>
        </div>
      ) : null}
      {consent === 'declined' ? <p className="form-error">The recording metadata notice was declined.</p> : null}
    </section>
  )
}

function WaitingHostPanel({ participants, onDecision }) {
  return (
    <section className="waiting-host-panel panel" aria-label="Waiting room">
      <div className="chat-header">
        <div>
          <p className="eyebrow">Waiting room</p>
          <strong>Admission</strong>
        </div>
        <span>{participants.length}</span>
      </div>
      {participants.length ? participants.map((participant) => (
        <article className="waiting-request" key={participant.participantId}>
          <div>
            <strong>Guest {short(participant.participantId)}</strong>
            <span>{new Date(participant.issuedAt).toLocaleTimeString()}</span>
          </div>
          <div>
            <button type="button" onClick={() => onDecision(participant.participantId, 'admit')}>Admit</button>
            <button type="button" className="danger-text" onClick={() => onDecision(participant.participantId, 'reject')}>Reject</button>
          </div>
        </article>
      )) : (
        <p className="chat-empty">Guests waiting for admission appear here.</p>
      )}
    </section>
  )
}

function VideoTile({ label, refObj, muted, variant = '', empty, emptyTitle, emptyText, cameraOn = true }) {
  return (
    <article className={`video-tile ${variant ? `video-${variant}` : ''}${empty ? ' is-empty' : ''}`}>
      <video ref={refObj} autoPlay playsInline muted={muted} />
      {empty ? (
        <div className="video-placeholder">
          <strong>{emptyTitle}</strong>
          <p>{emptyText}</p>
        </div>
      ) : null}
      {!cameraOn ? <em className="camera-off">Camera off</em> : null}
      <span>{label}</span>
    </article>
  )
}

createRoot(document.getElementById('root')).render(<Root />)
