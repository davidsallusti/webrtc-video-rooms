// Minimal inline SVG icon set (24x24 viewBox, stroke-based, currentColor) so
// the app carries no icon dependency. Sized via CSS on .icon.
function Icon({ children, ...props }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  )
}

export const IconVideo = (p) => <Icon {...p}><rect x="2" y="6" width="13" height="12" rx="2.5" /><path d="m15 10 6-3.5v11L15 14" /></Icon>
export const IconCalendar = (p) => <Icon {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></Icon>
export const IconMic = (p) => <Icon {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Icon>
export const IconMicOff = (p) => <Icon {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" /></Icon>
export const IconCam = (p) => <Icon {...p}><rect x="2" y="6" width="13" height="12" rx="2.5" /><path d="m15 10 6-3.5v11L15 14" /></Icon>
export const IconCamOff = (p) => <Icon {...p}><rect x="2" y="6" width="13" height="12" rx="2.5" /><path d="m15 10 6-3.5v11L15 14M3 3l18 18" /></Icon>
export const IconScreen = (p) => <Icon {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Icon>
export const IconChat = (p) => <Icon {...p}><path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5Z" /></Icon>
export const IconUsers = (p) => <Icon {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4.5-6.2" /></Icon>
export const IconLeave = (p) => <Icon {...p}><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M9 8l-4 4 4 4M5 12h11" /></Icon>
export const IconRecord = (p) => <Icon {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></Icon>
export const IconCopy = (p) => <Icon {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Icon>
export const IconCheck = (p) => <Icon {...p}><path d="m4 12.5 5 5L20 6.5" /></Icon>
export const IconSearch = (p) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>
export const IconPlus = (p) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>
export const IconPlay = (p) => <Icon {...p}><path d="M7 4.5 19 12 7 19.5Z" /></Icon>
export const IconFileText = (p) => <Icon {...p}><path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM14 2v5h5M9 12h6M9 16h6" /></Icon>
export const IconLink = (p) => <Icon {...p}><path d="M10 14a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1" /></Icon>
export const IconShield = (p) => <Icon {...p}><path d="M12 2 4 5.5v6C4 16.5 7.5 20.5 12 22c4.5-1.5 8-5.5 8-10.5v-6Z" /></Icon>
export const IconSettings = (p) => <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.06-.4.1-.8.1-1.2Z" /></Icon>
export const IconList = (p) => <Icon {...p}><path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01" /></Icon>
export const IconPlug = (p) => <Icon {...p}><path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0ZM12 16v5" /></Icon>
export const IconUser = (p) => <Icon {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Icon>
export const IconLogout = (p) => <Icon {...p}><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M8 12h11" /></Icon>
export const IconChevronDown = (p) => <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>
export const IconX = (p) => <Icon {...p}><path d="M5 5l14 14M19 5 5 19" /></Icon>
export const IconEye = (p) => <Icon {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></Icon>
export const IconClock = (p) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></Icon>
export const IconDownload = (p) => <Icon {...p}><path d="M12 3v12M7 10l5 5 5-5M4 21h16" /></Icon>
export const IconGrid = (p) => <Icon {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></Icon>
export const IconSpinner = (p) => <Icon className="icon icon-spin" {...p}><path d="M12 3a9 9 0 1 0 9 9" /></Icon>
