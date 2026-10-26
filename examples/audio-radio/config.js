// StreamHub example configuration — EDIT THIS FILE.
//
// Example: Radio (master + listener) — Audio radio: master goes on air with the mic; listeners tune in.
//
// Point this bundle at YOUR StreamHub. Nothing else needs to
// change: host this folder on any static host (S3, Netlify, nginx,
// GitHub Pages) and open index.html.
window.STREAMHUB_CONFIG = {
  // StreamHub public origin (REST + HLS + SDK). No trailing slash.
  baseUrl: "https://your-streamhub.example.com",
  // LiveKit signaling WebSocket URL (wss://…).
  wsUrl: "wss://your-streamhub.example.com",
  // Your app slug.
  app: "YOUR_APP",
  // Default room name.
  room: "demo",

  // Ephemeral LiveKit JWT for publishing/joining. Mint it
  // server-side and paste it here, OR pass it in the URL hash
  // (#token=…). Leave empty for subscribe-only usage.
  token: '',

  // DEV ONLY: an sk_ management token to mint LiveKit tokens on
  // the fly. Never ship this to end users — prefer `token` above.
  apiToken: '',

  // Optional: override the adaptor SDK URL (defaults to
  // baseUrl + "/sdk/streamhub-adaptor.global.js").
  // adaptorUrl: '',
};
