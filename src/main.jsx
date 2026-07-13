import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes, useLocation, useParams } from 'react-router-dom'
import './styles.css'
import { RoomFlowPage } from './pages/public.jsx'
import { HowItWorksPage, JoinPage, LandingPage, SecurityPage } from './pages/marketing.jsx'
import { AdminPortal } from './admin/portal.jsx'

// Router entry. The room route reads host credentials handed over from the
// landing page's create flow (navigation state) so a fresh host skips the gate.
function RoomRoute() {
  const location = useLocation()
  const { roomId } = useParams()
  const state = location.state || {}
  const handoff = state.room?.id === roomId ? state : {}
  return <RoomFlowPage key={roomId} initialAccess={handoff.access || null} initialRoom={handoff.room || null} />
}

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/join" element={<JoinPage />} />
      <Route path="/how-it-works" element={<HowItWorksPage />} />
      <Route path="/security" element={<SecurityPage />} />
      <Route path="/rooms/:roomId" element={<RoomRoute />} />
      <Route path="/admin/*" element={<AdminPortal />} />
      <Route path="*" element={<LandingPage />} />
    </Routes>
  </BrowserRouter>,
)
