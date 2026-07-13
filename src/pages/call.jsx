import { useCallback, useEffect, useRef, useState } from 'react'
import { DisconnectReason, Room as LivekitRoom, RoomEvent, Track } from 'livekit-client'
import { api, participantHeaders, short, useClipboard } from '../lib/api.js'
import { Avatar, Badge } from '../ui/kit.jsx'
import {
  IconCam, IconCamOff, IconChat, IconCheck, IconCopy, IconLeave, IconMic, IconMicOff,
  IconRecord, IconScreen, IconUsers,
} from '../ui/icons.jsx'

function connectionCopy(state) {
  if (state === 'connected') return 'Connected'
  if (state === 'connecting') return 'Connecting'
  if (state === 'waiting') return 'Waiting for participants'
  if (state === 'media_unconfigured') return 'Media server offline'
  if (state === 'consent_required') return 'Recording notice pending'
  if (state === 'room_full') return 'Room full'
  if (state === 'room_ended') return 'Room ended'
  if (state === 'left') return 'Left room'
  if (state === 'failed') return 'Connection failed'
  return state || 'Preparing'
}

const STATE_TONES = { connected: 'green', waiting: 'amber', connecting: 'amber' }

// Full-screen dark call experience. Access is already validated and devices
// checked; this component owns the LiveKit session and in-call panels.
export function CallRoom({ room, access }) {
  const [connectionState, setConnectionState] = useState('connecting')
  const [error, setError] = useState('')
  const [micOn, setMicOn] = useState(true)
  const [cameraOn, setCameraOn] = useState(true)
  const [screenShareOn, setScreenShareOn] = useState(false)
  const [remoteParticipants, setRemoteParticipants] = useState([])
  const [participantsVersion, setParticipantsVersion] = useState(0)
  const [panel, setPanel] = useState('') // '' | 'chat' | 'people'
  const [chatMessages, setChatMessages] = useState([])
  const [chatDraft, setChatDraft] = useState('')
  const [unreadChat, setUnreadChat] = useState(0)
  const [transcriptStatus, setTranscriptStatus] = useState(null)
  const [recordingStatus, setRecordingStatus] = useState(null)
  const [endingRoom, setEndingRoom] = useState(false)
  const [waitingParticipants, setWaitingParticipants] = useState([])
  const [elapsed, setElapsed] = useState(0)
  const localVideoRef = useRef(null)
  const livekitRoomRef = useRef(null)
  const panelRef = useRef(panel)
  panelRef.current = panel
  const clipboard = useClipboard()
  const shareUrl = `${window.location.origin}/rooms/${room.id}`

  const credentials = useCallback(() => participantHeaders(access), [access])

  // Elapsed-time clock in the top bar.
  useEffect(() => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [])

  // Host: poll the waiting room.
  const loadWaitingParticipants = useCallback(async () => {
    if (access.role !== 'host') return
    const body = await api(`/api/rooms/${room.id}/waiting`, { headers: credentials() })
    setWaitingParticipants(body.waitingParticipants || [])
  }, [access.role, credentials, room.id])

  useEffect(() => {
    if (access.role !== 'host') return undefined
    let cancelled = false
    const tick = () => loadWaitingParticipants().catch(() => { if (!cancelled) setWaitingParticipants([]) })
    tick()
    const timer = window.setInterval(tick, 2500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [access.role, loadWaitingParticipants])

  // Retained chat history + notice statuses.
  useEffect(() => {
    let cancelled = false
    api(`/api/rooms/${room.id}/chat`, { headers: credentials() })
      .then((body) => {
        if (cancelled) return
        setChatMessages((body.messages || []).map((message) => ({
          id: message.id,
          text: message.body,
          sentAt: message.createdAt,
          author: message.participantId === access.participantId ? 'You' : (message.senderRole === 'host' ? 'Host' : 'Guest'),
          self: message.participantId === access.participantId,
        })))
      })
      .catch(() => {})
    api(`/api/rooms/${room.id}/transcript/status`, { headers: credentials() })
      .then((body) => { if (!cancelled) setTranscriptStatus(body) }).catch(() => {})
    api(`/api/rooms/${room.id}/recording/status`, { headers: credentials() })
      .then((body) => { if (!cancelled) setRecordingStatus(body) }).catch(() => {})
    return () => { cancelled = true }
  }, [access.participantId, credentials, room.id])

  const postConsent = async (kind, status) => {
    try {
      const body = await api(`/api/rooms/${room.id}/${kind}/consent`, {
        method: 'POST',
        headers: credentials(),
        body: JSON.stringify({ status }),
      })
      if (kind === 'recording') setRecordingStatus(body)
      else setTranscriptStatus(body)
    } catch (err) {
      setError(err.message)
    }
  }

  // Recorded rooms are acknowledge-to-enter: the server refuses media
  // credentials until consent lands, so the connect effect re-runs on change.
  const recordingConsentReady = !recordingStatus?.settings?.recordingEnabled
    || recordingStatus?.consent?.status === 'acknowledged'

  useEffect(() => {
    if (!recordingConsentReady) { setConnectionState('consent_required'); return undefined }
    const livekitRoom = new LivekitRoom({ adaptiveStream: true, dynacast: true })
    livekitRoomRef.current = livekitRoom
    let cancelled = false

    const attachLocalVideo = () => {
      const publication = livekitRoom.localParticipant.getTrackPublication(Track.Source.Camera)
      if (publication?.track && localVideoRef.current) publication.track.attach(localVideoRef.current)
    }

    const refreshParticipants = () => {
      if (cancelled) return
      const participants = [...livekitRoom.remoteParticipants.values()]
      setRemoteParticipants(participants)
      setParticipantsVersion((version) => version + 1)
      if (livekitRoom.state === 'connected') {
        setConnectionState(participants.length ? 'connected' : 'waiting')
      }
    }

    livekitRoom
      .on(RoomEvent.ParticipantConnected, refreshParticipants)
      .on(RoomEvent.ParticipantDisconnected, refreshParticipants)
      .on(RoomEvent.TrackSubscribed, refreshParticipants)
      .on(RoomEvent.TrackUnsubscribed, refreshParticipants)
      .on(RoomEvent.TrackMuted, refreshParticipants)
      .on(RoomEvent.TrackUnmuted, refreshParticipants)
      .on(RoomEvent.LocalTrackPublished, attachLocalVideo)
      .on(RoomEvent.Reconnecting, () => setConnectionState('connecting'))
      .on(RoomEvent.Reconnected, refreshParticipants)
      .on(RoomEvent.Disconnected, (reason) => {
        if (cancelled) return
        if (reason === DisconnectReason.ROOM_DELETED) {
          setConnectionState('room_ended')
          setError('This room has ended for everyone.')
        } else {
          setConnectionState('left')
        }
      })
      .on(RoomEvent.DataReceived, (payload, participant) => {
        try {
          const message = JSON.parse(new TextDecoder().decode(payload))
          if (message.type !== 'chat-message') return
          setChatMessages((current) => [...current, {
            id: message.id || `${Date.now()}-${current.length}`,
            text: message.text,
            sentAt: message.sentAt || new Date().toISOString(),
            author: participant?.name || `Guest ${short(participant?.identity)}`,
            self: false,
          }])
          if (panelRef.current !== 'chat') setUnreadChat((count) => count + 1)
        } catch {
          // Ignore malformed data packets.
        }
      })

    const connect = async () => {
      const body = await api(`/api/rooms/${room.id}/livekit-token`, { method: 'POST', headers: credentials() })
      if (cancelled) return
      await livekitRoom.connect(body.livekit.url, body.livekit.token)
      await livekitRoom.localParticipant.enableCameraAndMicrophone()
      attachLocalVideo()
      refreshParticipants()
    }

    connect().catch((err) => {
      if (cancelled) return
      if (err.code === 'recording_consent_required') { setConnectionState('consent_required'); return }
      if (err.code === 'livekit_not_configured') {
        setConnectionState('media_unconfigured')
        setError('No media server is configured. Set WEBRTC_LIVEKIT_URL and restart the API.')
        return
      }
      setError(err.message)
      setConnectionState('failed')
    })

    return () => {
      cancelled = true
      livekitRoomRef.current = null
      livekitRoom.disconnect()
    }
  }, [access, credentials, recordingConsentReady, room.id])

  const toggleMic = async () => {
    const next = !micOn
    await livekitRoomRef.current?.localParticipant.setMicrophoneEnabled(next)
    setMicOn(next)
  }

  const toggleCamera = async () => {
    const next = !cameraOn
    await livekitRoomRef.current?.localParticipant.setCameraEnabled(next)
    setCameraOn(next)
  }

  const toggleScreenShare = async () => {
    const next = !screenShareOn
    try {
      await livekitRoomRef.current?.localParticipant.setScreenShareEnabled(next)
      setScreenShareOn(next)
    } catch {
      // User cancelled the picker; keep prior state.
    }
  }

  const togglePanel = (name) => {
    setPanel((current) => (current === name ? '' : name))
    if (name === 'chat') setUnreadChat(0)
  }

  const leave = () => {
    livekitRoomRef.current?.disconnect()
    window.location.assign('/')
  }

  const endForAll = async () => {
    if (access.role !== 'host') return
    setEndingRoom(true)
    setError('')
    try {
      await api(`/api/rooms/${room.id}/end`, {
        method: 'POST',
        headers: credentials(),
        body: JSON.stringify({ reason: 'host ended room' }),
      })
      livekitRoomRef.current?.disconnect()
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
    const livekitRoom = livekitRoomRef.current
    if (!text || !livekitRoom || livekitRoom.state !== 'connected') return
    const message = { id: `${access.participantId}-${Date.now()}`, type: 'chat-message', text, sentAt: new Date().toISOString() }
    try {
      const retained = await api(`/api/rooms/${room.id}/chat`, {
        method: 'POST',
        headers: credentials(),
        body: JSON.stringify({ body: text }),
      })
      await livekitRoom.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(message)), { reliable: true })
      setChatMessages((current) => [...current, {
        id: retained.message?.id || message.id,
        text,
        sentAt: retained.message?.createdAt || message.sentAt,
        author: 'You',
        self: true,
      }])
      setChatDraft('')
    } catch (err) {
      setError(err.message)
    }
  }

  const decideWaiting = async (participantId, decision) => {
    await api(`/api/rooms/${room.id}/waiting/${participantId}/${decision}`, { method: 'POST', headers: credentials() })
    await loadWaitingParticipants()
  }

  const recordingLive = Boolean(recordingStatus?.settings?.recordingEnabled)
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`

  return (
    <div className="call-page">
      <header className="call-topbar">
        <span className="call-title">{room.displayName}</span>
        <Badge tone={STATE_TONES[connectionState] || 'gray'}>{connectionCopy(connectionState)}</Badge>
        <button type="button" className="btn btn-ghost btn-xs" style={{ color: '#c6cad8' }} onClick={() => clipboard.copy(shareUrl)}>
          {clipboard.copied ? <IconCheck /> : <IconCopy />} Copy invite link
        </button>
        <span className="call-clock">
          {recordingLive ? <><span className="rec-dot" /> REC</> : null}
          {clock}
        </span>
      </header>

      <div className="call-body">
        <section className="stage" aria-label="Participants">
          {connectionState === 'consent_required' ? (
            <div className="stage-notice">
              <strong>This interview is recorded</strong>
              <p>{recordingStatus?.settings?.participantNotice || 'Recording is enabled for this room.'}</p>
              <div className="inline-actions">
                <button type="button" className="btn btn-primary" onClick={() => postConsent('recording', 'acknowledged')}>Acknowledge and join</button>
                <button type="button" className="btn btn-ghost" style={{ color: '#c6cad8' }} onClick={() => postConsent('recording', 'declined')}>Decline</button>
              </div>
              {recordingStatus?.consent?.status === 'declined' ? <p>You declined the notice, so the room stays closed for you.</p> : null}
            </div>
          ) : remoteParticipants.length ? (
            remoteParticipants.map((participant) => (
              <RemoteTile key={participant.identity} participant={participant} version={participantsVersion} />
            ))
          ) : (
            <div className="stage-notice">
              <strong>{connectionCopy(connectionState)}</strong>
              <p>
                {connectionState === 'waiting'
                  ? 'You are in the room. Others appear here as they join.'
                  : ['room_ended', 'left', 'failed', 'media_unconfigured'].includes(connectionState)
                    ? error || 'The call is not active.'
                    : 'Setting up your media connection…'}
              </p>
            </div>
          )}
        </section>

        {panel === 'chat' ? (
          <aside className="call-panel" aria-label="Chat">
            <div className="call-panel-head">Chat</div>
            <div className="call-panel-body">
              {chatMessages.length ? chatMessages.map((message) => (
                <div key={message.id} className={`chat-line${message.self ? ' self' : ''}`}>
                  <span className="chat-meta">{message.author} · {new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="chat-bubble">{message.text}</span>
                </div>
              )) : <p className="panel-note">No messages yet.</p>}
            </div>
            <div className="call-panel-foot">
              <form className="chat-form" onSubmit={sendChat}>
                <input value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} placeholder="Send a message" aria-label="Chat message" />
                <button className="btn btn-primary" type="submit">Send</button>
              </form>
            </div>
          </aside>
        ) : null}

        {panel === 'people' ? (
          <aside className="call-panel" aria-label="Participants">
            <div className="call-panel-head">Participants ({remoteParticipants.length + 1})</div>
            <div className="call-panel-body">
              <div className="panel-card"><strong>You</strong>{access.role === 'host' ? <span className="panel-note">Host</span> : null}</div>
              {remoteParticipants.map((participant) => (
                <div key={participant.identity} className="panel-card"><strong>{participant.name || `Guest ${short(participant.identity)}`}</strong></div>
              ))}
              {access.role === 'host' && waitingParticipants.length ? (
                <>
                  <p className="panel-note">Waiting to be admitted</p>
                  {waitingParticipants.map((participant) => (
                    <div key={participant.participantId} className="panel-card">
                      <strong>Guest {short(participant.participantId)}</strong>
                      <div className="consent-actions">
                        <button type="button" className="btn btn-primary btn-xs" onClick={() => decideWaiting(participant.participantId, 'admit')}>Admit</button>
                        <button type="button" className="btn btn-danger-soft btn-xs" onClick={() => decideWaiting(participant.participantId, 'reject')}>Reject</button>
                      </div>
                    </div>
                  ))}
                </>
              ) : null}
              {transcriptStatus?.settings?.transcriptEnabled && transcriptStatus?.consent?.status !== 'acknowledged' ? (
                <div className="panel-card">
                  <strong>Transcript notice</strong>
                  <span className="panel-note">{transcriptStatus.settings.participantNotice}</span>
                  <div className="consent-actions">
                    <button type="button" className="btn btn-primary btn-xs" onClick={() => postConsent('transcript', 'acknowledged')}>Acknowledge</button>
                    <button type="button" className="btn btn-xs" onClick={() => postConsent('transcript', 'declined')}>Decline</button>
                  </div>
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>

      {error && !['room_ended', 'left', 'failed', 'media_unconfigured'].includes(connectionState) ? (
        <div className="error-banner" style={{ margin: '0 18px' }} role="alert">{error}</div>
      ) : null}

      <footer className="control-bar">
        <button type="button" className={`ctl${micOn ? '' : ' ctl-off'}`} onClick={toggleMic}>
          {micOn ? <IconMic /> : <IconMicOff />}{micOn ? 'Mute' : 'Unmute'}
        </button>
        <button type="button" className={`ctl${cameraOn ? '' : ' ctl-off'}`} onClick={toggleCamera}>
          {cameraOn ? <IconCam /> : <IconCamOff />}{cameraOn ? 'Stop video' : 'Start video'}
        </button>
        <button type="button" className={`ctl${screenShareOn ? ' ctl-active' : ''}`} onClick={toggleScreenShare}>
          <IconScreen />{screenShareOn ? 'Stop share' : 'Share'}
        </button>
        <button type="button" className={`ctl${panel === 'chat' ? ' ctl-active' : ''}`} onClick={() => togglePanel('chat')}>
          <IconChat />{unreadChat ? `Chat (${unreadChat})` : 'Chat'}
        </button>
        <button type="button" className={`ctl${panel === 'people' ? ' ctl-active' : ''}`} onClick={() => togglePanel('people')}>
          <IconUsers />People{waitingParticipants.length ? ` (${waitingParticipants.length})` : ''}
        </button>
        {access.role === 'host' ? (
          <button type="button" className="ctl ctl-danger" onClick={endForAll} disabled={endingRoom}>
            <IconRecord />{endingRoom ? 'Ending…' : 'End for all'}
          </button>
        ) : null}
        <button type="button" className="ctl ctl-danger" onClick={leave}><IconLeave />Leave</button>
      </footer>

      <div className="tile tile-self">
        <video ref={localVideoRef} autoPlay playsInline muted />
        {!cameraOn ? <div className="tile-empty"><Avatar name="You" size={40} /></div> : null}
        <span className="tile-name">You</span>
      </div>
    </div>
  )
}

// One remote participant: screen share wins the tile when present; audio is
// attached invisibly (subscribed tracks are silent until attached).
function RemoteTile({ participant, version }) {
  const videoRef = useRef(null)
  const audioRef = useRef(null)
  const screenSharePublication = participant.getTrackPublication(Track.Source.ScreenShare)
  const cameraPublication = participant.getTrackPublication(Track.Source.Camera)
  const videoPublication = screenSharePublication?.track ? screenSharePublication : cameraPublication
  const audioPublication = participant.getTrackPublication(Track.Source.Microphone)
  const hasVideo = Boolean(videoPublication?.track && !videoPublication.isMuted)
  const name = participant.name || `Guest ${short(participant.identity)}`

  useEffect(() => {
    const videoTrack = videoPublication?.track
    const audioTrack = audioPublication?.track
    if (videoTrack && videoRef.current) videoTrack.attach(videoRef.current)
    if (audioTrack && audioRef.current) audioTrack.attach(audioRef.current)
    return () => {
      videoTrack?.detach()
      audioTrack?.detach()
    }
    // `version` bumps whenever track subscriptions change upstream.
  }, [videoPublication, audioPublication, version])

  return (
    <article className="tile">
      <video ref={videoRef} autoPlay playsInline />
      <audio ref={audioRef} autoPlay />
      {!hasVideo ? <div className="tile-empty"><Avatar name={name} size={56} /></div> : null}
      <span className="tile-name">{name}</span>
    </article>
  )
}
