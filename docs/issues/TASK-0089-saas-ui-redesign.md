# TASK-0089 — Full UI/UX redesign: Zoom-style SaaS product shell

**Type:** improvement (epic, UI/UX only) · **Priority:** high · **Effort:** large
**Status:** delivered 2026-07-12 (see [TASK-0089-plan.md](TASK-0089-plan.md)) · **Created:** 2026-07-12
**Reference:** Zoom web portal screenshots in `/Users/ai/Desktop/webrtc/` (sidebar nav, Meetings tabs, personal-room detail, logs table, profile page)
**Depends on:** TASK-0088 (delivered — all backend capability already exists)

## TL;DR

Redesign the entire app so it looks and feels like a real SaaS product (Zoom web
portal as the model), replacing the current "local demo" panel aesthetic. No
backend changes — this is a presentation-layer rebuild over the existing APIs.
Owner delegates all design decisions to the implementer.

## Current state

- One 2,200-line [src/main.jsx](../../src/main.jsx) + one [src/styles.css](../../src/styles.css); no router (path checks), no component files.
- Public side: single hero + create-room panel; join flow; call room.
- Admin side: one giant dashboard page — profile card, create form, room list,
  and a very long room-detail column stacking every panel (lifecycle, chat,
  transcripts, recordings, embed, audit) vertically.
- No sidebar navigation, no tabs, no tables (rooms are buttons in a list), no
  date filters, no empty-state guidance, no toasts, minimal loading states.

## Expected outcome (Zoom-pattern mapping)

1. **App shell** — persistent left sidebar (sections like Rooms / Recordings /
   Transcripts / Integrations / Audit / Profile) + slim top bar with brand,
   global search, and primary quick actions ("Create room", "Join"). Real
   routing with clean URLs per section.
2. **Rooms page** — tabbed **Upcoming / Previous / All** with date-range
   filter, search, status filter chips, sortable table columns (name, candidate,
   recruiter, schedule, status, occupancy), primary "Create room" CTA opening a
   modal/side-panel wizard, and helpful empty states ("No upcoming interviews —
   create one").
3. **Room detail page** (like Zoom's Personal Room): topic, room ID,
   passcode masked with Show/copy, invite link with copy button, schedule +
   join window, invitees, candidate/recruiter mapping, tabbed sub-sections
   (Details / Recordings / Transcripts / Chat / Waiting room / Audit) instead
   of one endless column. Prominent Start/End call and recording controls.
4. **Recordings & transcripts pages** — global tables across rooms (like Zoom's
   Logs): search, filter dropdowns, sortable columns, per-row play/export
   actions, CSV export.
5. **Profile/login** — polished login screen (centered card, brand), profile
   page showing role/permissions, and consistent header avatar menu (logout).
6. **In-call experience** — Zoom-like: dark stage, bottom control bar with
   labeled icon buttons (mic/cam/share/chat/participants/leave/end), participant
   grid with name chips, collapsible right panel for chat/participants, pre-join
   device-check screen.
7. **Design system** — tokens (color/spacing/type), light theme, consistent
   buttons/inputs/tables/tabs/badges/modals/toasts, loading skeletons,
   responsive down to laptop widths. Component split out of main.jsx.

## Decisions delegated to implementer

Framework additions (e.g. router), component structure, exact palette/branding,
icon set, CSS approach — owner explicitly deferred all UI/UX decisions.

## Relevant files

- [src/main.jsx](../../src/main.jsx) — split into routed pages/components
- [src/styles.css](../../src/styles.css) — replace with design-system styles
- [index.html](../../index.html) — title/meta/fonts

## Risks / notes

- Keep every existing API contract and test green — redesign must not touch
  server behavior (tests are API-level, so UI refactor is low-risk).
- The embed iframe surface (`/embed/rooms/:id`) and its SDK must keep working.
- Bundle size already 750KB (livekit-client); prefer lightweight deps.
- Existing e2e-ish flows to preserve: join gate → consent → call; admin
  create → configure → record → playback.
