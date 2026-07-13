import { listRoomEmails, markOutboxEmail, recordOutboxEmail } from './store.mjs'

// Outgoing email. Same adapter pattern as storage/stt:
//   local — default; every email is composed and recorded in the outbox
//           (visible in the admin console) but nothing is sent. Safe for dev.
//   ses   — AWS SES v2. Activates when WEBRTC_EMAIL_PROVIDER=ses; uses the
//           explicit key pair below or the default AWS credential chain
//           (IAM role) when none is set. Verify the from-address/domain in
//           SES before going live.
const emailProvider = process.env.WEBRTC_EMAIL_PROVIDER === 'ses' ? 'ses' : 'local'
const fromAddress = process.env.WEBRTC_EMAIL_FROM || 'InterviewRooms <no-reply@example.com>'
const sesRegion = process.env.WEBRTC_SES_REGION || process.env.WEBRTC_S3_REGION || 'us-east-1'
const sesAccessKey = process.env.WEBRTC_SES_ACCESS_KEY || ''
const sesSecretKey = process.env.WEBRTC_SES_SECRET_KEY || ''

let sesClientPromise = null
function sesClient() {
  // Lazy import keeps the SES SDK out of local-mode startup entirely.
  if (!sesClientPromise) {
    sesClientPromise = import('@aws-sdk/client-sesv2').then(({ SESv2Client }) => new SESv2Client({
      region: sesRegion,
      credentials: sesAccessKey ? { accessKeyId: sesAccessKey, secretAccessKey: sesSecretKey } : undefined,
    }))
  }
  return sesClientPromise
}

export function emailStatus() {
  return { provider: emailProvider, from: fromAddress, deliveryEnabled: emailProvider === 'ses' }
}

// Compose + record + (ses only) deliver. Fire-and-forget from callers: the
// outbox row carries the outcome either way; failures never break the caller.
async function deliver({ toEmail, templateKey, subject, bodyText, roomId = null }) {
  if (emailProvider !== 'ses') {
    recordOutboxEmail({ toEmail, templateKey, subject, bodyText, roomId, provider: 'local', status: 'local_recorded' })
    return
  }
  const outboxId = recordOutboxEmail({ toEmail, templateKey, subject, bodyText, roomId, provider: 'ses', status: 'failed', error: 'not attempted' })
  try {
    const [{ SendEmailCommand }, client] = await Promise.all([import('@aws-sdk/client-sesv2'), sesClient()])
    await client.send(new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: { ToAddresses: [toEmail] },
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: bodyText } } } },
    }))
    markOutboxEmail(outboxId, { status: 'sent' })
  } catch (error) {
    markOutboxEmail(outboxId, { status: 'failed', error: String(error.message || error).slice(0, 300) })
  }
}

// ---------------------------------------------------------------------------
// Templates — plain text (renders everywhere, nothing to maintain).
// ---------------------------------------------------------------------------
function inviteBody({ room, invitee, joinUrl, password }) {
  const lines = [
    `Hi${invitee.displayName ? ` ${invitee.displayName}` : ''},`,
    '',
    `You have been invited to the video interview "${room.displayName}".`,
    '',
    `Join link: ${joinUrl}`,
  ]
  if (room.scheduledStartAt) {
    lines.push(`Scheduled: ${new Date(room.scheduledStartAt).toUTCString()}`)
    if (room.joinWindowMinutes != null) {
      lines.push(`The room opens ${room.joinWindowMinutes} minutes before the scheduled start.`)
    }
  }
  lines.push('', `Sign in with this email address (${invitee.email}).`)
  lines.push(password
    ? `Room password: ${password}`
    : 'The room password is shared separately by your recruiter.')
  lines.push('', 'Your camera stays off until you confirm access and pass the device check.')
  return lines.join('\n')
}

// Room invitations for a set of invitees. `password` is only available at
// creation time (never stored in plaintext); resends omit it.
export function sendRoomInvitations({ room, invitees, origin, password = null }) {
  const joinUrl = `${origin || ''}/rooms/${room.id}`
  for (const invitee of invitees || []) {
    if (!invitee?.email) continue
    deliver({
      toEmail: invitee.email,
      templateKey: 'room_invitation',
      subject: `Interview invitation: ${room.displayName}`,
      bodyText: inviteBody({ room, invitee, joinUrl, password }),
      roomId: room.id,
    }).catch(() => {})
  }
}

// Welcome email for a newly created admin user (one-time password; the first
// login forces a rotation).
export function sendAdminWelcome({ user, temporaryPassword, origin }) {
  const bodyText = [
    `Hi ${user.displayName},`,
    '',
    'An administrator account was created for you on InterviewRooms.',
    '',
    `Console: ${origin || ''}/admin`,
    `Email: ${user.email}`,
    `Temporary password: ${temporaryPassword}`,
    '',
    'You will be asked to set your own password on first sign-in.',
    `Roles: ${(user.roles || []).map((role) => role.name).join(', ')}`,
  ].join('\n')
  deliver({
    toEmail: user.email,
    templateKey: 'admin_welcome',
    subject: 'Your InterviewRooms admin account',
    bodyText,
  }).catch(() => {})
}

export { listRoomEmails }
