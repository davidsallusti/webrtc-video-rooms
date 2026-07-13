// OpenAPI 3.1 specification for the whole HTTP surface (TASK-0090).
// Hand-maintained next to the routes it documents; tests/api-docs.test.mjs
// fails when a live Express route and this spec disagree, in either direction.
//
// Conventions:
//   - Auth: integrationBearer (API key), participantAuth (header pair),
//     adminSession (cookie). Mutating admin operations additionally require
//     the x-csrf-token header from the session payload, so they are marked
//     "documentation-only" for the docs UI.
//   - Every operation lists its RBAC permission or integration scope in the
//     description, plus the error codes it can return.

const json = (schema) => ({ 'application/json': { schema } })

const ref = (name) => ({ $ref: `#/components/schemas/${name}` })

// Standard error response reused everywhere; `code` carries the stable
// machine-readable error identifier (e.g. wrong_password, room_not_open).
const errorResponse = (description) => ({ description, content: json(ref('Error')) })

const RESPONSES = {
  400: errorResponse('Validation failed (see `error` code).'),
  401: errorResponse('Missing or invalid credentials.'),
  403: errorResponse('Authenticated but not allowed (permission, scope, consent, join window, or admission).'),
  404: errorResponse('Resource not found.'),
  409: errorResponse('Conflict with current state (room full, artifact not active, retention disabled…).'),
  410: errorResponse('Room ended or expired.'),
  423: errorResponse('Room is locked.'),
  429: errorResponse('Rate limited. Retry after the window resets.'),
  502: errorResponse('Upstream provider failed (STT).'),
  503: errorResponse('Dependent service not configured (media server, egress, STT, portal keys).'),
}

const errs = (...codes) => Object.fromEntries(codes.map((code) => [code, RESPONSES[code]]))

const roomIdParam = { name: 'roomId', in: 'path', required: true, schema: { type: 'string' }, description: 'Room identifier from the invite link.' }
const pathParam = (name, description) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description })

const participantSecurity = [{ participantId: [], participantToken: [] }]
const adminSecurity = [{ adminSession: [] }]
const integrationSecurity = [{ integrationBearer: [] }]

// Marks admin mutations that the docs UI cannot exercise (CSRF header comes
// from the live session payload, not from an Authorize value).
const csrfNote = '\n\n**Docs UI:** documentation-only — this mutation also requires the `x-csrf-token` header issued with the admin session.'

const permNote = (permission) => `\n\n**Requires admin permission:** \`${permission}\`.`

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'InterviewRooms API',
    version: '1.0.0',
    description: [
      'Control-plane API for the interview video rooms service.',
      '',
      'Planes and their authentication:',
      '- **Participant** — room password (or invite email + password) exchanges for a short-lived access token used as the `x-participant-id` / `x-room-access-token` header pair.',
      '- **Portal** — a HirePortal-minted LiveKit JWT is accepted as proof of portal login.',
      '- **Integration** — server-to-server bearer API keys (created on the admin Integrations page), scoped to `rooms:create`, `rooms:read`, `rooms:link`, `webhooks:local_record`.',
      '- **Embed** — short-lived, origin-bound sessions for the iframe surface.',
      '- **Admin** — cookie session with CSRF-protected mutations and per-permission RBAC.',
      '',
      'All errors share one shape: `{ error, message }` where `error` is a stable machine-readable code.',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'Same origin' }],
  tags: [
    { name: 'Participant', description: 'Join flow, media credentials, in-room features (chat, consents, waiting room).' },
    { name: 'Portal', description: 'HirePortal auto-admission using portal-minted LiveKit tokens.' },
    { name: 'Integration', description: 'Server-to-server room provisioning and status (bearer API key).' },
    { name: 'Embed', description: 'Origin-bound iframe sessions.' },
    { name: 'Webhooks', description: 'Inbound LiveKit event ingestion. Not user-callable.' },
    { name: 'Admin — Auth', description: 'Admin session lifecycle (bootstrap, login, setup, logout).' },
    { name: 'Admin — Rooms', description: 'Room CRUD, interview mapping, lifecycle, policy, waiting room.' },
    { name: 'Admin — Chat', description: 'Retained chat moderation.' },
    { name: 'Admin — Transcripts', description: 'Transcript artifacts, segments, and legacy mock controls.' },
    { name: 'Admin — Recordings', description: 'Real (egress) recordings, playback, transcription, and legacy mock controls.' },
    { name: 'Admin — Embed', description: 'Embed origins and session issuance.' },
    { name: 'Admin — Integrations', description: 'Integration API clients.' },
    { name: 'Admin — Audit', description: 'Global audit and artifact overviews.' },
  ],
  components: {
    securitySchemes: {
      integrationBearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'Integration API key (`wrtc_…`), shown once when the client is created on the admin Integrations page.',
      },
      participantId: {
        type: 'apiKey', in: 'header', name: 'x-participant-id',
        description: 'Participant id returned by the access endpoint. Used together with `x-room-access-token`.',
      },
      participantToken: {
        type: 'apiKey', in: 'header', name: 'x-room-access-token',
        description: 'Opaque short-lived (15 min) access token returned by the access endpoint. Revoked on disconnect and room end.',
      },
      adminSession: {
        type: 'apiKey', in: 'cookie', name: 'webrtc_admin_session',
        description: 'HttpOnly admin session cookie set by the login endpoints. Sent automatically when the docs run same-origin in a signed-in browser.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error', 'message'],
        properties: {
          error: { type: 'string', description: 'Stable machine-readable code (e.g. `wrong_password`, `room_not_open`, `recording_consent_required`).' },
          message: { type: 'string' },
        },
      },
      PublicRoom: {
        type: 'object',
        description: 'Room facts visible before joining. `inviteeOnly` signals that the access endpoint also needs an invited `email`.',
        properties: {
          id: { type: 'string' },
          displayName: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
          maxParticipants: { type: 'integer' },
          status: { type: 'string', enum: ['active', 'locked', 'ended', 'expired', 'disabled'] },
          endedAt: { type: ['string', 'null'], format: 'date-time' },
          waitingRoomEnabled: { type: 'boolean' },
          autoAdmitFirstGuest: { type: 'boolean' },
          scheduledStartAt: { type: ['string', 'null'], format: 'date-time' },
          scheduledEndAt: { type: ['string', 'null'], format: 'date-time' },
          joinWindowMinutes: { type: ['integer', 'null'], description: 'Minutes before the scheduled start when guests may join. Null = no window.' },
          inviteeOnly: { type: 'boolean' },
        },
      },
      AdminRoom: {
        type: 'object',
        description: 'Full room projection for admins: public fields plus interview mapping, policy state, presence, invitees, and (permission-dependent) waiting/lifecycle/integration extras.',
        properties: {
          id: { type: 'string' },
          displayName: { type: 'string' },
          status: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
          maxParticipants: { type: 'integer' },
          waitingRoomEnabled: { type: 'boolean' },
          autoAdmitFirstGuest: { type: 'boolean' },
          scheduledStartAt: { type: ['string', 'null'], format: 'date-time' },
          scheduledEndAt: { type: ['string', 'null'], format: 'date-time' },
          joinWindowMinutes: { type: ['integer', 'null'] },
          candidateId: { type: ['string', 'null'], description: 'HirePortal candidate id; drives the LiveKit room name (`hp-<candidateId>`).' },
          recruiterId: { type: ['string', 'null'], description: 'Portal identity that auto-joins as host.' },
          livekitRoomName: { type: ['string', 'null'] },
          presenceCount: { type: 'integer' },
          invitees: { type: 'array', items: ref('Invitee') },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
      Invitee: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          displayName: { type: ['string', 'null'] },
          inviteeRole: { type: 'string', enum: ['candidate', 'recruiter', 'interviewer', 'observer', 'participant'] },
        },
      },
      Schedule: {
        type: 'object',
        description: 'Scheduled slot. When `scheduledEndAt` is set, room expiry becomes slot end + overrun grace instead of the default TTL.',
        properties: {
          scheduledStartAt: { type: ['string', 'null'], format: 'date-time' },
          scheduledEndAt: { type: ['string', 'null'], format: 'date-time' },
          joinWindowMinutes: { type: ['integer', 'null'], minimum: 0, maximum: 1440 },
        },
      },
      AccessGrant: {
        type: 'object',
        description: 'Participant credentials. Present `participantId`/`accessToken` as the participant header pair on subsequent calls.',
        properties: {
          accessToken: { type: 'string' },
          participantId: { type: 'string' },
          role: { type: 'string', enum: ['host', 'guest'] },
          expiresAt: { type: 'string', format: 'date-time' },
          admissionStatus: { type: 'string', enum: ['admitted', 'waiting', 'rejected', 'removed'] },
          email: { type: ['string', 'null'] },
          displayName: { type: ['string', 'null'] },
        },
      },
      LivekitGrant: {
        type: 'object',
        description: 'Media-plane credentials for the LiveKit client SDK.',
        properties: {
          url: { type: 'string', description: 'LiveKit websocket URL.' },
          roomName: { type: 'string' },
          token: { type: 'string', description: 'LiveKit JWT bound to the participant identity.' },
        },
      },
      ChatMessage: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          participantId: { type: ['string', 'null'] },
          senderRole: { type: 'string', enum: ['host', 'guest', 'admin', 'system'] },
          body: { type: 'string', description: 'Empty when redacted.' },
          createdAt: { type: 'string', format: 'date-time' },
          redactedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      ChatRetention: {
        type: 'object',
        properties: {
          retentionEnabled: { type: 'boolean' },
          retentionDays: { type: 'integer' },
          participantNotice: { type: 'string' },
        },
      },
      ConsentStatus: {
        type: 'object',
        description: 'Per-participant notice state. `notice_required` blocks media credentials for recorded rooms.',
        properties: {
          settings: { type: 'object', additionalProperties: true },
          consent: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['acknowledged', 'declined', 'notice_required', 'not_required'] },
              noticeVersion: { type: 'string' },
            },
          },
        },
      },
      TranscriptArtifact: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          roomId: { type: 'string' },
          providerKey: { type: 'string', description: '`openai:<model>`, `stub_local`, or `mock_local`.' },
          source: { type: 'string', enum: ['mock', 'recording_stt'] },
          status: { type: 'string', enum: ['draft', 'active', 'finalized', 'failed', 'deleted'] },
          language: { type: 'string' },
          startedAt: { type: ['string', 'null'], format: 'date-time' },
          finalizedAt: { type: ['string', 'null'], format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      TranscriptSegment: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          startMs: { type: 'integer' },
          endMs: { type: 'integer' },
          text: { type: 'string', description: 'Empty when redacted.' },
          speakerLabel: { type: ['string', 'null'] },
          redactedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      RecordingArtifact: {
        type: 'object',
        description: 'Recording metadata. Storage keys stay server-side; media is streamed via the admin media endpoint.',
        properties: {
          id: { type: 'string' },
          roomId: { type: 'string' },
          source: { type: 'string', enum: ['mock_metadata', 'livekit_egress'] },
          status: { type: 'string', enum: ['mock_active', 'mock_finalized', 'mock_failed', 'active', 'finalized', 'failed', 'deleted'] },
          storageProvider: { type: 'string', enum: ['none', 'local_file', 's3'] },
          byteSize: { type: 'integer' },
          durationMs: { type: ['integer', 'null'] },
          startedAt: { type: ['string', 'null'], format: 'date-time' },
          finalizedAt: { type: ['string', 'null'], format: 'date-time' },
          mediaCaptured: { type: 'boolean', description: 'True when finalized real media exists and can be played back.' },
        },
      },
      EmbedSettings: {
        type: 'object',
        properties: {
          embedEnabled: { type: 'boolean' },
          allowedOrigins: { type: 'array', items: { type: 'string' } },
        },
      },
      EmbedSession: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          allowedOrigin: { type: 'string' },
          scope: { type: 'array', items: { type: 'string', enum: ['embed:status', 'embed:join'] } },
          expiresAt: { type: 'string', format: 'date-time' },
          exchangedAt: { type: ['string', 'null'], format: 'date-time' },
          revokedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      IntegrationClient: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          systemKey: { type: ['string', 'null'] },
          keyPrefix: { type: 'string' },
          status: { type: 'string' },
          allowedOrigins: { type: 'array', items: { type: 'string' } },
          permissionScope: { type: 'array', items: { type: 'string' } },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      AuditEvent: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          actorType: { type: 'string' },
          actorId: { type: ['string', 'null'] },
          resourceType: { type: 'string' },
          resourceId: { type: ['string', 'null'] },
          roomId: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
      WaitingParticipant: {
        type: 'object',
        properties: {
          participantId: { type: 'string' },
          role: { type: 'string' },
          admissionStatus: { type: 'string' },
          issuedAt: { type: 'string', format: 'date-time' },
        },
      },
      AdminUser: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          email: { type: 'string' },
          displayName: { type: 'string' },
          setupRequired: { type: 'boolean' },
          roles: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, name: { type: 'string' } } } },
          permissions: { type: 'array', items: { type: 'string' } },
        },
      },
      OutboxEmail: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          toEmail: { type: 'string' },
          templateKey: { type: 'string', enum: ['room_invitation', 'admin_welcome'] },
          subject: { type: 'string' },
          provider: { type: 'string', enum: ['local', 'ses'] },
          status: { type: 'string', enum: ['local_recorded', 'sent', 'failed'] },
          error: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
          sentAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      EmailStatus: {
        type: 'object',
        description: 'Active email provider. `local` composes and records emails in the outbox without sending; `ses` delivers via AWS SES.',
        properties: {
          provider: { type: 'string', enum: ['local', 'ses'] },
          from: { type: 'string' },
          deliveryEnabled: { type: 'boolean' },
        },
      },
      AdminAuthPayload: {
        type: 'object',
        description: 'Session payload. `csrfToken` must be echoed as `x-csrf-token` on every mutating admin call.',
        properties: {
          user: ref('AdminUser'),
          csrfToken: { type: 'string' },
        },
      },
    },
  },
  paths: {
    // ------------------------------------------------------------------ core
    '/api/health': {
      get: {
        tags: ['Participant'],
        summary: 'Health check',
        description: 'Liveness probe. Reports the media transport mode.',
        responses: {
          200: { description: 'Service is up.', content: json({ type: 'object', properties: { ok: { type: 'boolean' }, mode: { type: 'string' }, transport: { type: 'string' } } }) },
        },
      },
    },
    '/api/rooms': {
      post: {
        tags: ['Participant'],
        summary: 'Create a quick room',
        description: 'Anonymous quick-room creation (the public landing card). Returns the room, the share URL, and **host** credentials. Interview rooms with invitees/schedules are created via the admin or integration APIs. Rate limited per network (default 12 per 5 min).',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['password'],
            properties: {
              displayName: { type: 'string', default: 'Untitled room' },
              password: { type: 'string', minLength: 4 },
              metadata: { type: 'object', description: 'Whitelisted keys: project, ticket, customer, sessionType, priority, tags.' },
            },
          }),
        },
        responses: {
          201: { description: 'Room created.', content: json({ type: 'object', properties: { room: ref('PublicRoom'), shareUrl: { type: 'string' }, access: ref('AccessGrant') } }) },
          ...errs(400, 429),
        },
      },
    },
    '/api/rooms/{roomId}': {
      get: {
        tags: ['Participant'],
        summary: 'Public room info',
        description: 'Pre-join facts: name, status, schedule (for the "opens at" notice), invitee-only flag, and current occupancy. Never returns credentials.',
        parameters: [roomIdParam],
        responses: {
          200: { description: 'Room facts.', content: json({ type: 'object', properties: { room: ref('PublicRoom'), activeParticipants: { type: 'integer' } } }) },
          ...errs(404, 410, 423),
        },
      },
    },
    '/api/rooms/{roomId}/access': {
      post: {
        tags: ['Participant'],
        summary: 'Exchange password for access credentials',
        description: 'Validates the room password (and, for invitee-only rooms, the invited `email` — checked after the password so invitations cannot be enumerated). Enforces the join window for scheduled rooms (`room_not_open`) and occupancy. Returns credentials, possibly in `waiting` state when the waiting room is enabled. Rejoin after leaving repeats this call. Rate limited (8 password attempts/min per room+IP).',
        parameters: [roomIdParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['password'],
            properties: {
              password: { type: 'string' },
              email: { type: 'string', format: 'email', description: 'Required when the room is invitee-only.' },
              displayName: { type: 'string', maxLength: 120 },
            },
          }),
        },
        responses: {
          200: { description: 'Credentials issued.', content: json({ type: 'object', properties: { room: ref('PublicRoom'), access: ref('AccessGrant'), waiting: { type: 'boolean' } } }) },
          ...errs(401, 403, 404, 409, 410, 423, 429),
        },
      },
    },
    '/api/rooms/{roomId}/livekit-token': {
      post: {
        tags: ['Participant'],
        summary: 'Mint media credentials',
        description: 'Issues a LiveKit token after every control-plane gate passes: valid admitted access token, occupancy below the room cap, and — for recording-enabled rooms — an acknowledged recording notice (`recording_consent_required` otherwise). Connect the LiveKit client SDK with the returned `url` + `token`.',
        parameters: [roomIdParam],
        security: participantSecurity,
        responses: {
          200: { description: 'Media credentials.', content: json({ type: 'object', properties: { livekit: ref('LivekitGrant') } }) },
          ...errs(401, 403, 404, 409, 410, 423, 503),
        },
      },
    },
    '/api/portal/access': {
      post: {
        tags: ['Portal'],
        summary: 'Auto-admit with a HirePortal token',
        description: 'Accepts a HirePortal-minted LiveKit JWT (HS256, portal keypair) as proof of portal login. The token\'s room grant (`hp-<candidateId>`) resolves the interview room. Identities matching the room\'s `recruiterId` join as **host** and bypass the join window; everyone else joins as guest. Recorded rooms require `acknowledgeRecording: true` in the body (`recording_consent_required` otherwise). Returns app credentials plus media credentials in one call.',
        security: integrationSecurity,
        requestBody: {
          required: false,
          content: json({
            type: 'object',
            properties: {
              token: { type: 'string', description: 'Portal LiveKit JWT. Alternative to the Authorization bearer header.' },
              acknowledgeRecording: { type: 'boolean', description: 'Explicit recording-notice acknowledgement for recorded rooms.' },
            },
          }),
        },
        responses: {
          200: { description: 'Admitted.', content: json({ type: 'object', properties: { room: ref('PublicRoom'), access: ref('AccessGrant'), livekit: ref('LivekitGrant') } }) },
          ...errs(401, 403, 404, 409, 410, 423, 429, 503),
        },
      },
    },
    '/api/livekit/webhooks': {
      post: {
        tags: ['Webhooks'],
        summary: 'LiveKit event ingestion (inbound only)',
        description: '**Not user-callable.** Receives signed LiveKit webhooks (participant joined/left, room finished, egress ended). The signature is verified against the app\'s LiveKit API key; unsigned requests fail. Drives presence bookkeeping and the recording→transcription pipeline.',
        requestBody: { required: true, content: { 'application/webhook+json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: {
          200: { description: 'Event accepted.', content: json({ type: 'object', properties: { ok: { type: 'boolean' } } }) },
          ...errs(503),
        },
      },
    },

    // --------------------------------------------------------- participant +
    '/api/rooms/{roomId}/access-status': {
      get: {
        tags: ['Participant'],
        summary: 'Poll admission status',
        description: 'Waiting-room polling: returns `role` and `admissionStatus` (`waiting` → `admitted`/`rejected`). Poll every ~2s while waiting.',
        parameters: [roomIdParam],
        security: participantSecurity,
        responses: {
          200: { description: 'Current admission state.', content: json({ type: 'object', properties: { role: { type: 'string' }, admissionStatus: { type: 'string' } } }) },
          ...errs(401, 404, 410, 423),
        },
      },
    },
    '/api/rooms/{roomId}/chat': {
      get: {
        tags: ['Participant'],
        summary: 'Retained chat history',
        description: 'Returns retention settings and, when retention is enabled, prior messages. Realtime fan-out happens over the LiveKit data channel, not this endpoint.',
        parameters: [roomIdParam, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } }],
        security: participantSecurity,
        responses: {
          200: { description: 'History.', content: json({ type: 'object', properties: { retention: ref('ChatRetention'), messages: { type: 'array', items: ref('ChatMessage') } } }) },
          ...errs(401, 404, 410),
        },
      },
      post: {
        tags: ['Participant'],
        summary: 'Send a chat message',
        description: 'Persists the message when retention is on (201) or accepts without retention (202). Capped at 20 messages/min per participant; 2,000 chars.',
        parameters: [roomIdParam],
        security: participantSecurity,
        requestBody: { required: true, content: json({ type: 'object', required: ['body'], properties: { body: { type: 'string', maxLength: 2000 } } }) },
        responses: {
          201: { description: 'Message retained.', content: json({ type: 'object', properties: { retained: { type: 'boolean' }, message: ref('ChatMessage'), retention: ref('ChatRetention') } }) },
          202: { description: 'Accepted (retention off, nothing stored).', content: json({ type: 'object', properties: { retained: { type: 'boolean' } } }) },
          ...errs(401, 404, 410, 429),
        },
      },
    },
    '/api/rooms/{roomId}/transcript/status': {
      get: {
        tags: ['Participant'],
        summary: 'Transcript notice status',
        description: 'Notice text and this participant\'s consent state for transcripts.',
        parameters: [roomIdParam],
        security: participantSecurity,
        responses: { 200: { description: 'Status.', content: json(ref('ConsentStatus')) }, ...errs(401, 404, 410) },
      },
    },
    '/api/rooms/{roomId}/transcript/consent': {
      post: {
        tags: ['Participant'],
        summary: 'Record transcript consent',
        parameters: [roomIdParam],
        security: participantSecurity,
        description: 'Acknowledge or decline the transcript notice for the current notice version.',
        requestBody: { required: true, content: json({ type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['acknowledged', 'declined'] } } }) },
        responses: { 200: { description: 'Updated status.', content: json(ref('ConsentStatus')) }, ...errs(400, 401, 404, 409, 410) },
      },
    },
    '/api/rooms/{roomId}/recording/status': {
      get: {
        tags: ['Participant'],
        summary: 'Recording notice status',
        description: 'Notice text and consent state for recording. Recorded rooms are acknowledge-to-enter: media credentials are refused until `acknowledged`.',
        parameters: [roomIdParam],
        security: participantSecurity,
        responses: { 200: { description: 'Status.', content: json(ref('ConsentStatus')) }, ...errs(401, 404, 410) },
      },
    },
    '/api/rooms/{roomId}/recording/consent': {
      post: {
        tags: ['Participant'],
        summary: 'Record recording consent',
        parameters: [roomIdParam],
        security: participantSecurity,
        description: 'Acknowledge or decline the recording notice. Declining keeps a recorded room closed for this participant.',
        requestBody: { required: true, content: json({ type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['acknowledged', 'declined'] } } }) },
        responses: { 200: { description: 'Updated status.', content: json(ref('ConsentStatus')) }, ...errs(400, 401, 404, 409, 410) },
      },
    },
    '/api/rooms/{roomId}/live-captions': {
      get: {
        tags: ['Participant'],
        summary: 'Poll live captions (legacy mock)',
        description: 'Returns caption segments for the active mock transcript. Requires transcript + live-captions enabled and acknowledged consent. Real transcripts are post-call only.',
        parameters: [roomIdParam, { name: 'afterMs', in: 'query', schema: { type: 'integer' } }],
        security: participantSecurity,
        responses: {
          200: { description: 'Segments.', content: json({ type: 'object', properties: { segments: { type: 'array', items: ref('TranscriptSegment') } } }) },
          ...errs(401, 403, 404, 409, 410),
        },
      },
    },
    '/api/rooms/{roomId}/waiting': {
      get: {
        tags: ['Participant'],
        summary: 'List waiting guests (host)',
        description: 'Host-only view of guests pending admission.',
        parameters: [roomIdParam],
        security: participantSecurity,
        responses: {
          200: { description: 'Pending guests.', content: json({ type: 'object', properties: { waitingParticipants: { type: 'array', items: ref('WaitingParticipant') } } }) },
          ...errs(401, 403, 404, 410),
        },
      },
    },
    '/api/rooms/{roomId}/waiting/{participantId}/{decision}': {
      post: {
        tags: ['Participant'],
        summary: 'Admit or reject a waiting guest (host)',
        description: 'Host decision on a pending guest. `decision` is `admit` or `reject`.',
        parameters: [roomIdParam, pathParam('participantId', 'Waiting guest id.'), pathParam('decision', '`admit` or `reject`.')],
        security: participantSecurity,
        responses: {
          200: { description: 'Decision applied; returns the updated waiting list.', content: json({ type: 'object', properties: { participant: { type: 'object' }, waitingParticipants: { type: 'array', items: ref('WaitingParticipant') } } }) },
          ...errs(400, 401, 403, 404, 410),
        },
      },
    },
    '/api/rooms/{roomId}/end': {
      post: {
        tags: ['Participant'],
        summary: 'End the room for everyone (host)',
        description: 'Host-only. Ends the room, revokes all access tokens, stops any active recording, and tears down the LiveKit room (disconnecting every client).',
        parameters: [roomIdParam],
        security: participantSecurity,
        requestBody: { required: false, content: json({ type: 'object', properties: { reason: { type: 'string', maxLength: 160 } } }) },
        responses: {
          200: { description: 'Room ended.', content: json({ type: 'object', properties: { room: ref('PublicRoom') } }) },
          ...errs(401, 403, 404, 410),
        },
      },
    },

    // ------------------------------------------------------------ integration
    '/api/integrations/session': {
      get: {
        tags: ['Integration'],
        summary: 'Verify integration credentials',
        description: 'Echoes the authenticated client (name, key prefix, scopes, allowed origins). Use to validate a key. Auth attempts are rate limited (20/min).',
        security: integrationSecurity,
        responses: {
          200: { description: 'Authenticated client.', content: json({ type: 'object', properties: { client: ref('IntegrationClient') } }) },
          ...errs(401, 429),
        },
      },
    },
    '/api/integrations/rooms': {
      post: {
        tags: ['Integration'],
        summary: 'Provision an interview room',
        description: 'Server-to-server room creation with the full interview mapping: candidate/recruiter ids, invitee allowlist, scheduled slot with join window, participant cap, plus optional external link + identity records. Returns host credentials and the share URL.\n\n**Requires scope:** `rooms:create` (plus `rooms:link` when `externalLink` is sent).',
        security: integrationSecurity,
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['password'],
            properties: {
              displayName: { type: 'string' },
              password: { type: 'string', minLength: 4 },
              candidateId: { type: 'string', description: 'Drives the LiveKit room name `hp-<candidateId>` (portal-token compatible).' },
              recruiterId: { type: 'string' },
              invitees: { type: 'array', items: ref('Invitee'), maxItems: 16 },
              schedule: ref('Schedule'),
              maxParticipants: { type: 'integer', minimum: 2, maximum: 5 },
              metadata: { type: 'object' },
              externalLink: { type: 'object', properties: { objectType: { type: 'string' }, objectId: { type: 'string' }, metadata: { type: 'object' } } },
              externalIdentity: { type: 'object', properties: { externalUserId: { type: 'string' }, displayName: { type: 'string' }, emailHash: { type: 'string' } } },
            },
          }),
        },
        responses: {
          201: { description: 'Room provisioned.', content: json({ type: 'object', properties: { room: ref('PublicRoom'), shareUrl: { type: 'string' }, access: ref('AccessGrant') } }) },
          ...errs(400, 401, 403, 429),
        },
      },
    },
    '/api/integrations/rooms/{roomId}': {
      get: {
        tags: ['Integration'],
        summary: 'Room status for the portal',
        description: 'Read-only status: room facts, live occupancy, and recording/transcript summaries (no credentials, no storage keys).\n\n**Requires scope:** `rooms:read`.',
        parameters: [roomIdParam],
        security: integrationSecurity,
        responses: {
          200: {
            description: 'Status.',
            content: json({
              type: 'object',
              properties: {
                room: ref('PublicRoom'),
                candidateId: { type: ['string', 'null'] },
                recruiterId: { type: ['string', 'null'] },
                livekitRoomName: { type: ['string', 'null'] },
                activeParticipants: { type: 'integer' },
                recordings: { type: 'array', items: { type: 'object' } },
                transcripts: { type: 'array', items: { type: 'object' } },
              },
            }),
          },
          ...errs(401, 403, 404, 429),
        },
      },
    },

    // ----------------------------------------------------------------- embed
    '/api/embed/sessions/exchange': {
      post: {
        tags: ['Embed'],
        summary: 'Exchange a bootstrap token for a session token',
        description: 'One-time exchange. The bootstrap token is issued by an admin for an exact origin; the returned session token authenticates subsequent embed calls via `x-embed-session-id` + `x-embed-session-token` headers.',
        requestBody: { required: false, content: json({ type: 'object', properties: {} }) },
        responses: {
          200: { description: 'Session token issued.', content: json({ type: 'object', properties: { session: ref('EmbedSession'), sessionToken: { type: 'string' } } }) },
          ...errs(401, 403),
        },
      },
    },
    '/api/embed/rooms/{roomId}/status': {
      get: {
        tags: ['Embed'],
        summary: 'Room status for an embed session',
        description: 'Requires an exchanged embed session with the `embed:status` scope and a matching origin.',
        parameters: [roomIdParam],
        responses: {
          200: { description: 'Room status.', content: json({ type: 'object', properties: { room: ref('PublicRoom'), activeParticipants: { type: 'integer' } } }) },
          ...errs(401, 403, 404, 410, 423),
        },
      },
    },
    '/api/embed/rooms/{roomId}/access': {
      post: {
        tags: ['Embed'],
        summary: 'Join a room from an embed session',
        description: 'Password validation scoped to an embed session (`embed:join` scope). Same gates as the public access endpoint.',
        parameters: [roomIdParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['password'], properties: { password: { type: 'string' } } }) },
        responses: {
          200: { description: 'Credentials issued.', content: json({ type: 'object', properties: { room: ref('PublicRoom'), access: ref('AccessGrant'), waiting: { type: 'boolean' } } }) },
          ...errs(401, 403, 404, 409, 410, 423, 429),
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Admin plane — built programmatically to keep ~50 operations readable.
// ---------------------------------------------------------------------------
function adminOp({ tag, summary, description, permission, csrf = false, params = [], query = [], body = null, responses }) {
  return {
    tags: [tag],
    summary,
    description: `${description}${permission ? permNote(permission) : ''}${csrf ? csrfNote : ''}`,
    ...(params.length || query.length ? { parameters: [...params, ...query] } : {}),
    ...(body ? { requestBody: { required: true, content: json(body) } } : {}),
    security: adminSecurity,
    responses,
  }
}

const q = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', schema, description })
const okJson = (schema, description = 'OK.') => ({ 200: { description, content: json(schema) } })

const adminPaths = {
  // ------------------------------------------------------------- auth/session
  '/api/admin/bootstrap/status': {
    get: adminOp({
      tag: 'Admin — Auth',
      summary: 'Bootstrap status',
      description: 'Whether any admin exists and whether bootstrap login is available. Unauthenticated.',
      responses: okJson({ type: 'object', properties: { hasAdmins: { type: 'boolean' }, bootstrapRequired: { type: 'boolean' }, bootstrapAvailable: { type: 'boolean' }, bootstrapEmail: { type: 'string' }, setupMode: { type: 'string' }, production: { type: 'boolean' }, reason: { type: 'string' } } }),
    }),
  },
  '/api/admin/bootstrap/login': {
    post: adminOp({
      tag: 'Admin — Auth',
      summary: 'First-run bootstrap login',
      description: 'Signs in with the bootstrap credential when no admin exists yet. The session then requires a password rotation before anything else. Rate limited (8/min). Sets the HttpOnly session cookie.',
      body: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } },
      responses: { ...okJson(ref('AdminAuthPayload'), 'Session established (setupRequired=true).'), ...errs(401, 403, 429) },
    }),
  },
  '/api/admin/login': {
    post: adminOp({
      tag: 'Admin — Auth',
      summary: 'Admin login',
      description: 'Email + password login. Sets the HttpOnly session cookie (8h TTL, 45m idle timeout). Rate limited (8/min).',
      body: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } },
      responses: { ...okJson(ref('AdminAuthPayload')), ...errs(401, 429) },
    }),
  },
  '/api/admin/session': {
    get: adminOp({
      tag: 'Admin — Auth',
      summary: 'Current session',
      description: 'Returns the signed-in admin and a fresh CSRF token.',
      responses: { ...okJson(ref('AdminAuthPayload')), ...errs(401) },
    }),
  },
  '/api/admin/setup/password': {
    post: adminOp({
      tag: 'Admin — Auth',
      summary: 'Rotate the bootstrap password',
      description: 'Completes first-run setup. Required before normal admin access when `setupRequired` is true.',
      csrf: true,
      body: { type: 'object', required: ['newPassword'], properties: { newPassword: { type: 'string', minLength: 12 } } },
      responses: { ...okJson(ref('AdminAuthPayload')), ...errs(400, 401, 403) },
    }),
  },
  '/api/admin/logout': {
    post: adminOp({
      tag: 'Admin — Auth',
      summary: 'Sign out',
      description: 'Revokes the session server-side and clears the cookie.',
      csrf: true,
      responses: { ...okJson({ type: 'object', properties: { ok: { type: 'boolean' } } }), ...errs(401, 403) },
    }),
  },

  // ------------------------------------------------------------------- rooms
  '/api/admin/rooms': {
    get: adminOp({
      tag: 'Admin — Rooms',
      summary: 'List rooms',
      description: 'All rooms with presence counts. `q` matches id, name, metadata, candidate and recruiter ids.',
      permission: 'rooms:view_all',
      query: [q('status', 'Filter by status.'), q('q', 'Search text.'), q('limit', 'Max 100.', { type: 'integer' }), q('offset', '', { type: 'integer' })],
      responses: { ...okJson({ type: 'object', properties: { rooms: { type: 'array', items: ref('AdminRoom') } } }), ...errs(401, 403) },
    }),
    post: adminOp({
      tag: 'Admin — Rooms',
      summary: 'Create an interview room',
      description: 'Full interview room: password, candidate/recruiter mapping, invitee allowlist, scheduled slot with join window, participant cap (2–5).',
      permission: 'rooms:create',
      csrf: true,
      body: {
        type: 'object',
        required: ['password'],
        properties: {
          displayName: { type: 'string' },
          password: { type: 'string', minLength: 4 },
          candidateId: { type: 'string' },
          recruiterId: { type: 'string' },
          invitees: { type: 'array', items: ref('Invitee'), maxItems: 16 },
          schedule: ref('Schedule'),
          maxParticipants: { type: 'integer', minimum: 2, maximum: 5 },
          metadata: { type: 'object' },
        },
      },
      responses: { 201: { description: 'Created.', content: json({ type: 'object', properties: { room: ref('AdminRoom'), shareUrl: { type: 'string' }, access: ref('AccessGrant') } }) }, ...errs(400, 401, 403) },
    }),
  },
  '/api/admin/rooms/{roomId}': {
    get: adminOp({
      tag: 'Admin — Rooms',
      summary: 'Room detail',
      description: 'Full projection: participants, invitees, and (permission-dependent) waiting list, lifecycle history, external links. Includes recent audit events.',
      permission: 'rooms:view_all',
      params: [roomIdParam],
      responses: { ...okJson({ type: 'object', properties: { room: ref('AdminRoom'), audit: { type: 'array', items: ref('AuditEvent') } } }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/interview-config': {
    patch: adminOp({
      tag: 'Admin — Rooms',
      summary: 'Update interview mapping',
      description: 'Candidate/recruiter ids (candidate change re-derives the LiveKit room name), invitee allowlist, scheduled slot + join window, participant cap. Omitted fields are left unchanged; send explicit nulls to clear.',
      permission: 'rooms:update_policy',
      csrf: true,
      params: [roomIdParam],
      body: {
        type: 'object',
        properties: {
          candidateId: { type: ['string', 'null'] },
          recruiterId: { type: ['string', 'null'] },
          invitees: { type: 'array', items: ref('Invitee') },
          schedule: ref('Schedule'),
          maxParticipants: { type: 'integer', minimum: 2, maximum: 5 },
        },
      },
      responses: { ...okJson({ type: 'object', properties: { room: ref('AdminRoom') } }), ...errs(400, 401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/lifecycle/{command}': {
    post: adminOp({
      tag: 'Admin — Rooms',
      summary: 'Apply a lifecycle command',
      description: 'Commands: `lock`, `unlock`, `expire`, `disable`, `extend` (requires `expiresAt`). Each is gated by its own permission (`rooms:lock`, `rooms:unlock`, `rooms:expire`, `rooms:disable`, `rooms:extend`). `disable`/`expire` revoke all participant tokens.',
      csrf: true,
      params: [roomIdParam, pathParam('command', 'lock | unlock | expire | disable | extend')],
      body: { type: 'object', properties: { reason: { type: 'string', maxLength: 160 }, expiresAt: { type: 'string', format: 'date-time', description: 'Required for `extend`.' } } },
      responses: { ...okJson({ type: 'object', properties: { room: ref('AdminRoom') } }), ...errs(400, 401, 403, 404, 409) },
    }),
  },
  '/api/admin/rooms/{roomId}/policy': {
    patch: adminOp({
      tag: 'Admin — Rooms',
      summary: 'Update room policy toggles',
      description: 'Waiting-room enablement and auto-admit-first-guest.',
      permission: 'rooms:update_policy',
      csrf: true,
      params: [roomIdParam],
      body: { type: 'object', properties: { waitingRoomEnabled: { type: 'boolean' }, autoAdmitFirstGuest: { type: 'boolean' } } },
      responses: { ...okJson({ type: 'object', properties: { room: ref('AdminRoom') } }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/end': {
    post: adminOp({
      tag: 'Admin — Rooms',
      summary: 'End a room for everyone',
      description: 'Ends the room, revokes all tokens, stops any active recording, and deletes the LiveKit room.',
      permission: 'rooms:end_any',
      csrf: true,
      params: [roomIdParam],
      body: { type: 'object', properties: { confirm: { type: 'boolean' }, reason: { type: 'string' } } },
      responses: { ...okJson({ type: 'object', properties: { room: ref('AdminRoom') } }), ...errs(401, 403, 404, 409) },
    }),
  },
  '/api/admin/rooms/{roomId}/waiting/{participantId}/{decision}': {
    post: adminOp({
      tag: 'Admin — Rooms',
      summary: 'Decide a waiting guest',
      description: 'Admin admission decision. `decision` is `admit` (requires `waiting_room:admit`) or `reject` (requires `waiting_room:reject`).',
      csrf: true,
      params: [roomIdParam, pathParam('participantId', 'Waiting guest id.'), pathParam('decision', '`admit` or `reject`.')],
      responses: { ...okJson({ type: 'object', properties: { participant: { type: 'object' }, waitingParticipants: { type: 'array', items: ref('WaitingParticipant') } } }), ...errs(400, 401, 403, 404) },
    }),
  },

  // ------------------------------------------------------------------ emails
  '/api/admin/rooms/{roomId}/emails': {
    get: adminOp({
      tag: 'Admin — Rooms',
      summary: 'Room email outbox',
      permission: 'rooms:view_all',
      description: 'Invitation emails recorded for this room, plus the active email provider (`local` records only; `ses` delivers via AWS SES).',
      params: [roomIdParam],
      query: [q('limit', 'Max 100.', { type: 'integer' })],
      responses: { ...okJson({ type: 'object', properties: { emails: { type: 'array', items: ref('OutboxEmail') }, email: ref('EmailStatus') } }), ...errs(401, 403) },
    }),
  },
  '/api/admin/rooms/{roomId}/invitees/{inviteeEmail}/resend-invite': {
    post: adminOp({
      tag: 'Admin — Rooms',
      summary: 'Resend an invitation email',
      description: 'Re-sends the room invitation to an existing invitee. The room password is never included on resends (it is not stored in plaintext) — the email tells the invitee it is shared separately.',
      permission: 'rooms:update_policy',
      csrf: true,
      params: [roomIdParam, pathParam('inviteeEmail', 'Invitee email address.')],
      responses: { 202: { description: 'Email queued/recorded.', content: json({ type: 'object', properties: { queued: { type: 'boolean' }, email: ref('EmailStatus') } }) }, ...errs(401, 403, 404) },
    }),
  },

  // -------------------------------------------------------------------- team
  '/api/admin/users': {
    get: adminOp({
      tag: 'Admin — Auth',
      summary: 'List admin users',
      permission: 'admin_users:manage',
      description: 'All admin accounts with roles and setup state.',
      responses: { ...okJson({ type: 'object', properties: { users: { type: 'array', items: ref('AdminUser') }, email: ref('EmailStatus') } }), ...errs(401, 403) },
    }),
    post: adminOp({
      tag: 'Admin — Auth',
      summary: 'Create an admin user',
      description: 'Creates an invited admin with a generated one-time password (returned once in the response, and emailed when the SES provider is active). First sign-in forces a password rotation. Default role: `operator`.',
      permission: 'admin_users:manage',
      csrf: true,
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
          displayName: { type: 'string', maxLength: 120 },
          roleKeys: { type: 'array', items: { type: 'string', enum: ['platform_admin', 'operator', 'support_reviewer', 'auditor'] } },
        },
      },
      responses: { 201: { description: 'User created; `temporaryPassword` is shown only once.', content: json({ type: 'object', properties: { user: ref('AdminUser'), temporaryPassword: { type: 'string' }, email: ref('EmailStatus') } }) }, ...errs(400, 401, 403, 409) },
    }),
  },

  // -------------------------------------------------------------------- chat
  '/api/admin/rooms/{roomId}/chat': {
    get: adminOp({
      tag: 'Admin — Chat',
      summary: 'View retained chat',
      description: 'Retention settings plus messages (empty when retention is off).',
      permission: 'chat:view',
      params: [roomIdParam],
      query: [q('limit', 'Max 200.', { type: 'integer' })],
      responses: { ...okJson({ type: 'object', properties: { retention: ref('ChatRetention'), messages: { type: 'array', items: ref('ChatMessage') } } }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/chat/export': {
    get: adminOp({
      tag: 'Admin — Chat',
      summary: 'Export retained chat',
      description: 'Full JSON export. Fails with 409 when retention is disabled.',
      permission: 'chat:export',
      params: [roomIdParam],
      responses: { ...okJson({ type: 'object', properties: { retention: ref('ChatRetention'), messages: { type: 'array', items: ref('ChatMessage') } } }), ...errs(401, 403, 404, 409) },
    }),
  },
  '/api/admin/rooms/{roomId}/chat/{messageId}/redact': {
    post: adminOp({
      tag: 'Admin — Chat',
      summary: 'Redact a message',
      description: 'Blanks the body while keeping the row (audit-preserving).',
      permission: 'chat:redact',
      csrf: true,
      params: [roomIdParam, pathParam('messageId', 'Chat message id.')],
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/chat/{messageId}/delete': {
    post: adminOp({
      tag: 'Admin — Chat',
      summary: 'Delete a message',
      description: 'Soft-deletes the message (hidden from projections).',
      permission: 'chat:delete',
      csrf: true,
      params: [roomIdParam, pathParam('messageId', 'Chat message id.')],
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/chat-settings': {
    put: adminOp({
      tag: 'Admin — Chat',
      summary: 'Configure chat retention',
      description: 'Enable/disable retention and set the retention window.',
      permission: 'chat:configure_retention',
      csrf: true,
      params: [roomIdParam],
      body: { type: 'object', properties: { retentionEnabled: { type: 'boolean' }, retentionDays: { type: 'integer', minimum: 1, maximum: 30 }, notice: { type: 'string' } } },
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
  },

  // ------------------------------------------------------------- transcripts
  '/api/admin/rooms/{roomId}/transcript-settings': {
    get: adminOp({
      tag: 'Admin — Transcripts',
      summary: 'View transcript settings',
      permission: 'transcripts:configure',
      description: 'Per-room transcript policy (enablement, notice, retention).',
      params: [roomIdParam],
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
    put: adminOp({
      tag: 'Admin — Transcripts',
      summary: 'Configure transcripts',
      description: 'Enablement flags, participant notice (re-versions consent), retention days.',
      permission: 'transcripts:configure',
      csrf: true,
      params: [roomIdParam],
      body: { type: 'object', properties: { transcriptEnabled: { type: 'boolean' }, liveCaptionsEnabled: { type: 'boolean' }, mockProviderEnabled: { type: 'boolean' }, notice: { type: 'string' }, retentionDays: { type: 'integer' } } },
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/transcripts': {
    get: adminOp({
      tag: 'Admin — Transcripts',
      summary: 'List transcript artifacts',
      permission: 'transcripts:view',
      description: 'Settings plus artifacts (segments fetched per-artifact).',
      params: [roomIdParam],
      query: [q('limit', 'Max 100.', { type: 'integer' })],
      responses: { ...okJson({ type: 'object', properties: { settings: { type: 'object' }, artifacts: { type: 'array', items: ref('TranscriptArtifact') } } }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/transcripts/{artifactId}': {
    get: adminOp({
      tag: 'Admin — Transcripts',
      summary: 'Transcript with segments',
      permission: 'transcripts:view',
      description: 'One artifact plus its timed segments.',
      params: [roomIdParam, pathParam('artifactId', 'Transcript artifact id.')],
      responses: { ...okJson({ type: 'object', properties: { artifact: ref('TranscriptArtifact'), segments: { type: 'array', items: ref('TranscriptSegment') } } }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/transcripts/{artifactId}/export': {
    get: adminOp({
      tag: 'Admin — Transcripts',
      summary: 'Export a transcript',
      permission: 'transcripts:export',
      description: 'Full JSON export (artifact + segments). Audited.',
      params: [roomIdParam, pathParam('artifactId', 'Transcript artifact id.')],
      responses: { ...okJson({ type: 'object', properties: { artifact: ref('TranscriptArtifact'), segments: { type: 'array', items: ref('TranscriptSegment') } } }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/transcripts/{artifactId}/segments/{segmentId}/redact': {
    post: adminOp({
      tag: 'Admin — Transcripts',
      summary: 'Redact a segment',
      permission: 'transcripts:redact',
      csrf: true,
      description: 'Blanks the segment text, keeping timing and audit trail.',
      params: [roomIdParam, pathParam('artifactId', 'Transcript artifact id.'), pathParam('segmentId', 'Segment id.')],
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/transcripts/{artifactId}/segments/{segmentId}/delete': {
    post: adminOp({
      tag: 'Admin — Transcripts',
      summary: 'Delete a segment',
      permission: 'transcripts:delete',
      csrf: true,
      description: 'Soft-deletes one segment.',
      params: [roomIdParam, pathParam('artifactId', 'Transcript artifact id.'), pathParam('segmentId', 'Segment id.')],
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/transcripts/{artifactId}/delete': {
    post: adminOp({
      tag: 'Admin — Transcripts',
      summary: 'Delete a transcript artifact',
      permission: 'transcripts:delete',
      csrf: true,
      description: 'Soft-deletes the artifact and hides its segments.',
      params: [roomIdParam, pathParam('artifactId', 'Transcript artifact id.')],
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/transcripts/mock/start': {
    post: adminOp({
      tag: 'Admin — Transcripts',
      summary: 'Start a mock transcript (legacy)',
      permission: 'transcripts:manage_mock',
      csrf: true,
      description: 'Legacy local-mock provider for testing. Real transcripts come from the recording pipeline.',
      params: [roomIdParam],
      body: { type: 'object', properties: { providerKey: { type: 'string' }, language: { type: 'string' } } },
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404, 409) },
    }),
  },
  '/api/admin/rooms/{roomId}/transcripts/{artifactId}/mock-segments': {
    post: adminOp({
      tag: 'Admin — Transcripts',
      summary: 'Append a mock segment (legacy)',
      permission: 'transcripts:manage_mock',
      csrf: true,
      description: 'Injects a deterministic text segment into an active mock transcript. Rate limited (20/min per artifact).',
      params: [roomIdParam, pathParam('artifactId', 'Transcript artifact id.')],
      body: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, speakerLabel: { type: 'string' }, startMs: { type: 'integer' }, endMs: { type: 'integer' } } },
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404, 409, 429) },
    }),
  },
  '/api/admin/rooms/{roomId}/transcripts/{artifactId}/finalize': {
    post: adminOp({
      tag: 'Admin — Transcripts',
      summary: 'Finalize a mock transcript (legacy)',
      permission: 'transcripts:manage_mock',
      csrf: true,
      description: 'Marks an active mock transcript as finalized.',
      params: [roomIdParam, pathParam('artifactId', 'Transcript artifact id.')],
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404, 409) },
    }),
  },

  // -------------------------------------------------------------- recordings
  '/api/admin/rooms/{roomId}/recording-settings': {
    get: adminOp({
      tag: 'Admin — Recordings',
      summary: 'View recording settings',
      permission: 'recordings:configure',
      description: 'Per-room recording policy (enablement, notice, retention).',
      params: [roomIdParam],
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
    put: adminOp({
      tag: 'Admin — Recordings',
      summary: 'Configure recording',
      description: 'Enable/disable recording. Enabling makes the room acknowledge-to-enter: participants must accept the notice before media credentials are issued.',
      permission: 'recordings:configure',
      csrf: true,
      params: [roomIdParam],
      body: { type: 'object', properties: { recordingEnabled: { type: 'boolean' }, mockRecordingEnabled: { type: 'boolean' }, notice: { type: 'string' }, retentionDays: { type: 'integer' } } },
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/recordings': {
    get: adminOp({
      tag: 'Admin — Recordings',
      summary: 'List recordings for a room',
      permission: 'recordings:view',
      description: 'Settings plus artifacts, newest first.',
      params: [roomIdParam],
      query: [q('limit', 'Max 100.', { type: 'integer' })],
      responses: { ...okJson({ type: 'object', properties: { settings: { type: 'object' }, artifacts: { type: 'array', items: ref('RecordingArtifact') } } }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/recordings/{recordingId}': {
    get: adminOp({
      tag: 'Admin — Recordings',
      summary: 'Recording detail',
      permission: 'recordings:view',
      description: 'One artifact projection (no storage keys).',
      params: [roomIdParam, pathParam('recordingId', 'Recording artifact id.')],
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/recordings/start': {
    post: adminOp({
      tag: 'Admin — Recordings',
      summary: 'Start recording (LiveKit egress)',
      description: 'Starts a composite egress of all participants into the configured storage (local folder in dev, S3 in production). One active recording per room. Fails 503 when no egress is configured.',
      permission: 'recordings:manage',
      csrf: true,
      params: [roomIdParam],
      responses: { 201: { description: 'Recording started.', content: json({ type: 'object', properties: { artifact: ref('RecordingArtifact') } }) }, ...errs(401, 403, 404, 409, 410, 503) },
    }),
  },
  '/api/admin/rooms/{roomId}/recordings/{recordingId}/stop': {
    post: adminOp({
      tag: 'Admin — Recordings',
      summary: 'Stop recording',
      description: 'Requests egress stop; the artifact finalizes when the LiveKit webhook lands (byte size, duration). Recording also auto-stops on room end.',
      permission: 'recordings:manage',
      csrf: true,
      params: [roomIdParam, pathParam('recordingId', 'Recording artifact id.')],
      responses: { ...okJson({ type: 'object', properties: { stopping: { type: 'boolean' } } }), ...errs(401, 403, 404, 409) },
    }),
  },
  '/api/admin/rooms/{roomId}/recordings/{recordingId}/media': {
    get: adminOp({
      tag: 'Admin — Recordings',
      summary: 'Play back / download media',
      description: 'Streams the MP4 (local storage) or 302-redirects to a short-lived presigned URL (S3). Only finalized real recordings have media. Access is audited.',
      permission: 'recordings:playback',
      params: [roomIdParam, pathParam('recordingId', 'Recording artifact id.')],
      responses: {
        200: { description: 'MP4 stream (local storage mode).', content: { 'video/mp4': { schema: { type: 'string', format: 'binary' } } } },
        302: { description: 'Redirect to a presigned URL (S3 mode).' },
        ...errs(401, 403, 404),
      },
    }),
  },
  '/api/admin/rooms/{roomId}/recordings/{recordingId}/transcribe': {
    post: adminOp({
      tag: 'Admin — Recordings',
      summary: 'Re-run transcription',
      description: 'Queues a new STT job for a finalized recording (automatic transcription already runs on finalize; use this after failures).',
      permission: 'recordings:manage',
      csrf: true,
      params: [roomIdParam, pathParam('recordingId', 'Recording artifact id.')],
      responses: { 202: { description: 'Job queued.', content: json({ type: 'object', properties: { transcriptArtifactId: { type: 'string' } } }) }, ...errs(401, 403, 404, 409, 502) },
    }),
  },
  '/api/admin/rooms/{roomId}/recordings/{recordingId}/delete': {
    post: adminOp({
      tag: 'Admin — Recordings',
      summary: 'Delete a recording artifact',
      permission: 'recordings:delete',
      csrf: true,
      description: 'Soft-deletes the artifact (media cleanup is a storage-lifecycle concern).',
      params: [roomIdParam, pathParam('recordingId', 'Recording artifact id.')],
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/recordings/mock/start': {
    post: adminOp({
      tag: 'Admin — Recordings',
      summary: 'Start mock recording metadata (legacy)',
      permission: 'recordings:manage_mock',
      csrf: true,
      description: 'Legacy metadata-only mock (no media). Kept for compatibility.',
      params: [roomIdParam],
      responses: { 201: { description: 'Mock artifact created.', content: json({ type: 'object' }) }, ...errs(401, 403, 404, 409) },
    }),
  },
  '/api/admin/rooms/{roomId}/recordings/{recordingId}/mock-finalize': {
    post: adminOp({
      tag: 'Admin — Recordings',
      summary: 'Finalize mock recording (legacy)',
      permission: 'recordings:manage_mock',
      csrf: true,
      description: 'Finalizes a mock metadata artifact with an admin-supplied duration.',
      params: [roomIdParam, pathParam('recordingId', 'Recording artifact id.')],
      body: { type: 'object', properties: { durationMs: { type: 'integer' } } },
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404, 409) },
    }),
  },
  '/api/admin/rooms/{roomId}/recordings/{recordingId}/mock-fail': {
    post: adminOp({
      tag: 'Admin — Recordings',
      summary: 'Fail mock recording (legacy)',
      permission: 'recordings:manage_mock',
      csrf: true,
      description: 'Marks a mock metadata artifact as failed.',
      params: [roomIdParam, pathParam('recordingId', 'Recording artifact id.')],
      body: { type: 'object', properties: { reason: { type: 'string' } } },
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404, 409) },
    }),
  },

  // ------------------------------------------------------------------- embed
  '/api/admin/rooms/{roomId}/embed': {
    get: adminOp({
      tag: 'Admin — Embed',
      summary: 'View embed settings + sessions',
      permission: 'embed:view',
      description: 'Origin allowlist and issued sessions (metadata only, no tokens).',
      params: [roomIdParam],
      responses: { ...okJson({ type: 'object', properties: { settings: ref('EmbedSettings'), sessions: { type: 'array', items: ref('EmbedSession') } } }), ...errs(401, 403, 404) },
    }),
    put: adminOp({
      tag: 'Admin — Embed',
      summary: 'Configure embed origins',
      description: 'Exact origins only. Local origins always allowed; remote origins require https and `WEBRTC_EMBED_ALLOW_REMOTE_ORIGINS=1`.',
      permission: 'embed:configure',
      csrf: true,
      params: [roomIdParam],
      body: { type: 'object', properties: { embedEnabled: { type: 'boolean' }, allowedOrigins: { type: 'array', items: { type: 'string' }, maxItems: 12 } } },
      responses: { ...okJson({ type: 'object' }), ...errs(400, 401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/embed/sessions': {
    post: adminOp({
      tag: 'Admin — Embed',
      summary: 'Issue an embed session',
      description: 'One-time bootstrap token (returned once) bound to an allowed origin and scopes. Default TTL 10 minutes.',
      permission: 'embed:issue_token',
      csrf: true,
      params: [roomIdParam],
      body: { type: 'object', required: ['allowedOrigin'], properties: { allowedOrigin: { type: 'string' }, scope: { type: 'array', items: { type: 'string', enum: ['embed:status', 'embed:join'] } }, ttlMs: { type: 'integer' } } },
      responses: { 201: { description: 'Session issued.', content: json({ type: 'object', properties: { session: ref('EmbedSession'), bootstrapToken: { type: 'string' } } }) }, ...errs(400, 401, 403, 404) },
    }),
  },
  '/api/admin/rooms/{roomId}/embed/sessions/{sessionId}/revoke': {
    post: adminOp({
      tag: 'Admin — Embed',
      summary: 'Revoke an embed session',
      permission: 'embed:revoke',
      csrf: true,
      description: 'Immediately invalidates the session and its tokens.',
      params: [roomIdParam, pathParam('sessionId', 'Embed session id.')],
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
  },

  // ------------------------------------------------------------ integrations
  '/api/admin/integrations': {
    get: adminOp({
      tag: 'Admin — Integrations',
      summary: 'Integration overview',
      permission: 'integrations:view',
      description: 'Clients (key prefixes only), external systems, identities, room links, and locally recorded webhook attempts.',
      responses: { ...okJson({ type: 'object', properties: { clients: { type: 'array', items: ref('IntegrationClient') }, systems: { type: 'array' }, identities: { type: 'array' }, roomLinks: { type: 'array' }, webhookAttempts: { type: 'array' } } }), ...errs(401, 403) },
    }),
  },
  '/api/admin/integrations/clients': {
    post: adminOp({
      tag: 'Admin — Integrations',
      summary: 'Create an API client',
      description: 'Issues a bearer API key — **returned once in `key`**, stored hashed. Default scopes: `rooms:create`, `rooms:read`, `rooms:link`.',
      permission: 'integrations:manage',
      csrf: true,
      body: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, systemKey: { type: 'string' }, permissionScope: { type: 'array', items: { type: 'string' } }, allowedOrigins: { type: 'array', items: { type: 'string' } } } },
      responses: { 201: { description: 'Client created; `key` is shown only once.', content: json({ type: 'object', properties: { client: ref('IntegrationClient'), key: { type: 'string' } } }) }, ...errs(400, 401, 403) },
    }),
  },
  '/api/admin/integrations/clients/{clientId}/revoke': {
    post: adminOp({
      tag: 'Admin — Integrations',
      summary: 'Revoke an API client',
      permission: 'integrations:manage',
      csrf: true,
      description: 'Immediately rejects the client\'s key on all integration endpoints.',
      params: [pathParam('clientId', 'Integration client id.')],
      responses: { ...okJson({ type: 'object' }), ...errs(401, 403, 404) },
    }),
  },

  // ------------------------------------------------------------------- audit
  '/api/admin/recordings': {
    get: adminOp({
      tag: 'Admin — Audit',
      summary: 'All recordings across rooms',
      permission: 'recordings:view',
      description: 'Global recordings table joined with room name/candidate.',
      query: [q('limit', 'Max 200.', { type: 'integer' })],
      responses: { ...okJson({ type: 'object', properties: { recordings: { type: 'array', items: ref('RecordingArtifact') } } }), ...errs(401, 403) },
    }),
  },
  '/api/admin/transcripts': {
    get: adminOp({
      tag: 'Admin — Audit',
      summary: 'All transcripts across rooms',
      permission: 'transcripts:view',
      description: 'Global transcripts table joined with room name/candidate.',
      query: [q('limit', 'Max 200.', { type: 'integer' })],
      responses: { ...okJson({ type: 'object', properties: { transcripts: { type: 'array', items: ref('TranscriptArtifact') } } }), ...errs(401, 403) },
    }),
  },
  '/api/admin/audit': {
    get: adminOp({
      tag: 'Admin — Audit',
      summary: 'Global audit feed',
      permission: 'audit:view',
      description: 'Most recent audit events across the platform (message/segment bodies are never included).',
      responses: { ...okJson({ type: 'object', properties: { audit: { type: 'array', items: ref('AuditEvent') } } }), ...errs(401, 403) },
    }),
  },
}

Object.assign(openApiSpec.paths, adminPaths)
