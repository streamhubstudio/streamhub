/**
 * Route table. Authenticated pages live under <ProtectedRoute>; the management
 * pages additionally render inside <AppLayout> (sidebar chrome). Player and
 * Meeting are full-screen (no sidebar) but still require auth to mint tokens.
 */
import { Navigate, Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from '@/auth/ProtectedRoute'
import { AppLayout } from '@/layout/AppLayout'
import Login from '@/pages/Login'
import Signup from '@/pages/Signup'
import AuthMagic from '@/pages/AuthMagic'
import Account from '@/pages/Account'
import Dashboard from '@/pages/Dashboard'
import Apps from '@/pages/Apps'
import AppDetail from '@/pages/AppDetail'
import Marketplace from '@/pages/Marketplace'
import Logs from '@/pages/Logs'
import Cluster from '@/pages/Cluster'
import ServerSettings from '@/pages/ServerSettings'
import Player from '@/pages/Player'
import PlayPublic from '@/pages/PlayPublic'
import Embed from '@/pages/Embed'
import Meeting from '@/pages/Meeting'
import Broadcast from '@/pages/Broadcast'
import Radio from '@/pages/Radio'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      {/* PUBLIC signup + onboarding. Only functional when the deployment
          enables self-signup (GET /auth/config → allowSignup); otherwise it
          explains access is invite-only. */}
      <Route path="/signup" element={<Signup />} />

      {/* PUBLIC magic-link verification. Reads ?token= from the emailed link,
          exchanges it for a session JWT, then redirects to the dashboard. */}
      <Route path="/auth/magic" element={<AuthMagic />} />

      {/* PUBLIC player surfaces (no auth guard). They fetch the public
          play-token (GET /apps/:app/play-token/:room) and connect to LiveKit
          without any login: /play = full player + share panel, /embed = bare
          iframe-friendly player. */}
      <Route path="play/:app/:room" element={<PlayPublic />} />
      <Route path="embed/:app/:room" element={<Embed />} />

      <Route element={<ProtectedRoute />}>
        {/* Management shell (sidebar + header) */}
        <Route element={<AppLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="apps" element={<Apps />} />
          <Route path="apps/:app" element={<AppDetail />} />
          <Route path="plugins" element={<Marketplace />} />
          <Route path="account" element={<Account />} />
          <Route path="cluster" element={<Cluster />} />
          <Route path="logs" element={<Logs />} />
          <Route path="settings" element={<ServerSettings />} />
        </Route>

        {/* Full-screen WebRTC surfaces */}
        <Route path="player/:app/:room" element={<Player />} />
        <Route path="meeting/:app/:room" element={<Meeting />} />
        <Route path="broadcast/:app" element={<Broadcast />} />
        <Route path="radio/:app/:room" element={<Radio />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
