import { useEffect, useRef } from 'react'
import { createEmbedMessage, postEmbedMessage, validateEmbedMessage } from '../../src/embed-sdk.js'

export function LocalWebRtcEmbedExample({ roomId, sessionId, embedOrigin = 'http://127.0.0.1:4321' }) {
  const frameRef = useRef(null)

  useEffect(() => {
    const onMessage = (event) => {
      const result = validateEmbedMessage(event.data, {
        allowedOrigin: embedOrigin,
        eventOrigin: event.origin,
        expectedSource: frameRef.current?.contentWindow,
        eventSource: event.source,
        roomId,
        sessionId,
        direction: 'frame-to-parent',
      })
      if (!result.ok) return
      console.log('local embed event', result.message.type)
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [embedOrigin, roomId, sessionId])

  const onLoad = (event) => {
    const message = createEmbedMessage({
      type: 'webrtc.embed.init',
      roomId,
      sessionId,
      payload: { theme: 'system' },
    })
    postEmbedMessage(event.currentTarget.contentWindow, message, embedOrigin)
  }

  return (
    <iframe
      ref={frameRef}
      title="Local WebRTC embed"
      src={`${embedOrigin}/embed/rooms/${encodeURIComponent(roomId)}`}
      referrerPolicy="no-referrer"
      allow="camera; microphone"
      onLoad={onLoad}
    />
  )
}
