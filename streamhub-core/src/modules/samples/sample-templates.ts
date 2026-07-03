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

const LIVEKIT_CDN =
  'https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js';
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

  // Conference (N-to-N) — a simple meeting room: publish cam/mic, subscribe to
  // everyone, tile grid, mute/cam/screen-share/leave. Joins with an ephemeral
  // token (#token=…) or mints one (dev / operator link with ?apitoken=…).
  'conference.html': `${head('StreamHub · Conferencia · {{APP}}')}
<header><b>StreamHub</b> · Conferencia (N-a-N) · app <b>{{APP}}</b> <span id="count" class="muted"></span></header>
<style>
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.tile{position:relative;background:#000;border-radius:10px;overflow:hidden;aspect-ratio:16/9}
.tile video{width:100%;height:100%;object-fit:cover;background:#000}
.tile .lbl{position:absolute;bottom:6px;left:8px;background:rgba(0,0,0,.55);padding:1px 8px;border-radius:6px;font-size:12px}
.ctrl{display:flex;gap:10px;justify-content:center;margin:12px 0;flex-wrap:wrap}
.setup{background:#0e1530;border-radius:10px;padding:16px;max-width:520px;margin:0 auto}
.setup input{width:100%;margin:6px 0}
</style>
<main>
  <div id="setup" class="setup">
    <p><b>Sala de conferencia N-a-N.</b> Cada participante entra con su identidad. Con un token efímero (link <code>#token=…</code>) o, en dev, minteo directo.</p>
    <label class="muted">tu nombre</label><input id="fName" placeholder="Ana" />
    <label class="muted">room</label><input id="fRoom" value="{{ROOM}}" />
    <label class="muted">token efímero (opcional)</label><input id="fToken" placeholder="eyJ… (si no, se mintéa)" />
    <button id="join">Entrar a la sala</button>
  </div>
  <div id="stage" style="display:none">
    <div class="tiles" id="tiles"></div>
    <div class="ctrl">
      <button id="mic" class="alt">Silenciar</button>
      <button id="cam" class="alt">Cámara</button>
      <button id="screen" class="alt">Compartir pantalla</button>
      <button id="leave" style="background:#c0263a">Salir</button>
    </div>
  </div>
  <div class="log" id="log">idle</div>
</main>
<script src="${LIVEKIT_CDN}"></script>
<script>
${bootstrap()}
const log = logTo('log');
const tiles = document.getElementById('tiles');
let room = null, micOn = true, camOn = true, sharing = false;
const tileById = {};
function tileFor(id, label){
  if (tileById[id]) return tileById[id];
  const t = document.createElement('div'); t.className='tile';
  const v = document.createElement('video'); v.autoplay=true; v.playsInline=true;
  const l = document.createElement('div'); l.className='lbl'; l.textContent = label || id;
  t.appendChild(v); t.appendChild(l); tiles.appendChild(t);
  tileById[id] = { t: t, v: v, l: l }; return tileById[id];
}
function removeTile(id){ const x = tileById[id]; if(x){ x.t.remove(); delete tileById[id]; } refreshCount(); }
function refreshCount(){ document.getElementById('count').textContent = Object.keys(tileById).length + ' en sala'; }
async function join(creds, name){
  await loadScript(ADAPTOR_URL);
  document.getElementById('setup').style.display='none';
  document.getElementById('stage').style.display='block';
  try {
    room = new LivekitClient.Room({ adaptiveStream:true, dynacast:true });
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (t, pub, participant)=>{ const c = tileFor(participant.identity, participant.name || participant.identity); if(t.kind==='video') t.attach(c.v); else { const a=t.attach(); a.autoplay=true; document.body.appendChild(a);} refreshCount(); });
    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (p)=> removeTile(p.identity));
    await room.connect(creds.wsUrl, creds.token);
    await room.localParticipant.enableCameraAndMicrophone();
    const me = tileFor(room.localParticipant.identity, (name||'Yo') + ' (vos)');
    me.v.muted = true;
    const pub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
    if (pub && pub.track) pub.track.attach(me.v);
    refreshCount(); log('en la sala' + (creds.room ? ' — ' + creds.room : ''));
  } catch (e) { log('error: ' + (e && e.message ? e.message : e)); }
}
document.getElementById('join').onclick = async () => {
  const name = document.getElementById('fName').value.trim() || rid('user-');
  const roomName = nsRoom(document.getElementById('fRoom').value.trim());
  const pasted = document.getElementById('fToken').value.trim();
  try {
    const eph = ephemeral();
    let creds;
    if (pasted) creds = { token: pasted, wsUrl: WS_URL, room: roomName };
    else if (eph && eph.token) creds = eph;
    else creds = await getToken({ room: roomName, identity: name, canPublish:true, canSubscribe:true });
    join(creds, name);
  } catch (e) { log('error: ' + (e && e.message ? e.message : e) + ' — pegá un token efímero o abrí con #token=…'); }
};
document.getElementById('mic').onclick = async () => { micOn=!micOn; await room.localParticipant.setMicrophoneEnabled(micOn); document.getElementById('mic').textContent = micOn ? 'Silenciar' : 'Activar'; };
document.getElementById('cam').onclick = async () => { camOn=!camOn; await room.localParticipant.setCameraEnabled(camOn); const me=tileById[room.localParticipant.identity]; if(camOn && me){ const pub=room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera); if(pub&&pub.track) pub.track.attach(me.v);} };
document.getElementById('screen').onclick = async () => { const next=!sharing; try{ await room.localParticipant.setScreenShareEnabled(next); sharing=next; document.getElementById('screen').textContent = sharing ? 'Detener pantalla' : 'Compartir pantalla'; }catch(e){ log('screen share cancelado'); } };
document.getElementById('leave').onclick = async () => { try{ if(room) await room.disconnect(); }catch(e){} for(const k in tileById) removeTile(k); document.getElementById('stage').style.display='none'; document.getElementById('setup').style.display='block'; log('saliste de la sala'); };
</script>
</body></html>`,
};
