/**
 * Sample page renderer for an app (SPEC §10).
 *
 * Generates static HTML demos written to apps/<name>/samples/:
 *  - publish.html  → publish camera/mic via WebRTC (LiveKit JS) to a room.
 *  - play.html     → subscribe/play a live room.
 *  - embed.html    → iframe-embeddable player exposing the public URL.
 *
 * The pages request a join token from the per-app API
 * (`POST <apiBase>/apps/<app>/tokens`) and connect to the public LiveKit ws.
 * They use the LiveKit JS client from a CDN — no build step required.
 */

export interface SamplePageContext {
  /** App name (slug). */
  appName: string;
  /** Default room name for the demos (usually the app's room prefix). */
  roomName: string;
  /** Public base URL of the StreamHub deployment, e.g. https://streamhub.example.com */
  publicBaseUrl: string;
  /** Public LiveKit ws URL, e.g. wss://media.example.com */
  publicWsUrl: string;
  /** REST API base, e.g. https://streamhub.example.com/api/v1 */
  apiBase: string;
}

export interface SamplePages {
  publish: string;
  play: string;
  embed: string;
}

const LIVEKIT_CDN =
  'https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function head(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
           background:#0b1020; color:#e6ecff; }
    header { padding:14px 18px; background:#121a33; border-bottom:1px solid #1f2b4d; }
    header b { color:#6ea8ff; }
    main { padding:18px; max-width:960px; margin:0 auto; }
    video { width:100%; max-height:70vh; background:#000; border-radius:10px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:10px; }
    button { background:#2d6cff; color:#fff; border:0; padding:9px 16px; border-radius:8px;
             cursor:pointer; font-weight:600; }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:12px 0; }
    input { background:#0e1530; color:#e6ecff; border:1px solid #25325a; border-radius:8px;
            padding:8px 10px; }
    .log { margin-top:12px; padding:10px; background:#0e1530; border-radius:8px;
           font-family:ui-monospace,monospace; font-size:12px; white-space:pre-wrap;
           min-height:40px; }
  </style>
</head>
<body>`;
}

/**
 * Render the three sample pages for the given app context. Pure function: it
 * builds strings only and never throws.
 */
export function renderSamplePages(ctx: SamplePageContext): SamplePages {
  const appName = esc(ctx.appName);
  const roomName = esc(ctx.roomName);
  const wsUrl = esc(ctx.publicWsUrl);
  const apiBase = esc(ctx.apiBase.replace(/\/+$/, ''));
  const playUrl = `${ctx.publicBaseUrl.replace(/\/+$/, '')}/play/${ctx.appName}/${ctx.roomName}`;
  const embedUrl = `${ctx.publicBaseUrl.replace(/\/+$/, '')}/embed/${ctx.appName}/${ctx.roomName}`;

  // Shared JS that fetches a join token from the per-app API.
  const tokenFn = `
    async function getToken(canPublish) {
      const identity = (canPublish ? 'publisher-' : 'viewer-') + Math.random().toString(36).slice(2, 8);
      const res = await fetch('${apiBase}/apps/${appName}/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: '${roomName}', identity, canPublish, canSubscribe: true })
      });
      if (!res.ok) throw new Error('token request failed: ' + res.status);
      const body = await res.json();
      return (body && body.data ? (body.data.token || body.data) : body.token) || body;
    }`;

  const publish = `${head(`StreamHub · publish · ${ctx.appName}`)}
  <header><b>StreamHub</b> · publish · app <b>${appName}</b> · room <b>${roomName}</b></header>
  <main>
    <div class="row">
      <button id="go">Start publishing</button>
      <button id="stop" disabled>Stop</button>
    </div>
    <video id="local" autoplay muted playsinline></video>
    <div class="log" id="log">idle</div>
  </main>
  <script src="${LIVEKIT_CDN}"></script>
  <script>
    const WS_URL = '${wsUrl}';
    const log = (m) => { document.getElementById('log').textContent = String(m); };
    ${tokenFn}
    let room;
    document.getElementById('go').onclick = async () => {
      try {
        log('requesting token...');
        const token = await getToken(true);
        room = new LivekitClient.Room({ adaptiveStream: true, dynacast: true });
        await room.connect(WS_URL, token);
        log('connected, publishing camera + mic...');
        await room.localParticipant.enableCameraAndMicrophone();
        const pub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
        if (pub && pub.track) pub.track.attach(document.getElementById('local'));
        document.getElementById('go').disabled = true;
        document.getElementById('stop').disabled = false;
        log('publishing live to room ${roomName}');
      } catch (e) { log('error: ' + (e && e.message ? e.message : e)); }
    };
    document.getElementById('stop').onclick = async () => {
      try { if (room) await room.disconnect(); } catch (e) {}
      document.getElementById('go').disabled = false;
      document.getElementById('stop').disabled = true;
      log('stopped');
    };
  </script>
</body>
</html>`;

  const play = `${head(`StreamHub · play · ${ctx.appName}`)}
  <header><b>StreamHub</b> · play · app <b>${appName}</b> · room <b>${roomName}</b></header>
  <main>
    <div class="row"><button id="go">Play live</button></div>
    <div class="grid" id="remotes"></div>
    <div class="log" id="log">idle</div>
  </main>
  <script src="${LIVEKIT_CDN}"></script>
  <script>
    const WS_URL = '${wsUrl}';
    const log = (m) => { document.getElementById('log').textContent = String(m); };
    ${tokenFn}
    function attach(track) {
      if (track.kind === 'video' || track.kind === 'audio') {
        const el = track.attach();
        if (track.kind === 'video') {
          el.autoplay = true; el.playsInline = true; el.style.width = '100%';
          el.style.borderRadius = '10px';
          document.getElementById('remotes').appendChild(el);
        } else { el.autoplay = true; document.body.appendChild(el); }
      }
    }
    document.getElementById('go').onclick = async () => {
      try {
        log('requesting token...');
        const token = await getToken(false);
        const room = new LivekitClient.Room({ adaptiveStream: true });
        room.on(LivekitClient.RoomEvent.TrackSubscribed, (track) => attach(track));
        await room.connect(WS_URL, token);
        log('connected — waiting for tracks in room ${roomName}');
        room.remoteParticipants.forEach((p) =>
          p.trackPublications.forEach((pub) => { if (pub.track) attach(pub.track); }));
      } catch (e) { log('error: ' + (e && e.message ? e.message : e)); }
    };
  </script>
</body>
</html>`;

  const embed = `${head(`StreamHub · embed · ${ctx.appName}`)}
  <header><b>StreamHub</b> · embeddable player · app <b>${appName}</b></header>
  <main>
    <p>Public URL: <a href="${esc(playUrl)}" style="color:#6ea8ff">${esc(playUrl)}</a></p>
    <iframe id="player" src="${esc(playUrl)}"
            style="width:100%;height:60vh;border:0;border-radius:10px;background:#000"
            allow="autoplay; camera; microphone; fullscreen"></iframe>
    <h3>Embed snippet</h3>
    <textarea readonly style="width:100%;height:90px;background:#0e1530;color:#e6ecff;border:1px solid #25325a;border-radius:8px;padding:10px;font-family:ui-monospace,monospace">&lt;iframe src="${esc(embedUrl)}" width="640" height="360" frameborder="0" allow="autoplay; fullscreen" allowfullscreen&gt;&lt;/iframe&gt;</textarea>
  </main>
</body>
</html>`;

  return { publish, play, embed };
}
