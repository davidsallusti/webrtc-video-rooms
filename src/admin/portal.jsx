import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { adminApi } from '../lib/api.js'
import { Avatar, Field, Skeleton, ToastProvider } from '../ui/kit.jsx'
import {
  IconChevronDown, IconFileText, IconList, IconLogout, IconPlug, IconRecord,
  IconSettings, IconUser, IconUsers, IconVideo,
} from '../ui/icons.jsx'
import { RoomsPage } from './rooms.jsx'
import { RoomDetailPage } from './room-detail.jsx'
import { AuditPage, IntegrationsPage, ProfilePage, RecordingsPage, TeamPage, TranscriptsPage } from './misc-pages.jsx'
import { DeploymentPage } from './deployment.jsx'

// ---------------------------------------------------------------------------
// Admin session context — bootstrap/session state plus a csrf-bound fetch.
// ---------------------------------------------------------------------------
const AdminContext = createContext(null)

export function useAdmin() {
  return useContext(AdminContext)
}

export function AdminPortal() {
  const [bootstrap, setBootstrap] = useState(null)
  const [user, setUser] = useState(null)
  const [csrfToken, setCsrfToken] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      adminApi('/api/admin/bootstrap/status'),
      adminApi('/api/admin/session'),
    ]).then(([bootstrapResult, sessionResult]) => {
      if (cancelled) return
      if (bootstrapResult.status === 'fulfilled') setBootstrap(bootstrapResult.value)
      if (sessionResult.status === 'fulfilled') {
        setUser(sessionResult.value.user)
        setCsrfToken(sessionResult.value.csrfToken)
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const onAuthed = useCallback((body) => {
    setUser(body.user)
    setCsrfToken(body.csrfToken)
  }, [])

  const logout = useCallback(async () => {
    await adminApi('/api/admin/logout', { method: 'POST', csrfToken })
    setUser(null)
    setCsrfToken('')
    const status = await adminApi('/api/admin/bootstrap/status').catch(() => null)
    if (status) setBootstrap(status)
  }, [csrfToken])

  const context = useMemo(() => ({
    user,
    csrfToken,
    logout,
    can: (permission) => Boolean(user?.permissions?.includes(permission)),
    // csrf-bound mutation helper so pages never touch the token directly.
    call: (path, options = {}) => adminApi(path, { ...options, csrfToken }),
  }), [csrfToken, logout, user])

  if (loading) {
    return <div className="auth-page"><div className="auth-card"><Skeleton lines={4} /></div></div>
  }
  if (!user) return <LoginPage bootstrap={bootstrap} onAuthed={onAuthed} />
  if (user.setupRequired) return <SetupPage csrfToken={csrfToken} onAuthed={onAuthed} />

  return (
    <AdminContext.Provider value={context}>
      <ToastProvider>
        <AppShell>
          <Routes>
            <Route index element={<Navigate to="rooms" replace />} />
            <Route path="rooms" element={<RoomsPage />} />
            <Route path="rooms/:roomId" element={<RoomDetailPage />} />
            <Route path="recordings" element={<RecordingsPage />} />
            <Route path="transcripts" element={<TranscriptsPage />} />
            <Route path="integrations" element={<IntegrationsPage />} />
            <Route path="team" element={<TeamPage />} />
            <Route path="deployment" element={<DeploymentPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="*" element={<Navigate to="rooms" replace />} />
          </Routes>
        </AppShell>
      </ToastProvider>
    </AdminContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Login / first-run setup — centered brand cards.
// ---------------------------------------------------------------------------
function AuthFrame({ subtitle, children, footer }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" style={{ width: 42, height: 42 }}><IconVideo /></span>
          <h1>InterviewRooms Admin</h1>
          <p>{subtitle}</p>
        </div>
        {children}
        {footer ? <p className="auth-foot">{footer}</p> : null}
      </div>
    </div>
  )
}

function LoginPage({ bootstrap, onAuthed }) {
  const isBootstrap = bootstrap?.bootstrapRequired
  const [email, setEmail] = useState(bootstrap?.bootstrapEmail || '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (bootstrap?.bootstrapEmail) setEmail(bootstrap.bootstrapEmail)
  }, [bootstrap])

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const endpoint = isBootstrap ? '/api/admin/bootstrap/login' : '/api/admin/login'
      const body = await adminApi(endpoint, { method: 'POST', body: JSON.stringify({ email, password }) })
      onAuthed(body)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame
      subtitle={isBootstrap ? 'First run — sign in with the bootstrap credential' : 'Sign in to manage interview rooms'}
      footer="Admin sessions are cookie-based and isolated from room participants."
    >
      <form onSubmit={submit}>
        {bootstrap && bootstrap.bootstrapAvailable === false ? <p className="form-error">{bootstrap.reason}</p> : null}
        <Field label="Email">
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required />
        </Field>
        <Field label="Password">
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
        </Field>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy || bootstrap?.bootstrapAvailable === false}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthFrame>
  )
}

function SetupPage({ csrfToken, onAuthed }) {
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = await adminApi('/api/admin/setup/password', {
        method: 'POST',
        csrfToken,
        body: JSON.stringify({ newPassword }),
      })
      onAuthed(body)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame subtitle="Rotate the bootstrap password to finish setup">
      <form onSubmit={submit}>
        <Field label="New admin password" hint="Minimum 12 characters.">
          <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength="12" autoComplete="new-password" required />
        </Field>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Finish setup'}</button>
      </form>
    </AuthFrame>
  )
}

// ---------------------------------------------------------------------------
// App shell — topbar + permission-filtered sidebar.
// ---------------------------------------------------------------------------
const NAV = [
  { to: 'rooms', label: 'Rooms', icon: IconVideo, permission: 'rooms:view_all' },
  { to: 'recordings', label: 'Recordings', icon: IconRecord, permission: 'recordings:view' },
  { to: 'transcripts', label: 'Transcripts', icon: IconFileText, permission: 'transcripts:view' },
  { to: 'integrations', label: 'Integrations', icon: IconPlug, permission: 'integrations:view' },
  { to: 'team', label: 'Team', icon: IconUsers, permission: 'admin_users:manage' },
  { to: 'deployment', label: 'Deployment', icon: IconSettings, permission: null },
  { to: 'audit', label: 'Audit log', icon: IconList, permission: 'audit:view' },
  { to: 'profile', label: 'Profile', icon: IconUser, permission: null },
]

function AppShell({ children }) {
  const { user, can, logout } = useAdmin()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!menuOpen) return undefined
    const onClick = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  return (
    <div className="shell">
      <header className="shell-topbar">
        <NavLink className="brand" to="/admin/rooms">
          <span className="brand-mark"><IconVideo /></span>
          InterviewRooms
        </NavLink>
        <div className="topbar-actions">
          <a className="btn btn-ghost" href="/" target="_blank" rel="noreferrer">Open join page</a>
          <div className="user-menu" ref={menuRef}>
            <button type="button" className="user-menu-trigger" onClick={() => setMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={menuOpen}>
              <Avatar name={user.displayName} size={30} />
              <IconChevronDown />
            </button>
            {menuOpen ? (
              <div className="user-menu-pop" role="menu">
                <div className="user-menu-head">
                  <strong>{user.displayName}</strong>
                  <span>{user.email}</span>
                </div>
                <NavLink className="user-menu-item" to="/admin/profile" onClick={() => setMenuOpen(false)}><IconUser /> Profile</NavLink>
                <button type="button" className="user-menu-item" onClick={logout}><IconLogout /> Sign out</button>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <nav className="shell-sidebar" aria-label="Main navigation">
        <p className="side-section">Manage</p>
        {NAV.filter((item) => !item.permission || can(item.permission)).map((item) => (
          // Absolute paths: relative links would resolve against nested room
          // routes (/admin/rooms/:id) and stack segments on every click.
          <NavLink key={item.to} to={`/admin/${item.to}`} className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}>
            <item.icon />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <main className="shell-main">
        <div className="page">{children}</div>
      </main>
    </div>
  )
}
