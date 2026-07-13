import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useClipboard } from '../lib/api.js'
import { IconCheck, IconCopy, IconSearch, IconX } from './icons.jsx'

// ---------------------------------------------------------------------------
// Toasts — one provider at the app root; useToast() anywhere below it.
// ---------------------------------------------------------------------------
const ToastContext = createContext(() => {})

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const push = useCallback((message, tone = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setToasts((current) => [...current, { id, message, tone }])
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>{toast.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}

// ---------------------------------------------------------------------------
// Modal — centered dialog with backdrop; Escape and backdrop click close.
// ---------------------------------------------------------------------------
export function Modal({ title, onClose, children, wide = false }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}><IconX /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tabs — Zoom-style underline tabs. items: [{ key, label, count? }]
// ---------------------------------------------------------------------------
export function Tabs({ items, active, onChange }) {
  return (
    <nav className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={active === item.key}
          className={`tab${active === item.key ? ' tab-active' : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
          {item.count != null ? <span className="tab-count">{item.count}</span> : null}
        </button>
      ))}
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Status badge — room/artifact statuses to tones.
// ---------------------------------------------------------------------------
const STATUS_TONES = {
  active: 'green',
  finalized: 'green',
  admitted: 'green',
  acknowledged: 'green',
  connected: 'green',
  locked: 'amber',
  waiting: 'amber',
  mock_active: 'amber',
  processing: 'amber',
  ended: 'gray',
  expired: 'gray',
  disabled: 'gray',
  deleted: 'gray',
  mock_finalized: 'gray',
  failed: 'red',
  mock_failed: 'red',
  rejected: 'red',
}

export function StatusBadge({ status }) {
  const tone = STATUS_TONES[status] || 'gray'
  return <span className={`badge badge-cap badge-${tone}`}>{String(status || '—').replaceAll('_', ' ')}</span>
}

export function Badge({ tone = 'gray', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

// ---------------------------------------------------------------------------
// EmptyState — table/section placeholder with optional action.
// ---------------------------------------------------------------------------
export function EmptyState({ icon: IconComponent, title, text, action }) {
  return (
    <div className="empty-state">
      {IconComponent ? <div className="empty-icon"><IconComponent /></div> : null}
      <strong>{title}</strong>
      {text ? <p>{text}</p> : null}
      {action || null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CopyField — value with a copy button (invite links, ids, passcodes).
// ---------------------------------------------------------------------------
export function CopyField({ value, masked = false, label }) {
  const clipboard = useClipboard()
  const [revealed, setRevealed] = useState(false)
  const display = masked && !revealed ? '••••••••' : value
  return (
    <span className="copy-field">
      <code>{display}</code>
      {masked ? (
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => setRevealed((current) => !current)}>
          {revealed ? 'Hide' : 'Show'}
        </button>
      ) : null}
      <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label={`Copy ${label || 'value'}`} onClick={() => clipboard.copy(value)}>
        {clipboard.copied ? <IconCheck /> : <IconCopy />}
      </button>
    </span>
  )
}

// ---------------------------------------------------------------------------
// DataTable — sortable columns, row click, empty state.
// columns: [{ key, label, sortable?, render?(row), width? }]
// ---------------------------------------------------------------------------
export function DataTable({ columns, rows, rowKey, onRowClick, empty }) {
  const [sort, setSort] = useState(null) // { key, dir }
  const sorted = useMemo(() => {
    if (!sort) return rows
    const factor = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const left = a[sort.key] ?? ''
      const right = b[sort.key] ?? ''
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor
      return String(left).localeCompare(String(right)) * factor
    })
  }, [rows, sort])

  if (!rows.length && empty) return empty

  const toggleSort = (key) => {
    setSort((current) => {
      if (current?.key !== key) return { key, dir: 'asc' }
      if (current.dir === 'asc') return { key, dir: 'desc' }
      return null
    })
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={column.width ? { width: column.width } : undefined}>
                {column.sortable ? (
                  <button type="button" className="th-sort" onClick={() => toggleSort(column.key)}>
                    {column.label}
                    <span className="sort-arrow">{sort?.key === column.key ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
                  </button>
                ) : column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? 'row-clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((column) => (
                <td key={column.key}>{column.render ? column.render(row) : (row[column.key] ?? '—')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SearchInput — icon-decorated text input used above tables.
// ---------------------------------------------------------------------------
export function SearchInput({ value, onChange, placeholder = 'Search' }) {
  return (
    <span className="search-input">
      <IconSearch />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Field — labeled form control wrapper.
// ---------------------------------------------------------------------------
export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

export function Avatar({ name, size = 32 }) {
  const initials = String(name || '?').split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()
  return <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }}>{initials}</span>
}

export function Skeleton({ lines = 3 }) {
  return (
    <div className="skeleton-block" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => <div key={index} className="skeleton-line" />)}
    </div>
  )
}
