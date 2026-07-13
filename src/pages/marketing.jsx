import { useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { api, useClipboard } from '../lib/api.js'
import { Field } from '../ui/kit.jsx'
import {
  IconCalendar, IconCam, IconChat, IconCheck, IconCopy, IconFileText, IconLink,
  IconPlug, IconPlus, IconRecord, IconShield, IconUsers, IconVideo,
} from '../ui/icons.jsx'

// ---------------------------------------------------------------------------
// Shared public shell — marketing topbar + footer around every public page.
// ---------------------------------------------------------------------------
export function PublicShell({ children }) {
  return (
    <div className="mk-shell">
      <header className="public-topbar">
        <Link className="brand" to="/">
          <span className="brand-mark"><IconVideo /></span>
          InterviewRooms
        </Link>
        <nav className="mk-nav" aria-label="Site">
          <NavLink to="/how-it-works">How it works</NavLink>
          <NavLink to="/security">Security</NavLink>
        </nav>
        <div className="topbar-actions">
          <Link className="btn btn-ghost" to="/join">Join a call</Link>
          <a className="btn btn-primary" href="/admin">Sign in</a>
        </div>
      </header>
      {children}
      <footer className="mk-footer">
        <div className="mk-footer-inner">
          <div>
            <Link className="brand" to="/">
              <span className="brand-mark"><IconVideo /></span>
              InterviewRooms
            </Link>
            <p className="muted">Self-hosted interview video rooms.<br />Your candidates, your recordings, your infrastructure.</p>
          </div>
          <div className="mk-footer-col">
            <strong>Product</strong>
            <Link to="/how-it-works">How it works</Link>
            <Link to="/security">Security</Link>
            <Link to="/join">Join a call</Link>
          </div>
          <div className="mk-footer-col">
            <strong>Operators</strong>
            <a href="/admin">Admin console</a>
            <a href="/admin">API reference</a>
            <a href="/admin">Deployment guide</a>
          </div>
        </div>
        <p className="mk-footer-note">Runs entirely on your own infrastructure. No third-party video cloud.</p>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Landing — hero with a CSS mock of the call UI, features, steps, CTA.
// ---------------------------------------------------------------------------
const FEATURES = [
  { icon: IconCalendar, title: 'Scheduled rooms with join windows', text: 'Rooms map to interview slots. Candidates can only enter a configurable window before the start — no one wanders into a room a day early.' },
  { icon: IconUsers, title: 'Invite-only access', text: 'Lock a room to specific email addresses on top of its password. Waiting rooms let hosts admit guests one by one.' },
  { icon: IconRecord, title: 'Consent-gated recording', text: 'One click records a composite of the whole panel. Participants must acknowledge the recording notice before they can even join.' },
  { icon: IconFileText, title: 'Post-call transcripts', text: 'Every finalized recording is transcribed automatically. Review, export, or redact segments from the console.' },
  { icon: IconPlug, title: 'API-first integration', text: 'Provision rooms from your hiring portal with a scoped API key, map candidates and recruiters, and poll interview status — all documented in interactive API docs.' },
  { icon: IconShield, title: 'Self-hosted and auditable', text: 'Media flows through your own LiveKit server; recordings land in your S3 bucket. Every consequential action is written to an immutable audit log.' },
]

const STEPS = [
  { n: '1', title: 'Schedule', text: 'Create the interview room — from the admin console or straight from your hiring portal via the API. Set the slot, the join window, and who is invited.' },
  { n: '2', title: 'Interview', text: 'Candidates join with the link, pass the password and email gate, check their devices, and land in the call. Recruiters signed into the portal are admitted automatically as hosts.' },
  { n: '3', title: 'Review', text: 'The recording and transcript are waiting in the console when the call ends — play back, export, or pipe status back into the portal.' },
]

export function LandingPage() {
  return (
    <PublicShell>
      <main>
        <section className="mk-hero">
          <div className="mk-hero-copy">
            <p className="kicker">Self-hosted interview video</p>
            <h1>The interview room your hiring stack actually owns.</h1>
            <p className="mk-lede">
              Scheduled, invite-only video rooms with consent-gated recording and automatic
              transcripts — running on your infrastructure, wired into your hiring portal,
              with an admin console your operations team will recognize.
            </p>
            <div className="inline-actions">
              <Link className="btn btn-primary btn-lg" to="/join">Join an interview</Link>
              <a className="btn btn-lg" href="/admin">Open the console</a>
            </div>
            <div className="mk-hero-points">
              <span><IconCheck /> No per-minute fees</span>
              <span><IconCheck /> Recordings stay in your S3</span>
              <span><IconCheck /> Up to 5-person panels</span>
            </div>
          </div>
          <CallMock />
        </section>

        <section className="mk-section">
          <div className="mk-section-head">
            <h2>Built for hiring, not for meetings in general</h2>
            <p className="muted">Every feature exists because interviews need it.</p>
          </div>
          <div className="mk-grid">
            {FEATURES.map((feature) => (
              <article key={feature.title} className="card mk-feature">
                <span className="mk-feature-icon"><feature.icon /></span>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mk-section mk-section-dim">
          <div className="mk-section-head">
            <h2>Three steps, start to hire</h2>
          </div>
          <div className="mk-steps">
            {STEPS.map((step) => (
              <article key={step.n} className="mk-step">
                <span className="mk-step-n">{step.n}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </article>
            ))}
          </div>
          <p className="mk-center"><Link to="/how-it-works">See the full flow →</Link></p>
        </section>

        <section className="mk-cta">
          <h2>Ready to run an interview?</h2>
          <p>Join with a link you received, or sign in to schedule one.</p>
          <div className="inline-actions" style={{ justifyContent: 'center' }}>
            <Link className="btn btn-primary btn-lg" to="/join">Join a call</Link>
            <a className="btn btn-lg mk-cta-ghost" href="/admin">Sign in to the console</a>
          </div>
        </section>
      </main>
    </PublicShell>
  )
}

// Pure-CSS mock of the in-call UI for the hero.
function CallMock() {
  return (
    <div className="mk-mock" aria-hidden="true">
      <div className="mk-mock-top">
        <span className="mk-mock-title">Interview — Jane Doe</span>
        <span className="mk-mock-rec"><i /> REC 12:41</span>
      </div>
      <div className="mk-mock-stage">
        <div className="mk-mock-tile"><span className="mk-mock-avatar">JD</span><em>Jane Doe</em></div>
        <div className="mk-mock-tile"><span className="mk-mock-avatar mk-a2">MR</span><em>M. Reyes · Host</em></div>
      </div>
      <div className="mk-mock-bar">
        <span><IconCam /></span>
        <span><IconChat /></span>
        <span><IconUsers /></span>
        <span className="mk-mock-danger"><IconRecord /></span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Join page — the functional cards (join by link + instant room).
// ---------------------------------------------------------------------------
function JoinByLinkCard() {
  const navigate = useNavigate()
  const [joinValue, setJoinValue] = useState('')

  const submit = (event) => {
    event.preventDefault()
    const raw = joinValue.trim()
    if (!raw) return
    // Accept a full link or a bare room id.
    const match = raw.match(/\/rooms\/([^/?#]+)/)
    navigate(`/rooms/${encodeURIComponent(match ? match[1] : raw)}`)
  }

  return (
    <div className="card landing-card">
      <h2><IconLink /> Join an interview</h2>
      <p className="muted">Paste the room link or ID you were invited with. You&apos;ll confirm your identity and password before any camera prompt.</p>
      <form onSubmit={submit}>
        <Field label="Room link or ID">
          <input value={joinValue} onChange={(event) => setJoinValue(event.target.value)} placeholder="https://…/rooms/abc123 or abc123" required />
        </Field>
        <button className="btn btn-primary btn-lg" type="submit">Join room</button>
      </form>
    </div>
  )
}

function CreateRoomCard() {
  const navigate = useNavigate()
  const clipboard = useClipboard()
  const [displayName, setDisplayName] = useState('Interview room')
  const [password, setPassword] = useState('')
  const [created, setCreated] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    return (
      <div className="card landing-card">
        <h2><IconCheck /> Room ready</h2>
        <p className="muted">Share the link and password separately. You hold the host seat for this room.</p>
        <Field label="Invite link">
          <span className="copy-field">
            <code>{created.shareUrl}</code>
            <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label="Copy invite link" onClick={() => clipboard.copy(created.shareUrl)}>
              {clipboard.copied ? <IconCheck /> : <IconCopy />}
            </button>
          </span>
        </Field>
        <button
          className="btn btn-primary btn-lg"
          type="button"
          onClick={() => navigate(`/rooms/${created.room.id}`, { state: { access: created.access, room: created.room } })}
        >
          Enter as host
        </button>
      </div>
    )
  }

  return (
    <div className="card landing-card">
      <h2><IconPlus /> Start a quick room</h2>
      <p className="muted">Instant password-protected room. Scheduled interview rooms with invitees are created from the admin console.</p>
      <form onSubmit={submit}>
        <Field label="Room name">
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
        </Field>
        <Field label="Room password" hint="At least 4 characters. Shared with guests out-of-band.">
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength="4" required />
        </Field>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create room'}</button>
      </form>
    </div>
  )
}

export function JoinPage() {
  return (
    <PublicShell>
      <main className="landing" style={{ paddingTop: 44 }}>
        <section className="landing-hero" style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 30 }}>Join an interview</h1>
          <p>Use the link you were invited with — your camera stays off until access is confirmed.</p>
        </section>
        <section className="landing-cards">
          <JoinByLinkCard />
          <CreateRoomCard />
        </section>
      </main>
    </PublicShell>
  )
}

// ---------------------------------------------------------------------------
// How it works — the two journeys, explained.
// ---------------------------------------------------------------------------
export function HowItWorksPage() {
  return (
    <PublicShell>
      <main className="mk-page">
        <header className="mk-page-head">
          <p className="kicker">How it works</p>
          <h1>From scheduled slot to reviewed transcript</h1>
        </header>

        <section className="mk-flow">
          <h2><IconUsers /> For candidates</h2>
          <ol className="guide-steps">
            <li><strong>Open the link.</strong> You&apos;ll see the room name and, if the interview is scheduled, exactly when it opens — a configurable window before the start time.</li>
            <li><strong>Confirm access.</strong> Enter the invited email (invite-only rooms), your name, and the room password. Nothing touches your camera yet.</li>
            <li><strong>Recording notice.</strong> If the interview is recorded you&apos;ll see the notice first — the room only opens after you acknowledge it.</li>
            <li><strong>Device check.</strong> Preview your camera and watch the mic meter move before joining.</li>
            <li><strong>The call.</strong> Video grid, screen share, chat. If you drop, rejoin with the same link and password.</li>
          </ol>
        </section>

        <section className="mk-flow">
          <h2><IconVideo /> For recruiters and hiring teams</h2>
          <ol className="guide-steps">
            <li><strong>Schedule.</strong> Create the room in the admin console — or let your hiring portal provision it automatically over the API with the candidate, recruiter, invitees, and time slot attached.</li>
            <li><strong>Join as host.</strong> Signed into the portal? Its own token admits you automatically, ahead of the join window, with host controls.</li>
            <li><strong>Run the interview.</strong> Admit waiting guests, share screens, record with one click — recording stops automatically when the room ends.</li>
            <li><strong>Review.</strong> The composite recording and its transcript appear in the console: play, export, redact. Status flows back to the portal via the API.</li>
          </ol>
        </section>

        <section className="mk-flow">
          <h2><IconLink /> For the platform team</h2>
          <ol className="guide-steps">
            <li><strong>Deploy once.</strong> One host runs the app, the LiveKit media server, and the recorder; recordings go to your S3 bucket. The console ships a complete AWS guide.</li>
            <li><strong>Integrate.</strong> A scoped API key + one prompt to your portal&apos;s AI builder wires scheduling, joining, and results end to end. Interactive API docs cover all 76 operations.</li>
            <li><strong>Operate.</strong> Role-based admin access, waiting rooms, lifecycle controls, and an immutable audit log.</li>
          </ol>
        </section>

        <section className="mk-cta">
          <h2>See it in motion</h2>
          <div className="inline-actions" style={{ justifyContent: 'center' }}>
            <Link className="btn btn-primary btn-lg" to="/join">Join a call</Link>
            <Link className="btn btn-lg mk-cta-ghost" to="/security">Read about security</Link>
          </div>
        </section>
      </main>
    </PublicShell>
  )
}

// ---------------------------------------------------------------------------
// Security page.
// ---------------------------------------------------------------------------
const SECURITY_POINTS = [
  { icon: IconShield, title: 'Access is layered', text: 'Room password, optional invite-only email allowlist (checked after the password so invitations cannot be enumerated), scheduled join windows, and waiting rooms — each enforced server-side.' },
  { icon: IconRecord, title: 'Recording requires consent', text: 'Recorded rooms are acknowledge-to-enter. Media credentials are refused until each participant accepts the current notice, and every consent is stored with its notice version.' },
  { icon: IconVideo, title: 'Short-lived credentials', text: 'Participant tokens live 15 minutes, are stored only as hashes, and are revoked the moment someone disconnects or the room ends. Media tokens are minted only after every gate passes.' },
  { icon: IconUsers, title: 'Role-based administration', text: 'Four roles over 40+ granular permissions separate operators from reviewers from auditors. Admin sessions are HttpOnly cookies with CSRF-protected mutations.' },
  { icon: IconFileText, title: 'Immutable audit trail', text: 'Every consequential action — joins, admissions, recordings, exports, redactions, lifecycle changes — is logged. Message and transcript bodies never appear in the log.' },
  { icon: IconPlug, title: 'Your infrastructure, your data', text: 'Media routes through your own LiveKit server; recordings land in your S3 bucket and are served through short-lived signed URLs. There is no third-party video cloud in the path.' },
]

export function SecurityPage() {
  return (
    <PublicShell>
      <main className="mk-page">
        <header className="mk-page-head">
          <p className="kicker">Security</p>
          <h1>Interviews are sensitive. The platform treats them that way.</h1>
          <p className="mk-lede">Candidates share personal circumstances; panels discuss compensation. Everything below is enforced in code on your own servers — not policy on someone else&apos;s.</p>
        </header>
        <div className="mk-grid">
          {SECURITY_POINTS.map((point) => (
            <article key={point.title} className="card mk-feature">
              <span className="mk-feature-icon"><point.icon /></span>
              <h3>{point.title}</h3>
              <p>{point.text}</p>
            </article>
          ))}
        </div>
        <section className="mk-cta">
          <h2>Want the details?</h2>
          <p>The full security model — hashing, rate limits, CSP, token lifecycles — is documented in the repo and the admin console.</p>
          <div className="inline-actions" style={{ justifyContent: 'center' }}>
            <a className="btn btn-primary btn-lg" href="/admin">Open the console</a>
          </div>
        </section>
      </main>
    </PublicShell>
  )
}
