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

function App() {
  const initialRoomId = roomIdFromPath()
  const [roomId, setRoomId] = useState(initialRoomId)
  const [room, setRoom] = useState(null)
  const [access, setAccess] = useState(null)
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
    setAccess(payload.access)
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
    </header>
  )
}

function CreateRoom({ onCreated }) {
  const [displayName, setDisplayName] = useState('Focus room')
  const [password, setPassword] = useState('')
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
        body: JSON.stringify({ displayName, password }),
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

function CallRoom({ room, access }) {
  const [permissionState, setPermissionState] = useState('idle')
  const [connectionState, setConnectionState] = useState('waiting')
  const [error, setError] = useState('')
  const [micOn, setMicOn] = useState(true)
  const [cameraOn, setCameraOn] = useState(true)
  const [hasRemoteStream, setHasRemoteStream] = useState(false)
  const [chatMessages, setChatMessages] = useState([])
  const [chatDraft, setChatDraft] = useState('')
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

  const sendChat = (event) => {
    event.preventDefault()
    const text = chatDraft.trim()
    if (!text || wsRef.current?.readyState !== WebSocket.OPEN) return
    const message = {
      id: `${access.participantId}-${Date.now()}`,
      type: 'chat-message',
      text,
    }
    wsRef.current.send(JSON.stringify(message))
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
    setChatDraft('')
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
                disabled={wsRef.current?.readyState !== WebSocket.OPEN}
              />
            </aside>
          </div>
          {error ? <div className="error-banner" role="alert">{error}</div> : null}
          <div className="controls panel">
            <button type="button" onClick={toggleMic}>{micOn ? 'Mute mic' : 'Unmute mic'}</button>
            <button type="button" onClick={toggleCamera}>{cameraOn ? 'Turn camera off' : 'Turn camera on'}</button>
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
  if (state === 'failed') return 'Connection failed'
  return state || 'Preparing'
}

function ChatPanel({ messages, draft, onDraft, onSubmit, disabled }) {
  return (
    <section className="chat-panel panel" aria-label="In-room chat">
      <div className="chat-header">
        <div>
          <p className="eyebrow">Room chat</p>
          <strong>Messages</strong>
        </div>
        <span>{messages.length}</span>
      </div>
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
          maxLength="500"
          aria-label="Message the room"
        />
        <button type="submit" disabled={disabled || !draft.trim()}>Send</button>
      </form>
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

createRoot(document.getElementById('root')).render(<App />)
