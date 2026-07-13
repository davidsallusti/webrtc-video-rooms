# Feature Implementation Plan — TASK-0089 Zoom-style SaaS UI redesign

**Overall Progress:** `100%` — delivered; lint/build clean, suite 38/38, visual walkthrough done

Companion docs: [issue](TASK-0089-saas-ui-redesign.md)

## TLDR

Rebuild the presentation layer as a real SaaS product modeled on the Zoom web
portal: routed app shell with sidebar navigation, table-driven admin pages,
tabbed room detail, polished login, and a dark Zoom-like in-call experience.
Logic and API contracts are ported, not changed; the only server additions are
two read-only admin list endpoints (recordings/transcripts across rooms) that
the new global tables need.

## Critical Decisions

- **react-router-dom** for real URLs (`/admin/rooms/:id` etc.); Vite SPA
  fallback and the express `*` catch-all already support it.
- **Hand-rolled design system** in plain CSS (tokens + components), no Tailwind
  — matches the repo's no-framework CSS convention; Zoom-like palette
  (blue #0B5CFF primary, white surfaces, gray neutrals), Inter/system stack.
- **Inline SVG icon set** — no icon dependency.
- **Component split**: `src/lib/` (api, hooks), `src/ui/` (primitives),
  `src/pages/` (public), `src/admin/` (portal). `main.jsx` becomes the router
  entry. `src/styles.css` stays the single stylesheet.
- **Global recordings/transcripts tables** get two new RBAC-gated read-only
  endpoints (`GET /api/admin/recordings`, `GET /api/admin/transcripts`) instead
  of N-per-room fan-out from the browser.
- Embed surface (`/embed/rooms/:id`) and all existing API behavior untouched.

## Tasks:

- [x] 🟩 **Step 1: Foundation**
  - [x] 🟩 Add react-router-dom; entry `main.jsx` → routes
  - [x] 🟩 `src/lib/api.js` (api/adminApi/clipboard/format helpers), `src/ui/icons.jsx`
  - [x] 🟩 `src/ui/kit.jsx`: Button-free primitives — Tabs, Modal, Toast context, EmptyState, Badge, CopyField, DataTable, Field
  - [x] 🟩 New `styles.css` design system: tokens, base, buttons, inputs, tables, tabs, badges, modals, toasts, skeletons

- [x] 🟩 **Step 2: Public experience**
  - [x] 🟩 Landing page: SaaS hero + join-by-link card + create-room card
  - [x] 🟩 Join gate: centered card flow (email/name/password), join-window notice, waiting room state
  - [x] 🟩 Pre-join device check screen (camera preview, mic indicator) before entering the call
  - [x] 🟩 Call room: dark stage, participant grid with name chips, bottom control bar with labeled icon buttons, collapsible right panel (chat / notices), consent gate state

- [x] 🟩 **Step 3: Admin shell & login**
  - [x] 🟩 Login page: centered brand card, error states, bootstrap/setup flow
  - [x] 🟩 AppShell: left sidebar (permission-filtered nav), top bar (search-less, quick actions, avatar menu with logout)
  - [x] 🟩 AdminContext: session/user/csrf + api helpers shared by pages

- [x] 🟩 **Step 4: Admin pages**
  - [x] 🟩 Rooms: Upcoming/Previous/All tabs, search + status filter, sortable table, create-room modal wizard, empty states
  - [x] 🟩 Room detail: header with status/actions (Copy link, End for all), Details/Recordings/Transcripts/Chat/Waiting/Embed/Audit tabs porting all existing panels
  - [x] 🟩 Recordings page: global table (new endpoint), filters, play/transcribe actions
  - [x] 🟩 Transcripts page: global table (new endpoint), export/redact via room links
  - [x] 🟩 Integrations page (port existing panel), Audit page (global feed), Profile page (roles/permissions)

- [x] 🟩 **Step 5: Server list endpoints**
  - [x] 🟩 `listAllRecordings` / `listAllTranscripts` store functions (+ room name join)
  - [x] 🟩 `GET /api/admin/recordings`, `GET /api/admin/transcripts` behind `recordings:view` / `transcripts:view`

- [x] 🟩 **Step 6: Verification & polish**
  - [x] 🟩 Lint, build, full test suite green
  - [x] 🟩 Preview walkthrough: landing, join, admin login, rooms table, room detail tabs, call screen; fix visual defects
  - [x] 🟩 Update plan/progress docs
