/**
 * Wave-4 §3 sample templates.
 *
 * Each template is a self-contained HTML page wired to ONE app via placeholders
 * resolved at generation time:
 *   {{APP}}        app slug
 *   {{WS_URL}}     public LiveKit ws URL (wss://…)
 *   {{API_URL}}    REST API base (https://…/api/v1)
 *   {{ADAPTOR_URL}} streamhub-adaptor UMD (served at /sdk/streamhub-adaptor.global.js)
 *   {{HLS_URL}}    HLS base for the app (https://…/hls/<app>) — room appended client-side
 *   {{ROOM}}       default room (the app room prefix)
 *
 * The WebRTC pages prefer the streamhub-adaptor (AntMedia-style `WebRTCAdaptor`)
 * when it loads, and gracefully fall back to the bundled livekit-client CDN so
 * the demo works even before the adaptor build is deployed.
 */

export type SampleTemplateName =
  | 'webrtc-publish.html'
  | 'webrtc-play.html'
  | 'hls-player.html'
  | 'audio-radio.html'
  // G4 turnkey verticals — one self-contained page per use case, wired to the
  // app. Subscribe-only pages use the PUBLIC play/listen tokens (no auth);
  // publish/interactive pages accept an ephemeral LiveKit token in the URL
  // (`#token=…&ws=…&room=…`) minted server-side by the operator.
  | 'cctv-grid.html'
  | 'live-shopping.html'
  | 'telemedicine.html'
  | 'radio-player.html'
  | 'conference.html';

export const SAMPLE_FILES: SampleTemplateName[] = [
  'webrtc-publish.html',
  'webrtc-play.html',
  'hls-player.html',
  'audio-radio.html',
  'cctv-grid.html',
  'live-shopping.html',
  'telemedicine.html',
  'radio-player.html',
  'conference.html',
];

// livekit-client is PINNED to 2.15.7 — validated end-to-end (publish + subscribe +
// data) against livekit-server 1.8.4 on node01. Do NOT float this URL: an unpinned
// jsdelivr path resolves to whatever is latest (2.20+ today), which CANNOT PUBLISH
// against server 1.8.4 (track publication never resolves; negotiation times out).
// server 1.8.4 <-> client 2.15.7 are a validated pair — upgrade BOTH in lockstep
// (roadmap note). The pin is enforced by the invariant in
// samples.new-templates.spec.ts.
const LIVEKIT_CDN =
  'https://cdn.jsdelivr.net/npm/livekit-client@2.15.7/dist/livekit-client.umd.min.js';
const VIDEOJS_CSS = 'https://vjs.zencdn.net/8.10.0/video-js.css';
const VIDEOJS_JS = 'https://vjs.zencdn.net/8.10.0/video.min.js';
const VIDEOJS_HLS =
  'https://cdn.jsdelivr.net/npm/@videojs/http-streaming@3/dist/videojs-http-streaming.min.js';

const STYLE = `:root{color-scheme:dark}
body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e6ecff}
header{padding:14px 18px;background:#121a33;border-bottom:1px solid #1f2b4d}
header b{color:#6ea8ff}
main{padding:18px;max-width:960px;margin:0 auto}
video{width:100%;max-height:70vh;background:#000;border-radius:10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
button{background:#2d6cff;color:#fff;border:0;padding:9px 16px;border-radius:8px;cursor:pointer;font-weight:600}
button.alt{background:#1f2b4d}
button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}
input,select{background:#0e1530;color:#e6ecff;border:1px solid #25325a;border-radius:8px;padding:8px 10px}
label{opacity:.8}
.log{margin-top:12px;padding:10px;background:#0e1530;border-radius:8px;font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap;min-height:40px}
.live{display:inline-block;padding:2px 8px;border-radius:6px;background:#c0263a;color:#fff;font-weight:700;font-size:11px;letter-spacing:.5px}
.muted{opacity:.7}`;

function head(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>`;
}

/** Shared bootstrap: app constants + token fetch + adaptor/livekit loaders. */
function bootstrap(): string {
  return `
  const APP = '{{APP}}';
  const WS_URL = '{{WS_URL}}';
  const API_URL = '{{API_URL}}';
  const ADAPTOR_URL = '{{ADAPTOR_URL}}';
  const HLS_BASE = '{{HLS_URL}}';
  function logTo(id){const el=document.getElementById(id);return (m)=>{if(el)el.textContent=String(m);};}
  function rid(p){return p + Math.random().toString(36).slice(2,8);}
  function nsRoom(r){ return r || '{{ROOM}}'; }
  // Read a param from the query string OR the URL hash (so operators can share
  // a link like  page.html#room=consulta&token=<jwt>&ws=wss://host  without the
  // token ever hitting a server log).
  function qp(k){ try{
    const u = new URL(location.href);
    const h = new URLSearchParams((location.hash||'').replace(/^#/,''));
    return u.searchParams.get(k) || h.get(k) || '';
  }catch(e){ return ''; } }
  // Ephemeral (pre-minted) LiveKit credentials from the URL, or null.
  function ephemeral(){
    const token = qp('token');
    return token ? { token: token, wsUrl: qp('ws') || qp('wsUrl') || WS_URL, room: qp('room') } : null;
  }
  async function getToken(opts){
    const headers = { 'Content-Type':'application/json' };
    // Optional management bearer for minting (dev / operator links). Omitted in
    // production embeds — those use the public/ephemeral flows below.
    const bearer = qp('apitoken') || qp('bearer');
    if (bearer) headers['Authorization'] = 'Bearer ' + bearer;
    const res = await fetch(API_URL + '/apps/' + APP + '/tokens', {
      method:'POST', headers: headers, body: JSON.stringify(opts)
    });
    if(!res.ok) throw new Error('token request failed: ' + res.status);
    const body = await res.json();
    const d = body && body.data ? body.data : body;
    return { token: d.token || d, wsUrl: d.wsUrl || WS_URL };
  }
  // Public subscribe-only VIDEO+AUDIO token (no auth). Powers the turnkey
  // viewer pages; gated server-side by the app 'publicPlayback' feature.
  async function playToken(roomName){
    const res = await fetch(API_URL + '/apps/' + APP + '/play-token/' + encodeURIComponent(roomName));
    if(!res.ok) throw new Error('play-token failed: ' + res.status);
    const b = await res.json(); const d = b && b.data ? b.data : b;
    return { token: d.token || d, wsUrl: d.wsUrl || WS_URL, room: d.room || roomName };
  }
  // Public subscribe-only AUDIO token for a radio room (no auth).
  async function radioListenToken(roomName){
    const res = await fetch(API_URL + '/apps/' + APP + '/radio/' + encodeURIComponent(roomName) + '/listen-token');
    if(!res.ok) throw new Error('listen-token failed: ' + res.status);
    const b = await res.json(); const d = b && b.data ? b.data : b;
    return { token: d.token || d, wsUrl: d.wsUrl || WS_URL, room: d.room || roomName };
  }
  // Optional: load the streamhub-adaptor (AntMedia-style) when present.
  function loadScript(src){return new Promise((ok)=>{const s=document.createElement('script');s.src=src;s.onload=()=>ok(true);s.onerror=()=>ok(false);document.head.appendChild(s);});}`;
}

export const TEMPLATES: Record<SampleTemplateName, string> = {
  'webrtc-publish.html': `${head('StreamHub · WebRTC publish · {{APP}}')}
<header><b>StreamHub</b> · WebRTC publish · app <b>{{APP}}</b></header>
<main>
  <div class="row">
    <label>room <input id="room" value="{{ROOM}}" /></label>
    <label>identity <input id="identity" value="" placeholder="auto" /></label>
    <label><input type="checkbox" id="audioOnly" /> audio only</label>
  </div>
  <div class="row">
    <button id="go">Start publishing</button>
    <button id="stop" class="alt" disabled>Stop</button>
  </div>
  <video id="local" autoplay muted playsinline></video>
  <div class="log" id="log">idle</div>
</main>
<script src="${LIVEKIT_CDN}"></script>
<script>
${bootstrap()}
const log = logTo('log');
let room;
document.getElementById('go').onclick = async () => {
  try {
    await loadScript(ADAPTOR_URL); // best-effort; falls back to livekit-client
    const audioOnly = document.getElementById('audioOnly').checked;
    const roomName = nsRoom(document.getElementById('room').value.trim());
    const identity = document.getElementById('identity').value.trim() || rid('publisher-');
    log('requesting token...');
    const { token, wsUrl } = await getToken({ room: roomName, identity, canPublish:true, canSubscribe:true, audioOnly });
    room = new LivekitClient.Room({ adaptiveStream:true, dynacast:true });
    await room.connect(wsUrl, token);
    if (audioOnly) { await room.localParticipant.setMicrophoneEnabled(true); }
    else {
      await room.localParticipant.enableCameraAndMicrophone();
      const pub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
      if (pub && pub.track) pub.track.attach(document.getElementById('local'));
    }
    document.getElementById('go').disabled = true;
    document.getElementById('stop').disabled = false;
    log('publishing live to room ' + roomName + (audioOnly ? ' (audio only)' : ''));
  } catch (e) { log('error: ' + (e && e.message ? e.message : e)); }
};
document.getElementById('stop').onclick = async () => {
  try { if (room) await room.disconnect(); } catch (e) {}
  document.getElementById('go').disabled = false;
  document.getElementById('stop').disabled = true;
  log('stopped');
};
</script>
</body></html>`,

  'webrtc-play.html': `${head('StreamHub · WebRTC play · {{APP}}')}
<header><b>StreamHub</b> · WebRTC play (low latency) · app <b>{{APP}}</b></header>
<main>
  <div class="row">
    <label>room <input id="room" value="{{ROOM}}" /></label>
    <button id="go">Play live</button>
  </div>
  <div class="grid" id="remotes"></div>
  <div class="log" id="log">idle</div>
</main>
<script src="${LIVEKIT_CDN}"></script>
<script>
${bootstrap()}
const log = logTo('log');
function attach(track){
  const el = track.attach();
  if (track.kind === 'video') { el.autoplay=true; el.playsInline=true; el.style.width='100%'; el.style.borderRadius='10px'; document.getElementById('remotes').appendChild(el); }
  else { el.autoplay=true; document.body.appendChild(el); }
}
document.getElementById('go').onclick = async () => {
  try {
    await loadScript(ADAPTOR_URL);
    const roomName = nsRoom(document.getElementById('room').value.trim());
    log('requesting token...');
    const { token, wsUrl } = await getToken({ room: roomName, identity: rid('viewer-'), canPublish:false, canSubscribe:true });
    const room = new LivekitClient.Room({ adaptiveStream:true });
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (t)=>attach(t));
    await room.connect(wsUrl, token);
    log('connected — waiting for tracks in ' + roomName);
    room.remoteParticipants.forEach((p)=>p.trackPublications.forEach((pub)=>{ if(pub.track) attach(pub.track); }));
  } catch (e) { log('error: ' + (e && e.message ? e.message : e)); }
};
</script>
</body></html>`,

  'hls-player.html': `${head('StreamHub · HLS player · {{APP}}')}
<header><b>StreamHub</b> · HLS player (video.js) · app <b>{{APP}}</b></header>
<main>
  <div class="row">
    <label>room <input id="room" value="{{ROOM}}" /></label>
    <button id="go">Load HLS</button>
  </div>
  <video id="player" class="video-js vjs-default-skin" controls preload="auto" playsinline></video>
  <div class="log" id="log">idle</div>
</main>
<link href="${VIDEOJS_CSS}" rel="stylesheet" />
<script src="${VIDEOJS_JS}"></script>
<script src="${VIDEOJS_HLS}"></script>
<script>
${bootstrap()}
const log = logTo('log');
let vjs;
document.getElementById('go').onclick = () => {
  try {
    const roomName = nsRoom(document.getElementById('room').value.trim());
    const src = HLS_BASE + '/' + encodeURIComponent(roomName) + '/index.m3u8';
    if (!vjs) vjs = videojs('player', { fluid:true, liveui:true });
    vjs.src({ src, type:'application/x-mpegURL' });
    vjs.play().catch(()=>{});
    log('playing ' + src);
  } catch (e) { log('error: ' + (e && e.message ? e.message : e)); }
};
</script>
</body></html>`,

  'audio-radio.html': `${head('StreamHub · Radio · {{APP}}')}
<header><b>StreamHub</b> · Radio (audio) · app <b>{{APP}}</b> <span id="livebadge" class="live" style="display:none">EN VIVO</span></header>
<main>
  <div class="row">
    <label>room <input id="room" value="{{ROOM}}" /></label>
    <label>mode
      <select id="mode"><option value="listener">listener</option><option value="master">master</option></select>
    </label>
  </div>
  <div class="row">
    <button id="go">Connect</button>
    <button id="stop" class="alt" disabled>Disconnect</button>
    <span id="count" class="muted"></span>
  </div>
  <div class="log" id="log">idle — listener mode just plays the live audio; master mode goes on air with your mic.</div>
</main>
<script src="${LIVEKIT_CDN}"></script>
<script>
${bootstrap()}
const log = logTo('log');
const badge = document.getElementById('livebadge');
const count = document.getElementById('count');
let room;
function updateCount(){ if(!room) return; let n=0; room.remoteParticipants.forEach(()=>n++); count.textContent = n + ' listening'; }
async function listenToken(roomName){
  const res = await fetch(API_URL + '/apps/' + APP + '/radio/' + encodeURIComponent(roomName) + '/listen-token');
  if(!res.ok) throw new Error('listen-token failed: ' + res.status);
  const body = await res.json(); const d = body && body.data ? body.data : body;
  return { token: d.token || d, wsUrl: d.wsUrl || WS_URL };
}
document.getElementById('go').onclick = async () => {
  try {
    const mode = document.getElementById('mode').value;
    const roomName = nsRoom(document.getElementById('room').value.trim());
    let token, wsUrl;
    if (mode === 'master') {
      log('going on air...');
      ({ token, wsUrl } = await getToken({ room: roomName, identity: rid('master-'), canPublish:true, canSubscribe:true, audioOnly:true }));
    } else {
      log('tuning in...');
      ({ token, wsUrl } = await listenToken(roomName));
    }
    room = new LivekitClient.Room({ adaptiveStream:true });
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (t)=>{ if(t.kind==='audio'){ const el=t.attach(); el.autoplay=true; document.body.appendChild(el);} });
    room.on(LivekitClient.RoomEvent.ParticipantConnected, updateCount);
    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, updateCount);
    await room.connect(wsUrl, token);
    if (mode === 'master') { await room.localParticipant.setMicrophoneEnabled(true); badge.style.display='inline-block'; log('ON AIR on ' + roomName); }
    else { badge.style.display='inline-block'; log('LIVE — listening to ' + roomName); }
    updateCount();
    document.getElementById('go').disabled = true;
    document.getElementById('stop').disabled = false;
  } catch (e) { log('error: ' + (e && e.message ? e.message : e)); }
};
document.getElementById('stop').onclick = async () => {
  try { if (room) await room.disconnect(); } catch(e){}
  badge.style.display='none'; count.textContent='';
  document.getElementById('go').disabled = false;
  document.getElementById('stop').disabled = true;
  log('disconnected');
};
</script>
</body></html>`,

  // ===========================================================================
  // G4 turnkey verticals
  // ===========================================================================

  // CCTV low-latency — a grid of live cameras. Each cell subscribes (WebRTC,
  // low latency) to one room with a PUBLIC play token; no login needed. This is
  // the standalone, embeddable twin of the cockpit panel.
  'cctv-grid.html': `${head('StreamHub · CCTV · {{APP}}')}
<header><b>StreamHub</b> · CCTV baja latencia · app <b>{{APP}}</b></header>
<style>
#cctv{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
.cam{position:relative;background:#000;border-radius:10px;overflow:hidden;aspect-ratio:16/9}
.cam video{width:100%;height:100%;object-fit:cover;background:#000}
.cam .lbl{position:absolute;top:6px;left:8px;z-index:2;background:rgba(0,0,0,.55);padding:2px 8px;border-radius:6px;font-size:12px}
</style>
<main>
  <p class="muted">Grilla de cámaras en vivo por WebRTC (subscribe de N salas). Ingresá los nombres de sala separados por coma; cada celda usa un token público de reproducción.</p>
  <div class="row">
    <label>rooms <input id="rooms" value="{{ROOM}}" style="min-width:280px" placeholder="cam1,cam2,cam3" /></label>
    <button id="go">Conectar</button>
    <button id="stop" class="alt" disabled>Desconectar</button>
    <span id="status" class="muted"></span>
  </div>
  <div id="cctv"></div>
  <div class="log" id="log">idle</div>
</main>
<script src="${LIVEKIT_CDN}"></script>
<script>
${bootstrap()}
const log = logTo('log');
const gridEl = document.getElementById('cctv');
let rooms = [];
function cell(name){
  const wrap = document.createElement('div'); wrap.className='cam';
  const v = document.createElement('video'); v.autoplay=true; v.muted=true; v.playsInline=true;
  const l = document.createElement('div'); l.className='lbl'; l.textContent=name;
  wrap.appendChild(v); wrap.appendChild(l); gridEl.appendChild(wrap);
  return v;
}
async function connectRoom(name){
  const v = cell(name);
  try {
    const { token, wsUrl } = await playToken(name);
    const room = new LivekitClient.Room({ adaptiveStream:true });
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (t)=>{ if(t.kind==='video') t.attach(v); });
    await room.connect(wsUrl, token);
    room.remoteParticipants.forEach((p)=>p.trackPublications.forEach((pub)=>{ if(pub.track && pub.track.kind==='video') pub.track.attach(v); }));
    rooms.push(room);
  } catch (e) { log('sala ' + name + ' error: ' + (e && e.message ? e.message : e)); }
}
document.getElementById('go').onclick = async () => {
  await loadScript(ADAPTOR_URL);
  gridEl.innerHTML=''; rooms=[];
  const names = document.getElementById('rooms').value.split(',').map((s)=>s.trim()).filter(Boolean);
  if(!names.length){ log('ingresá al menos una sala'); return; }
  document.getElementById('go').disabled = true;
  document.getElementById('stop').disabled = false;
  document.getElementById('status').textContent = names.length + ' cámaras';
  log('conectando ' + names.length + ' cámaras...');
  for (const n of names) await connectRoom(n);
  log('en vivo — ' + names.length + ' cámaras');
};
document.getElementById('stop').onclick = async () => {
  for (const r of rooms){ try{ await r.disconnect(); }catch(e){} }
  rooms=[]; gridEl.innerHTML='';
  document.getElementById('go').disabled = false;
  document.getElementById('stop').disabled = true;
  document.getElementById('status').textContent='';
  log('desconectado');
};
</script>
</body></html>`,

  // Live shopping (1→N) — low-latency WebRTC viewer + chat/reactions over the
  // LiveKit data channel + a demo buy button. Watches with a PUBLIC play token
  // (chat is receive-only); pass an ephemeral data-capable token (#token=…) to
  // also send chat/reactions.
  'live-shopping.html': `${head('StreamHub · Live shopping · {{APP}}')}
<header><b>StreamHub</b> · Live shopping · app <b>{{APP}}</b> <span id="livebadge" class="live" style="display:none">EN VIVO</span></header>
<style>
.ls{display:grid;grid-template-columns:1fr 320px;gap:14px}
@media(max-width:820px){.ls{grid-template-columns:1fr}}
.chat{display:flex;flex-direction:column;height:66vh;background:#0e1530;border-radius:10px;overflow:hidden}
.msgs{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:6px}
.msg{font-size:13px}.msg b{color:#6ea8ff}
.compose,.reacts{display:flex;gap:6px;padding:8px;border-top:1px solid #1f2b4d}
.compose input{flex:1}
.reacts button{padding:6px 10px;font-size:16px;background:#1f2b4d}
.buy button{width:100%;background:#12b886;font-size:15px;padding:12px;margin-top:10px}
.float{position:fixed;bottom:80px;right:40px;font-size:34px;pointer-events:none;animation:rise 1.6s ease-out forwards}
@keyframes rise{to{transform:translateY(-140px);opacity:0}}
</style>
<main>
  <div class="row">
    <label>room <input id="room" value="{{ROOM}}" /></label>
    <button id="go">Ver en vivo</button>
    <span id="status" class="muted"></span>
  </div>
  <div class="ls">
    <div><video id="player" autoplay playsinline></video></div>
    <div class="chat">
      <div class="msgs" id="msgs"></div>
      <div class="reacts" id="reacts">
        <button data-r="heart">❤️</button><button data-r="like">👍</button>
        <button data-r="fire">🔥</button><button data-r="clap">👏</button>
      </div>
      <div class="compose">
        <input id="chatInput" placeholder="Escribí un mensaje…" maxlength="240" />
        <button id="send">Enviar</button>
      </div>
      <div class="buy"><button id="buy">🛒 Comprar ahora</button></div>
    </div>
  </div>
  <div class="log" id="log">idle</div>
</main>
<script src="${LIVEKIT_CDN}"></script>
<script>
${bootstrap()}
const log = logTo('log');
const msgs = document.getElementById('msgs');
const badge = document.getElementById('livebadge');
const enc = new TextEncoder(); const dec = new TextDecoder();
const EMOJI = { heart:'❤️', like:'👍', fire:'🔥', clap:'👏' };
let room = null, canSend = false;
function addMsg(from, text){
  const d = document.createElement('div'); d.className='msg';
  const b = document.createElement('b'); b.textContent = (from||'anon') + ': ';
  d.appendChild(b); d.appendChild(document.createTextNode(text));
  msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight;
}
function floatReaction(r){ const s=document.createElement('div'); s.className='float'; s.textContent=EMOJI[r]||r||'❤️'; document.body.appendChild(s); setTimeout(()=>s.remove(),1600); }
function onData(payload, participant){
  let txt=''; try{ txt = dec.decode(payload); }catch(e){}
  let obj=null; try{ obj = JSON.parse(txt); }catch(e){}
  if (obj && obj.topic === 'reaction') floatReaction(obj.reaction);
  else addMsg((obj && obj.from) || (participant && participant.identity), (obj && obj.message) || txt);
}
async function sendData(o){
  if(!room || !canSend){ log('chat de solo lectura — pasá un token efímero para escribir'); return; }
  try{ await room.localParticipant.publishData(enc.encode(JSON.stringify(o)), { reliable:true, topic:o.topic }); }
  catch(e){ log('no se pudo enviar: ' + (e && e.message ? e.message : e)); }
}
document.getElementById('go').onclick = async () => {
  await loadScript(ADAPTOR_URL);
  const roomName = nsRoom(document.getElementById('room').value.trim());
  try {
    log('conectando...');
    const eph = ephemeral();
    const creds = eph || await playToken(roomName);
    room = new LivekitClient.Room({ adaptiveStream:true });
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (t)=>{ if(t.kind==='video') t.attach(document.getElementById('player')); else { const a=t.attach(); a.autoplay=true; document.body.appendChild(a);} });
    room.on(LivekitClient.RoomEvent.DataReceived, onData);
    await room.connect(creds.wsUrl, creds.token);
    canSend = !!(room.localParticipant && room.localParticipant.permissions && room.localParticipant.permissions.canPublishData);
    badge.style.display='inline-block';
    document.getElementById('status').textContent = canSend ? 'chat activo' : 'chat: solo lectura';
    log('en vivo — ' + roomName);
    document.getElementById('go').disabled = true;
  } catch (e) { log('error: ' + (e && e.message ? e.message : e)); }
};
document.getElementById('send').onclick = () => {
  const inp = document.getElementById('chatInput'); const v = inp.value.trim(); if(!v) return;
  const from = 'guest-' + Math.random().toString(36).slice(2,6);
  addMsg(from, v); sendData({ topic:'chat', from: from, message: v }); inp.value='';
};
document.getElementById('reacts').onclick = (e) => { const b = e.target.closest('button'); if(!b) return; const r = b.getAttribute('data-r'); floatReaction(r); sendData({ topic:'reaction', reaction: r }); };
document.getElementById('buy').onclick = () => {
  const url = qp('buyUrl'); const product = qp('product') || 'este producto';
  if (url) window.open(url, '_blank');
  else alert('Demo: agregaste ' + product + ' al carrito. Configurá ?buyUrl=https://tu-tienda/checkout para enlazar tu checkout real.');
};
</script>
</body></html>`,

  // Telemedicine / 1:1 support — a private room with EPHEMERAL tokens. The
  // operator mints one join token per party (server-side) and shares a link
  // (#room=…&token=…&ws=…). No admin token in the page.
  'telemedicine.html': `${head('StreamHub · Telemedicina 1:1 · {{APP}}')}
<header><b>StreamHub</b> · Telemedicina / Soporte 1:1 · app <b>{{APP}}</b></header>
<style>
.stage{position:relative;background:#000;border-radius:12px;overflow:hidden;min-height:60vh}
.remote{width:100%;height:60vh;object-fit:contain;background:#000}
.local{position:absolute;bottom:14px;right:14px;width:180px;border-radius:8px;border:2px solid #25325a;background:#000}
.ctrl{display:flex;gap:10px;justify-content:center;margin:12px 0;flex-wrap:wrap}
.setup{background:#0e1530;border-radius:10px;padding:16px;max-width:560px;margin:0 auto}
.setup input{width:100%;margin:6px 0}
.setup code{display:block;background:#0b1020;padding:8px;border-radius:6px;font-size:11px;overflow:auto;margin:8px 0}
</style>
<main>
  <div id="setup" class="setup">
    <p><b>Sala privada 1:1 con tokens efímeros.</b> El operador mintéa un token por participante y comparte el link. Pegá el token o abrí el enlace con <code>#room=…&amp;token=…&amp;ws=…</code></p>
    <label class="muted">room</label><input id="fRoom" value="{{ROOM}}" />
    <label class="muted">token efímero (LiveKit JWT)</label><input id="fToken" placeholder="eyJ…" />
    <label class="muted">wsUrl (opcional)</label><input id="fWs" placeholder="{{WS_URL}}" />
    <button id="join">Entrar a la consulta</button>
    <p class="muted">Mintear un token (server-side, autenticado):</p>
    <code>curl -X POST {{API_URL}}/apps/{{APP}}/tokens -H 'Authorization: Bearer &lt;sk_…&gt;' -H 'Content-Type: application/json' -d '{"room":"consulta-123","identity":"doctor","canPublish":true,"canSubscribe":true,"ttl":"2h"}'</code>
  </div>
  <div id="call" style="display:none">
    <div class="stage">
      <video id="remote" class="remote" autoplay playsinline></video>
      <video id="local" class="local" autoplay muted playsinline></video>
    </div>
    <div class="ctrl">
      <button id="mic" class="alt">Silenciar mic</button>
      <button id="cam" class="alt">Apagar cámara</button>
      <button id="hang" style="background:#c0263a">Colgar</button>
    </div>
  </div>
  <div class="log" id="log">idle</div>
</main>
<script src="${LIVEKIT_CDN}"></script>
<script>
${bootstrap()}
const log = logTo('log');
let room = null, micOn = true, camOn = true;
async function start(creds){
  await loadScript(ADAPTOR_URL);
  document.getElementById('setup').style.display='none';
  document.getElementById('call').style.display='block';
  try {
    room = new LivekitClient.Room({ adaptiveStream:true, dynacast:true });
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (t)=>{ if(t.kind==='video') t.attach(document.getElementById('remote')); else { const a=t.attach(); a.autoplay=true; document.body.appendChild(a);} });
    await room.connect(creds.wsUrl, creds.token);
    await room.localParticipant.enableCameraAndMicrophone();
    const pub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
    if (pub && pub.track) pub.track.attach(document.getElementById('local'));
    log('en consulta' + (creds.room ? ' — ' + creds.room : ''));
  } catch (e) { log('error: ' + (e && e.message ? e.message : e)); }
}
const eph = ephemeral();
if (eph && eph.token) start(eph);
document.getElementById('join').onclick = () => {
  const token = document.getElementById('fToken').value.trim();
  const ws = document.getElementById('fWs').value.trim() || WS_URL;
  const r = document.getElementById('fRoom').value.trim();
  if (!token) { log('pegá un token efímero (o abrí el link con #token=…)'); return; }
  start({ token: token, wsUrl: ws, room: r });
};
document.getElementById('mic').onclick = async () => { micOn=!micOn; await room.localParticipant.setMicrophoneEnabled(micOn); document.getElementById('mic').textContent = micOn ? 'Silenciar mic' : 'Activar mic'; };
document.getElementById('cam').onclick = async () => { camOn=!camOn; await room.localParticipant.setCameraEnabled(camOn); document.getElementById('cam').textContent = camOn ? 'Apagar cámara' : 'Encender cámara'; if(camOn){ const pub=room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera); if(pub&&pub.track) pub.track.attach(document.getElementById('local')); } };
document.getElementById('hang').onclick = async () => { try{ if(room) await room.disconnect(); }catch(e){} document.getElementById('call').style.display='none'; document.getElementById('setup').style.display='block'; log('consulta finalizada'); };
</script>
</body></html>`,

  // Radio / audio — a turnkey, embeddable listener-only player. Tunes into the
  // radio room with the PUBLIC audio listen token (the radio plugin backend).
  'radio-player.html': `${head('StreamHub · Radio · {{APP}}')}
<header><b>StreamHub</b> · Radio · app <b>{{APP}}</b> <span id="livebadge" class="live" style="display:none">EN VIVO</span></header>
<style>
.station{max-width:460px;margin:24px auto;text-align:center;background:#0e1530;border-radius:14px;padding:24px}
.disc{width:120px;height:120px;border-radius:50%;margin:0 auto 16px;background:radial-gradient(circle at 50% 50%,#2d6cff 0 22%,#0b1020 24% 34%,#1f2b4d 36%)}
.disc.spin{animation:spin 3s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.play{width:72px;height:72px;border-radius:50%;font-size:26px;margin-top:8px}
</style>
<main>
  <div class="station">
    <div id="disc" class="disc"></div>
    <div id="name" style="font-size:18px;font-weight:700">Radio</div>
    <div class="row" style="justify-content:center">
      <label>room <input id="room" value="{{ROOM}}" /></label>
    </div>
    <button id="toggle" class="play">▶</button>
    <div id="count" class="muted" style="margin-top:10px"></div>
  </div>
  <div class="log" id="log">idle — tocá play para sintonizar la emisión en vivo (audio).</div>
</main>
<script src="${LIVEKIT_CDN}"></script>
<script>
${bootstrap()}
const log = logTo('log');
const badge = document.getElementById('livebadge');
const disc = document.getElementById('disc');
const countEl = document.getElementById('count');
let room = null, playing = false;
document.getElementById('name').textContent = qp('station') || 'Radio {{APP}}';
function updateCount(){ if(!room) return; let n=0; room.remoteParticipants.forEach(()=>n++); countEl.textContent = n > 0 ? 'transmisión activa' : 'esperando al máster…'; }
async function tune(){
  const roomName = nsRoom(document.getElementById('room').value.trim());
  try {
    log('sintonizando…');
    const { token, wsUrl } = await radioListenToken(roomName);
    room = new LivekitClient.Room({ adaptiveStream:true });
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (t)=>{ if(t.kind==='audio'){ const a=t.attach(); a.autoplay=true; document.body.appendChild(a);} });
    room.on(LivekitClient.RoomEvent.ParticipantConnected, updateCount);
    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, updateCount);
    await room.connect(wsUrl, token);
    playing = true; badge.style.display='inline-block'; disc.classList.add('spin');
    document.getElementById('toggle').textContent='⏸';
    updateCount(); log('EN VIVO — ' + roomName);
  } catch (e) { log('error: ' + (e && e.message ? e.message : e)); }
}
async function stop(){ try{ if(room) await room.disconnect(); }catch(e){} room=null; playing=false; badge.style.display='none'; disc.classList.remove('spin'); countEl.textContent=''; document.getElementById('toggle').textContent='▶'; log('detenido'); }
document.getElementById('toggle').onclick = () => { playing ? stop() : tune(); };
</script>
</body></html>`,

  // Conference (Google Meet-style, N-to-N) — a full meeting surface:
  //   • pre-join screen: display-name input, live camera/mic preview with device
  //     pickers and pre-mute toggles; room from the URL (?room=) with a default.
  //   • in-call: responsive speaker-view grid (active speaker highlighted),
  //     name labels + mic-muted indicators, screen share (the shared screen
  //     becomes the big presentation tile).
  //   • StreamHub-styled control bar (mic / camera / screen / participant count
  //     / chat / leave) with `m` + `v` keyboard shortcuts.
  //   • chat side panel over the LiveKit data channel (name · time · text),
  //     enter-to-send, unread badge when closed — no persistence.
  // Joins with the app token flow like the other samples: an ephemeral token
  // (link #token=…&ws=…&room=…) or a minted one (operator/dev link ?apitoken=…).
  // Reconnect and participant join/leave are handled live.
  'conference.html': `${head('StreamHub · Conference · {{APP}}')}
<style>
:root{--cyan:#22d3ee;--blue:#2d6cff;--panel:#0e1530;--panel2:#121a33;--edge:#1f2b4d;--edge2:#25325a}
html,body{height:100%}
body{overflow:hidden}
.app{position:fixed;inset:0;display:flex;flex-direction:column}
.app video{max-height:none}
.topbar{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--panel2);border-bottom:1px solid var(--edge);flex:0 0 auto}
.topbar .brand{font-weight:800;color:var(--cyan);letter-spacing:.3px}
.topbar .room{opacity:.72;font-size:13px}
.pill{margin-left:auto;display:inline-flex;align-items:center;gap:7px;font-size:12px;padding:4px 11px;border-radius:999px;background:#0e1530;border:1px solid var(--edge2)}
.pill .dot{width:8px;height:8px;border-radius:50%;background:#12b886}
.pill .dot.warn{background:#e8a33d}.pill .dot.bad{background:#c0263a}
/* pre-join */
.prejoin{flex:1;display:flex;align-items:center;justify-content:center;gap:30px;padding:24px;flex-wrap:wrap;overflow:auto}
.pv{position:relative;width:min(560px,92vw);aspect-ratio:16/9;background:#000;border-radius:16px;overflow:hidden;border:1px solid var(--edge2)}
.pv video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
.pv .novid{position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:#7f8db3;font-size:14px;background:#0c1226}
.pv.camoff .novid{display:flex}.pv.camoff video{visibility:hidden}
.pv .mini{position:absolute;bottom:14px;left:0;right:0;display:flex;justify-content:center;gap:14px}
.rnd{width:48px;height:48px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);border:1px solid var(--edge2);color:#fff;cursor:pointer;padding:0}
.rnd:hover{background:rgba(0,0,0,.75)}
.rnd.off{background:#c0263a;border-color:#c0263a}
.rnd svg{width:22px;height:22px}
.pjcard{width:min(360px,92vw)}
.pjcard h1{font-size:23px;margin:0 0 4px}
.pjcard .sub{margin:0 0 14px;opacity:.7;font-size:13px}
.pjcard label{display:block;font-size:12px;opacity:.75;margin:12px 0 4px}
.pjcard input,.pjcard select{width:100%;box-sizing:border-box}
.join{width:100%;margin-top:22px;background:var(--blue);padding:13px;font-size:15px}
/* call */
.call{flex:1;display:flex;min-height:0}
.stagewrap{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;padding:12px;gap:10px}
.present{flex:1;display:none;background:#000;border-radius:14px;overflow:hidden;border:1px solid var(--edge);position:relative}
.present video{width:100%;height:100%;object-fit:contain;background:#000}
.present .plabel{position:absolute;top:10px;left:12px;background:rgba(0,0,0,.6);padding:3px 10px;border-radius:8px;font-size:12px}
.tiles{flex:1;display:grid;gap:10px;min-height:0;align-content:center;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.stagewrap.presenting .present{display:block}
.stagewrap.presenting .tiles{flex:0 0 auto;grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:190px;overflow-x:auto;align-content:start}
.tile{position:relative;background:#0c1226;border-radius:14px;overflow:hidden;aspect-ratio:16/9;border:2px solid transparent;min-width:0}
.tile video{width:100%;height:100%;object-fit:cover;background:#000}
.tile.self video{transform:scaleX(-1)}
.tile.speaking{border-color:var(--cyan);box-shadow:0 0 14px rgba(34,211,238,.35)}
.tile .avatar{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:#141d3a}
.tile.camoff .avatar{display:flex}.tile.camoff video{visibility:hidden}
.tile .avatar span{width:66px;height:66px;border-radius:50%;background:#2a3a66;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700}
.tile .lbl{position:absolute;bottom:8px;left:8px;display:inline-flex;align-items:center;gap:6px;background:rgba(0,0,0,.62);padding:3px 9px;border-radius:9px;font-size:12px;max-width:82%}
.tile .lbl .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tile .lbl .mic{width:14px;height:14px;color:#ff6b6b;flex:0 0 auto;display:none}
.tile.muted .lbl .mic{display:inline-block}
/* chat */
.chat{width:322px;max-width:88vw;background:var(--panel);border-left:1px solid var(--edge);display:flex;flex-direction:column;min-height:0}
.chat.hidden{display:none}
.chat h3{margin:0;padding:14px 16px;border-bottom:1px solid var(--edge);font-size:14px;display:flex;align-items:center;justify-content:space-between}
.chat h3 button{background:none;border:0;color:#8ea2cc;font-size:20px;cursor:pointer;padding:0;line-height:1}
.msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:11px}
.msgs .empty{opacity:.5;font-size:13px;text-align:center;margin-top:24px}
.cmsg .meta{font-size:11px;opacity:.65;margin-bottom:1px}.cmsg .meta b{color:var(--cyan)}
.cmsg .txt{font-size:13px;word-break:break-word;line-height:1.45}
.compose{display:flex;gap:8px;padding:10px;border-top:1px solid var(--edge)}
.compose input{flex:1}
/* control bar */
.bar{display:flex;align-items:center;justify-content:center;gap:10px;padding:12px;background:var(--panel2);border-top:1px solid var(--edge);flex:0 0 auto;flex-wrap:wrap}
.cbtn{position:relative;width:52px;height:52px;border-radius:15px;background:rgba(255,255,255,.06);border:1px solid var(--edge2);color:#e6ecff;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:background .15s,box-shadow .15s}
.cbtn:hover{background:rgba(255,255,255,.13)}
.cbtn.active{background:var(--cyan);border-color:var(--cyan);color:#04222a}
.cbtn.off{background:#c0263a;border-color:#c0263a;color:#fff}
.cbtn.leave{background:#c0263a;border-color:#c0263a;color:#fff;width:64px}
.cbtn svg{width:23px;height:23px}
.cbtn .badge{position:absolute;top:-6px;right:-6px;min-width:19px;height:19px;padding:0 5px;border-radius:10px;background:var(--cyan);color:#04222a;font-size:11px;font-weight:800;display:none;align-items:center;justify-content:center}
.cbtn .badge.show{display:flex}
.people{display:inline-flex;align-items:center;gap:7px;height:52px;padding:0 15px;border-radius:15px;background:rgba(255,255,255,.06);border:1px solid var(--edge2);font-size:14px;font-weight:600}
.people svg{width:20px;height:20px;opacity:.85}
.toast{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);background:rgba(0,0,0,.82);border:1px solid var(--edge2);padding:8px 15px;border-radius:11px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:20}
.toast.show{opacity:1}
@media(max-width:640px){.chat{position:absolute;inset:0;width:100%;max-width:100%;z-index:10}.cbtn,.people{width:46px;height:46px}.cbtn.leave{width:58px}.people{padding:0 12px}}
</style>
<div class="app">
  <div class="topbar">
    <span class="brand">StreamHub</span>
    <span class="room">Conference · <b id="roomName">{{ROOM}}</b></span>
    <span class="pill"><span id="netdot" class="dot"></span><span id="netlbl">ready</span></span>
  </div>

  <!-- PRE-JOIN -->
  <div id="prejoin" class="prejoin">
    <div id="pv" class="pv">
      <video id="preview" autoplay muted playsinline></video>
      <div class="novid">Camera off</div>
      <div class="mini">
        <button id="pjMic" class="rnd" title="Microphone (toggle)"></button>
        <button id="pjCam" class="rnd" title="Camera (toggle)"></button>
      </div>
    </div>
    <div class="pjcard">
      <h1>Ready to join?</h1>
      <p class="sub">Check your camera and mic, then hop in.</p>
      <label for="fName">Your name</label>
      <input id="fName" placeholder="e.g. Alex" maxlength="40" />
      <label for="fRoom">Room</label>
      <input id="fRoom" value="{{ROOM}}" />
      <label for="camSelect">Camera</label>
      <select id="camSelect"></select>
      <label for="micSelect">Microphone</label>
      <select id="micSelect"></select>
      <button id="join" class="join">Join now</button>
    </div>
  </div>

  <!-- IN-CALL -->
  <div id="call" class="call" style="display:none">
    <div class="stagewrap" id="stagewrap">
      <div class="present" id="present">
        <video id="presentVideo" autoplay playsinline></video>
        <div class="plabel" id="presentLabel"></div>
      </div>
      <div class="tiles" id="tiles"></div>
    </div>
    <aside id="chat" class="chat hidden">
      <h3>Chat <button id="chatClose" title="Close">&times;</button></h3>
      <div class="msgs" id="msgs"><div class="empty">No messages yet.</div></div>
      <div class="compose">
        <input id="chatInput" placeholder="Send a message…" maxlength="500" />
        <button id="chatSend">Send</button>
      </div>
    </aside>
  </div>

  <!-- CONTROL BAR -->
  <div id="bar" class="bar" style="display:none">
    <button id="mic" class="cbtn" title="Mic (m)"></button>
    <button id="cam" class="cbtn" title="Camera (v)"></button>
    <button id="screen" class="cbtn" title="Share screen"></button>
    <span class="people" title="Participants"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M17 20v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM23 20v-2a4 4 0 0 0-3-3.87M16 4.13a4 4 0 0 1 0 7.75"/></svg><span id="count">1</span></span>
    <button id="chatToggle" class="cbtn" title="Chat"><span class="badge" id="chatBadge">0</span></button>
    <button id="leave" class="cbtn leave" title="Leave"></button>
  </div>
</div>
<div id="toast" class="toast"></div>

<script src="${LIVEKIT_CDN}"></script>
<script>
${bootstrap()}
// ---- inline SVG icon set (stroke = currentColor) -------------------------
var SVG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">';
var IC = {
  mic: SVG+'<path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/></svg>',
  micOff: SVG+'<path d="M9 9v3a3 3 0 0 0 5 2.1M15 10.5V6a3 3 0 0 0-5.9-.7"/><path d="M19 11a7 7 0 0 1-6.5 6.98M8 5.5A6.9 6.9 0 0 0 5 11M12 18v3M3 3l18 18"/></svg>',
  cam: SVG+'<path d="M16 8.5 21 6v12l-5-2.5V8.5zM3 7h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/></svg>',
  camOff: SVG+'<path d="M16 8.5 21 6v12l-3.2-1.6M10 7h4a1 1 0 0 1 1 1v3M15 14v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1M3 3l18 18"/></svg>',
  screen: SVG+'<path d="M3 5h18a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 20h8M12 16v4"/></svg>',
  chat: SVG+'<path d="M21 11.5a8.4 8.4 0 0 1-11.9 7.6L3 21l1.9-5.7A8.4 8.4 0 1 1 21 11.5z"/></svg>',
  leave: SVG+'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>'
};
function setChatIcon(){ var tog=document.getElementById('chatToggle'); var b=document.getElementById('chatBadge'); tog.innerHTML=IC.chat; tog.appendChild(b); }
var toastEl=document.getElementById('toast'), toastTimer=null;
function toast(m){ toastEl.textContent=String(m); toastEl.classList.add('show'); if(toastTimer)clearTimeout(toastTimer); toastTimer=setTimeout(function(){toastEl.classList.remove('show');},2600); }
function net(state,label){ var d=document.getElementById('netdot'); d.className='dot'+(state==='warn'?' warn':state==='bad'?' bad':''); document.getElementById('netlbl').textContent=label; }

// ------------------------------------------------------------------ pre-join
var LK = window.LivekitClient;
var previewStream=null, startMic=true, startCam=true;
var initialRoom = qp('room') || nsRoom('');
document.getElementById('fRoom').value = initialRoom;
document.getElementById('roomName').textContent = initialRoom;
document.getElementById('fName').value = qp('name') || qp('identity') || '';

function paintPjToggles(){
  var m=document.getElementById('pjMic'), c=document.getElementById('pjCam');
  m.innerHTML=startMic?IC.mic:IC.micOff; m.className='rnd'+(startMic?'':' off');
  c.innerHTML=startCam?IC.cam:IC.camOff; c.className='rnd'+(startCam?'':' off');
  document.getElementById('pv').className='pv'+(startCam?'':' camoff');
}
function fillSelect(id,list,fallback){
  var sel=document.getElementById(id); var cur=sel.value; sel.innerHTML='';
  list.forEach(function(d,i){ var o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||(fallback+' '+(i+1)); sel.appendChild(o); });
  if(cur) sel.value=cur;
}
async function listDevices(){
  try{
    var devs = await navigator.mediaDevices.enumerateDevices();
    fillSelect('camSelect',devs.filter(function(d){return d.kind==='videoinput';}),'Camera');
    fillSelect('micSelect',devs.filter(function(d){return d.kind==='audioinput';}),'Microphone');
  }catch(e){}
}
async function startPreview(){
  try{ if(previewStream) previewStream.getTracks().forEach(function(t){t.stop();}); }catch(e){}
  var camId=document.getElementById('camSelect').value;
  var micId=document.getElementById('micSelect').value;
  try{
    previewStream = await navigator.mediaDevices.getUserMedia({
      video: startCam ? (camId?{deviceId:{exact:camId}}:true) : false,
      audio: micId?{deviceId:{exact:micId}}:true
    });
    document.getElementById('preview').srcObject = startCam ? previewStream : null;
    await listDevices();
    net('warn','ready');
  }catch(e){ document.getElementById('pv').classList.add('camoff'); net('warn','no camera/mic permission'); }
}
document.getElementById('pjMic').onclick=function(){ startMic=!startMic; paintPjToggles(); };
document.getElementById('pjCam').onclick=async function(){ startCam=!startCam; paintPjToggles(); await startPreview(); };
document.getElementById('camSelect').onchange=startPreview;
document.getElementById('micSelect').onchange=startPreview;
paintPjToggles();
startPreview();

// ------------------------------------------------------------------ in-call
var room=null, micOn=true, camOn=true, sharing=false, leaving=false, chatOpen=false, unread=0;
var tileById={}, activeId=null, presentOwner=null;
var enc=new TextEncoder(), dec=new TextDecoder();
var tiles=document.getElementById('tiles');

function initials(name){ return (name||'?').trim().slice(0,2).toUpperCase(); }
function tileFor(id,label){
  if(tileById[id]) return tileById[id];
  var t=document.createElement('div'); t.className='tile';
  var v=document.createElement('video'); v.autoplay=true; v.playsInline=true;
  var av=document.createElement('div'); av.className='avatar'; var sp=document.createElement('span'); sp.textContent=initials(label); av.appendChild(sp);
  var l=document.createElement('div'); l.className='lbl';
  var mic=document.createElementNS('http://www.w3.org/2000/svg','svg'); mic.setAttribute('class','mic'); mic.setAttribute('viewBox','0 0 24 24'); mic.setAttribute('fill','none'); mic.setAttribute('stroke','currentColor'); mic.setAttribute('stroke-width','2'); mic.innerHTML='<path d="M9 9v3a3 3 0 0 0 5 2.1M15 10.5V6a3 3 0 0 0-5.9-.7M19 11a7 7 0 0 1-13 3M12 18v3M3 3l18 18"/>';
  var nm=document.createElement('span'); nm.className='nm'; nm.textContent=label||id;
  l.appendChild(mic); l.appendChild(nm);
  t.appendChild(v); t.appendChild(av); t.appendChild(l); tiles.appendChild(t);
  tileById[id]={t:t,v:v,l:nm}; return tileById[id];
}
function removeTile(id){ var x=tileById[id]; if(x){ x.t.remove(); delete tileById[id]; } refreshCount(); }
function setCamOff(id,off){ var x=tileById[id]; if(x) x.t.classList.toggle('camoff',off); }
function setMutedUi(id,muted){ var x=tileById[id]; if(x) x.t.classList.toggle('muted',muted); }
function refreshCount(){ var n=room? room.remoteParticipants.size+1 : Object.keys(tileById).length; document.getElementById('count').textContent=n; }
function setActive(id){ if(activeId&&tileById[activeId]) tileById[activeId].t.classList.remove('speaking'); activeId=id; if(id&&tileById[id]) tileById[id].t.classList.add('speaking'); }

function showPresent(track,label){
  document.getElementById('stagewrap').classList.add('presenting');
  track.attach(document.getElementById('presentVideo'));
  document.getElementById('presentLabel').textContent=(label||'')+' · presenting';
}
function clearPresent(){ document.getElementById('stagewrap').classList.remove('presenting'); presentOwner=null; try{document.getElementById('presentVideo').srcObject=null;}catch(e){} }
function isScreen(pub,track){
  var S = (LK.Track&&LK.Track.Source)?LK.Track.Source.ScreenShare:'screen_share';
  if(pub&&pub.source) return pub.source===S;
  if(track&&track.source) return track.source===S;
  return false;
}
function attachLocalCam(me){
  var pub=room.localParticipant.getTrackPublication(LK.Track.Source.Camera);
  if(pub&&pub.track){ pub.track.attach(me.v); setCamOff(room.localParticipant.identity,false); }
}
function hydrate(){
  room.remoteParticipants.forEach(function(p){
    var c=tileFor(p.identity, p.name||p.identity);
    p.trackPublications.forEach(function(pub){
      var track=pub.track; if(!track) return;
      if(track.kind==='video'){ if(isScreen(pub,track)){ presentOwner=p.identity; showPresent(track,p.name||p.identity); } else track.attach(c.v); }
      else { var a=track.attach(); a.autoplay=true; document.body.appendChild(a); }
    });
    var mp=p.getTrackPublication(LK.Track.Source.Microphone); if(mp&&mp.isMuted) setMutedUi(p.identity,true);
  });
}
function wire(room){
  room.on(LK.RoomEvent.TrackSubscribed,function(track,pub,participant){
    if(track.kind==='video'){
      if(isScreen(pub,track)){ presentOwner=participant.identity; showPresent(track, participant.name||participant.identity); }
      else { var c=tileFor(participant.identity, participant.name||participant.identity); track.attach(c.v); setCamOff(participant.identity,false); }
    } else { var a=track.attach(); a.autoplay=true; document.body.appendChild(a); }
    refreshCount();
  });
  room.on(LK.RoomEvent.TrackUnsubscribed,function(track,pub,participant){
    if(isScreen(pub,track)&&presentOwner===participant.identity) clearPresent();
    else if(track.kind==='video') setCamOff(participant.identity,true);
    try{ track.detach().forEach(function(el){el.remove();}); }catch(e){}
  });
  room.on(LK.RoomEvent.LocalTrackPublished,function(pub){ if(isScreen(pub,pub.track)){ presentOwner=room.localParticipant.identity; showPresent(pub.track,'You'); } });
  room.on(LK.RoomEvent.LocalTrackUnpublished,function(pub){ if(isScreen(pub,pub.track)&&presentOwner===room.localParticipant.identity) clearPresent(); });
  room.on(LK.RoomEvent.TrackMuted,function(pub,participant){ if(pub.kind==='audio') setMutedUi(participant.identity,true); if(pub.source===LK.Track.Source.Camera) setCamOff(participant.identity,true); });
  room.on(LK.RoomEvent.TrackUnmuted,function(pub,participant){ if(pub.kind==='audio') setMutedUi(participant.identity,false); if(pub.source===LK.Track.Source.Camera) setCamOff(participant.identity,false); });
  room.on(LK.RoomEvent.ParticipantConnected,function(p){ tileFor(p.identity,p.name||p.identity); refreshCount(); toast((p.name||p.identity)+' joined'); });
  room.on(LK.RoomEvent.ParticipantDisconnected,function(p){ if(presentOwner===p.identity) clearPresent(); removeTile(p.identity); toast((p.name||p.identity)+' left'); });
  room.on(LK.RoomEvent.ActiveSpeakersChanged,function(speakers){ if(speakers&&speakers.length) setActive(speakers[0].identity); });
  room.on(LK.RoomEvent.DataReceived,onData);
  room.on(LK.RoomEvent.Reconnecting,function(){ net('warn','reconnecting…'); toast('Reconnecting…'); });
  room.on(LK.RoomEvent.Reconnected,function(){ net('ok','connected'); toast('Reconnected'); });
  room.on(LK.RoomEvent.Disconnected,function(){ if(!leaving){ net('bad','disconnected'); toast('Disconnected'); backToPrejoin(); } });
}

async function join(creds,name){
  await loadScript(ADAPTOR_URL); // best-effort AntMedia-style adaptor, else livekit-client
  LK = window.LivekitClient;
  try{ if(previewStream) previewStream.getTracks().forEach(function(t){t.stop();}); }catch(e){}
  document.getElementById('prejoin').style.display='none';
  document.getElementById('call').style.display='flex';
  document.getElementById('bar').style.display='flex';
  paintBar();
  try{
    var camId=document.getElementById('camSelect').value;
    var micId=document.getElementById('micSelect').value;
    room = new LK.Room({
      adaptiveStream:true, dynacast:true,
      videoCaptureDefaults: camId?{deviceId:camId}:undefined,
      audioCaptureDefaults: micId?{deviceId:micId}:undefined
    });
    wire(room);
    net('warn','connecting…');
    await room.connect(creds.wsUrl, creds.token);
    net('ok','connected');
    var me=tileFor(room.localParticipant.identity, (name||'You')+' (you)');
    me.t.classList.add('self'); me.v.muted=true;
    await room.localParticipant.enableCameraAndMicrophone();
    if(!startMic){ await room.localParticipant.setMicrophoneEnabled(false); }
    if(!startCam){ await room.localParticipant.setCameraEnabled(false); }
    micOn=startMic; camOn=startCam; paintBar();
    attachLocalCam(me); setCamOff(room.localParticipant.identity,!camOn); setMutedUi(room.localParticipant.identity,!micOn);
    hydrate(); refreshCount(); toast('Joined '+(creds.room||initialRoom));
  }catch(e){ toast('error: '+(e&&e.message?e.message:e)); net('bad','error'); }
}

// ---- control bar ----
function paintBar(){
  var mb=document.getElementById('mic'); mb.innerHTML=micOn?IC.mic:IC.micOff; mb.className='cbtn'+(micOn?'':' off');
  var cb=document.getElementById('cam'); cb.innerHTML=camOn?IC.cam:IC.camOff; cb.className='cbtn'+(camOn?'':' off');
  var sb=document.getElementById('screen'); sb.innerHTML=IC.screen; sb.className='cbtn'+(sharing?' active':'');
  setChatIcon();
  document.getElementById('leave').innerHTML=IC.leave;
}
async function toggleMic(){ if(!room)return; micOn=!micOn; await room.localParticipant.setMicrophoneEnabled(micOn); setMutedUi(room.localParticipant.identity,!micOn); paintBar(); }
async function toggleCam(){ if(!room)return; camOn=!camOn; await room.localParticipant.setCameraEnabled(camOn); if(camOn){ var me=tileById[room.localParticipant.identity]; if(me) attachLocalCam(me);} setCamOff(room.localParticipant.identity,!camOn); paintBar(); }
async function toggleScreen(){ if(!room)return; var next=!sharing; try{ await room.localParticipant.setScreenShareEnabled(next); sharing=next; paintBar(); }catch(e){ toast('screen share cancelled'); } }
document.getElementById('mic').onclick=toggleMic;
document.getElementById('cam').onclick=toggleCam;
document.getElementById('screen').onclick=toggleScreen;
document.getElementById('leave').onclick=function(){ leaving=true; try{ if(room) room.disconnect(); }catch(e){} backToPrejoin(); };
function backToPrejoin(){
  for(var k in tileById) removeTile(k); tileById={}; activeId=null; clearPresent();
  room=null; sharing=false;
  document.getElementById('call').style.display='none';
  document.getElementById('bar').style.display='none';
  document.getElementById('prejoin').style.display='flex';
  net('warn','ready'); leaving=false; startPreview();
}

// ---- chat (LiveKit data channel; name · time · text, no persistence) ----
var msgsEl=document.getElementById('msgs');
function ts(){ try{ return new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }catch(e){ return ''; } }
function addMsg(from,text,time,mine){
  var e=msgsEl.querySelector('.empty'); if(e) e.remove();
  var d=document.createElement('div'); d.className='cmsg';
  var m=document.createElement('div'); m.className='meta'; var b=document.createElement('b'); b.textContent=(mine?'You':(from||'Guest')); m.appendChild(b); m.appendChild(document.createTextNode(' · '+(time||ts())));
  var tx=document.createElement('div'); tx.className='txt'; tx.textContent=text;
  d.appendChild(m); d.appendChild(tx); msgsEl.appendChild(d); msgsEl.scrollTop=msgsEl.scrollHeight;
  if(!mine && !chatOpen){ unread++; var badge=document.getElementById('chatBadge'); badge.textContent=unread>9?'9+':String(unread); badge.classList.add('show'); }
}
function onData(payload,participant){
  var txt=''; try{ txt=dec.decode(payload); }catch(e){}
  var obj=null; try{ obj=JSON.parse(txt); }catch(e){}
  if(obj&&obj.topic==='chat') addMsg(obj.from||(participant&&participant.identity),obj.message,obj.time,false);
}
function sendChat(){
  var inp=document.getElementById('chatInput'); var v=inp.value.trim(); if(!v||!room) return;
  var payload={topic:'chat', from:(room.localParticipant.name||room.localParticipant.identity), message:v, time:ts()};
  addMsg(payload.from,v,payload.time,true);
  try{ room.localParticipant.publishData(enc.encode(JSON.stringify(payload)),{reliable:true,topic:'chat'}); }catch(e){ toast('could not send'); }
  inp.value='';
}
function toggleChat(open){
  chatOpen = (open===undefined)? !chatOpen : open;
  document.getElementById('chat').classList.toggle('hidden',!chatOpen);
  document.getElementById('chatToggle').classList.toggle('active',chatOpen);
  if(chatOpen){ unread=0; document.getElementById('chatBadge').classList.remove('show'); document.getElementById('chatInput').focus(); }
}
document.getElementById('chatToggle').onclick=function(){ toggleChat(); };
document.getElementById('chatClose').onclick=function(){ toggleChat(false); };
document.getElementById('chatSend').onclick=sendChat;
document.getElementById('chatInput').addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); sendChat(); } });

// ---- keyboard shortcuts: m = mic, v = camera ----
window.addEventListener('keydown',function(e){
  var tag=(e.target&&e.target.tagName)||''; if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA') return;
  if(!room) return;
  if(e.key==='m'||e.key==='M'){ e.preventDefault(); toggleMic(); }
  else if(e.key==='v'||e.key==='V'){ e.preventDefault(); toggleCam(); }
});

// ---- join ----
document.getElementById('join').onclick=async function(){
  var display=document.getElementById('fName').value.trim()||'Guest';
  var roomName=nsRoom(document.getElementById('fRoom').value.trim());
  initialRoom=roomName; document.getElementById('roomName').textContent=roomName;
  try{
    var eph=ephemeral();
    var creds;
    if(eph&&eph.token) creds={token:eph.token, wsUrl:eph.wsUrl, room:eph.room||roomName};
    else creds=await getToken({ room:roomName, identity:display+'-'+Math.random().toString(36).slice(2,6), name:display, canPublish:true, canSubscribe:true });
    if(!creds.room) creds.room=roomName;
    join(creds,display);
  }catch(e){ toast('error: '+(e&&e.message?e.message:e)+' — open the link with #token=… or pass ?apitoken=…'); }
};
</script>
</body></html>`,
};
