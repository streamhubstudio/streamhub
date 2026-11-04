/* StreamHub Agent — Web UI Frontend v4 */

const YOLO_CLASSES = [
  'person','car','truck','bicycle','motorcycle','bus',
  'dog','cat','bird','horse','cow','sheep',
  'backpack','handbag','suitcase','bottle'
];
const RES_PRESETS = ['1920x1080','1280x720','640x480','640x360','320x240'];
const GAUGE_CIRC = 263.9; /* 2*PI*42 */
const REFRESH_SEC = 30;

/* ── Auth (localStorage) ─────────────────────────────────────────── */

let authToken = localStorage.getItem('sh_auth') || '';

function checkAuth() {
  if (authToken) {
    document.getElementById('login-overlay').classList.add('hidden');
    return true;
  }
  document.getElementById('login-overlay').classList.remove('hidden');
  return false;
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const u = document.getElementById('login-user').value;
  const p = document.getElementById('login-pass').value;
  const token = btoa(u + ':' + p);
  /* Test the credentials */
  try {
    const resp = await fetch('/api/status', {
      headers: { 'Authorization': 'Basic ' + token }
    });
    if (resp.status === 401) {
      document.getElementById('login-error').classList.remove('hidden');
      return;
    }
    authToken = token;
    localStorage.setItem('sh_auth', token);
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('login-error').classList.add('hidden');
    loadDashboard();
  } catch (err) {
    document.getElementById('login-error').textContent = 'Connection error';
    document.getElementById('login-error').classList.remove('hidden');
  }
});

function doLogout() {
  authToken = '';
  localStorage.removeItem('sh_auth');
  document.getElementById('login-overlay').classList.remove('hidden');
}

/* ── API helper ──────────────────────────────────────────────────── */

async function api(path, opts) {
  if (!authToken) { checkAuth(); return null; }
  const headers = { 'Authorization': 'Basic ' + authToken };
  if (opts && opts.body && typeof opts.body === 'string')
    headers['Content-Type'] = 'application/json';
  try {
    const resp = await fetch(path, { ...opts, headers: { ...headers, ...(opts && opts.headers) } });
    if (resp.status === 401) {
      authToken = '';
      localStorage.removeItem('sh_auth');
      checkAuth();
      return null;
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      toast(err.error || 'Request failed', true);
      return null;
    }
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('json')) return resp.json();
    return resp.text();
  } catch (e) {
    toast('Network error: ' + e.message, true);
    return null;
  }
}

/* ── Toast ────────────────────────────────────────────────────────── */

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + (isError ? 'toast-error' : 'toast-success');
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.classList.add('hidden'), 300); }, 3000);
}

/* ── Navigation ───────────────────────────────────────────────────── */

let currentSection = 'dashboard';
let previewInterval = null;
let refreshTimer = null;
let refreshCountdown = REFRESH_SEC;
let trafficTimer = null;
let prevTraffic = null;
let prevCpuStats = null;

function navigate(section) {
  currentSection = section;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById('sec-' + section).classList.add('active');
  document.querySelectorAll('[data-nav]').forEach(b => {
    b.classList.toggle('nav-active', b.dataset.nav === section);
    if (b.dataset.nav !== section) b.classList.remove('nav-active');
  });

  if (section === 'dashboard') loadDashboard();
  else if (section === 'config') loadConfig();
  else if (section === 'cameras') loadCameras();
  else if (section === 'network') loadNetwork();
  else if (section === 'detection') loadDetection();
  else if (section === 'speedtest') {} /* speed test is manual */
  else if (section === 'recordings') loadRecordings();
  else if (section === 'storage') loadStorage();
  else if (section === 'system') loadSystem();

  if (previewInterval) { clearInterval(previewInterval); previewInterval = null; }
  if (section !== 'detection') { stopDetectPreview(); stopZoneBgTimer(); }
  if (section === 'dashboard') previewInterval = setInterval(refreshSnapshots, 5000);

  /* Network traffic polling */
  if (trafficTimer) { clearInterval(trafficTimer); trafficTimer = null; }
  prevTraffic = null;
  if (section === 'network') {
    pollTraffic();
    trafficTimer = setInterval(pollTraffic, 2000);
  }
}

function refreshSnapshots() {
  document.querySelectorAll('.cam-snapshot').forEach(img => {
    const ni = new Image();
    const camId = img.dataset.cam;
    ni.onload = function() { img.src = this.src; img.style.display=''; const sib = img.nextElementSibling; if(sib) sib.style.display='none'; };
    ni.src = '/api/camera/snapshot?cam=' + camId + '&t=' + Date.now();
  });
}

/* ── Gauge helper ─────────────────────────────────────────────────── */

function setGauge(ringId, pct, color) {
  const ring = document.getElementById(ringId);
  if (!ring) return;
  const clamped = Math.max(0, Math.min(100, pct));
  ring.style.strokeDashoffset = GAUGE_CIRC * (1 - clamped / 100);
  if (color) ring.style.stroke = color;
}

function gaugeColor(pct) {
  if (pct > 90) return '#ef4444';
  if (pct > 70) return '#f59e0b';
  return null; /* keep default */
}

/* ── Stream player URL ────────────────────────────────────────────── */

function getPlayerUrl(streamServer, tenant, camId) {
  if (!streamServer) return '';
  let url = streamServer.replace('rtmp://', 'https://').replace('rtmps://', 'https://');
  if (url.endsWith('/')) url = url.slice(0, -1);
  return url + '/play.html?name=' + tenant + '-' + camId;
}

/* ── Dashboard ────────────────────────────────────────────────────── */

async function loadDashboard() {
  const [data, store, hw] = await Promise.all([
    api('/api/status'), api('/api/storage/info'), api('/api/hardware')
  ]);

  if (data) {
    document.getElementById('h-agent-id').textContent = data.agent_id;
    document.getElementById('h-version').textContent = 'v' + data.version;
    document.getElementById('st-agent-uptime').textContent = fmtUptime(data.agent_uptime);
    document.getElementById('st-uptime').textContent = fmtUptime(data.uptime);
    document.getElementById('st-cameras').textContent = data.camera_count || '0';

    const mqttEl = document.getElementById('st-mqtt');
    mqttEl.textContent = data.mqtt_connected ? 'Connected' : 'Disconnected';
    mqttEl.className = 'text-xl font-extrabold mt-1 ' + (data.mqtt_connected ? 'text-emerald-600' : 'text-red-500');
    document.getElementById('h-mqtt-dot').className = 'w-2.5 h-2.5 rounded-full ' + (data.mqtt_connected ? 'bg-emerald-400 shadow-lg shadow-emerald-400/50' : 'bg-red-400');
    document.getElementById('h-mqtt-label').textContent = data.mqtt_connected ? 'Online' : 'Offline';

    /* Temp */
    if (data.temperature != null) {
      const t = data.temperature;
      document.getElementById('h-temp').textContent = t.toFixed(0) + '\u00B0C';
      document.getElementById('g-temp-val').textContent = t.toFixed(0);
      const tempPct = Math.min(100, (t / 85) * 100);
      setGauge('g-temp-ring', tempPct, t > 70 ? '#ef4444' : t > 55 ? '#f59e0b' : '#f59e0b');
    }

    /* RAM gauge */
    if (data.mem_total_mb > 0) {
      const usedMB = data.mem_total_mb - data.mem_free_mb;
      const ramPct = (usedMB / data.mem_total_mb) * 100;
      document.getElementById('g-ram-val').textContent = Math.round(ramPct);
      document.getElementById('g-ram-detail').textContent = Math.round(usedMB) + ' / ' + Math.round(data.mem_total_mb) + ' MB';
      setGauge('g-ram-ring', ramPct, gaugeColor(ramPct));
    }

    /* Load gauge */
    if (data.load != null) {
      document.getElementById('g-load-val').textContent = data.load.toFixed(2);
      setGauge('g-load-ring', Math.min(100, data.load * 50), data.load > 2 ? '#ef4444' : null);
    }

    renderDashCameras(data);
  }

  /* Disk gauge */
  if (store && store.internal) {
    const s = store.internal;
    const pct = s.percent || 0;
    document.getElementById('g-disk-val').textContent = Math.round(pct);
    document.getElementById('g-disk-detail').textContent = Math.round(s.free_mb) + ' MB free';
    setGauge('g-disk-ring', pct, gaugeColor(pct));
  }

  /* CPU gauge from hardware data */
  if (hw) {
    /* CPU usage: compute delta if we have previous */
    const total = (hw.cpu_user||0)+(hw.cpu_nice||0)+(hw.cpu_system||0)+(hw.cpu_idle||0)+(hw.cpu_iowait||0)+(hw.cpu_irq||0);
    const idle = (hw.cpu_idle||0) + (hw.cpu_iowait||0);
    if (prevCpuStats) {
      const dTotal = total - prevCpuStats.total;
      const dIdle = idle - prevCpuStats.idle;
      if (dTotal > 0) {
        const cpuPct = ((dTotal - dIdle) / dTotal) * 100;
        document.getElementById('g-cpu-val').textContent = Math.round(cpuPct);
        setGauge('g-cpu-ring', cpuPct, gaugeColor(cpuPct));
      }
    }
    prevCpuStats = { total, idle };

    if (hw.cpu_freq_mhz) {
      document.getElementById('g-cpu-freq').textContent = Math.round(hw.cpu_freq_mhz) + ' MHz';
    }

    /* Hardware info panel */
    const hwEl = document.getElementById('hw-info');
    hwEl.innerHTML = '';
    const hwRows = [
      ['CPU Freq', hw.cpu_freq_mhz ? Math.round(hw.cpu_freq_mhz) + ' / ' + Math.round(hw.cpu_max_freq_mhz||0) + ' MHz' : 'N/A'],
      ['Governor', hw.cpu_governor || 'N/A'],
      ['Cores Online', hw.cpu_online || 'N/A'],
      ['RAM Total', hw.mem_total_kb ? Math.round(hw.mem_total_kb/1024) + ' MB' : 'N/A'],
      ['RAM Available', hw.mem_available_kb ? Math.round(hw.mem_available_kb/1024) + ' MB' : 'N/A'],
      ['Buffers+Cache', hw.mem_buffers_kb && hw.mem_cached_kb ? Math.round((hw.mem_buffers_kb+hw.mem_cached_kb)/1024) + ' MB' : 'N/A'],
    ];
    hwRows.forEach(([k,v]) => {
      hwEl.innerHTML += `<div class="flex justify-between items-center"><span class="text-gray-500 font-medium">${k}</span><span class="font-mono text-xs font-bold text-gray-800 bg-gray-50 px-2 py-1 rounded">${v}</span></div>`;
    });

    /* NPU panel */
    const npuEl = document.getElementById('npu-info');
    npuEl.innerHTML = '';
    if (hw.npu_available) {
      npuEl.innerHTML = `
        <div class="flex items-center gap-2 mb-2"><span class="badge badge-green">NPU Active</span></div>
        <div class="flex justify-between items-center"><span class="text-gray-500 font-medium">Frequency</span><span class="font-mono text-xs font-bold text-gray-800 bg-gray-50 px-2 py-1 rounded">${hw.npu_freq_mhz ? Math.round(hw.npu_freq_mhz) + ' MHz' : 'N/A'}</span></div>
        <div class="flex justify-between items-center"><span class="text-gray-500 font-medium">Governor</span><span class="font-mono text-xs font-bold text-gray-800 bg-gray-50 px-2 py-1 rounded">${hw.npu_governor||'N/A'}</span></div>
        ${hw.npu_load ? '<div class="flex justify-between items-center"><span class="text-gray-500 font-medium">Load</span><span class="font-mono text-xs font-bold text-gray-800 bg-gray-50 px-2 py-1 rounded">'+esc(hw.npu_load)+'</span></div>' : ''}
      `;
    } else {
      npuEl.innerHTML = '<div class="flex items-center gap-2"><span class="badge badge-gray">NPU Not Detected</span></div><p class="text-xs text-gray-400 mt-2">No Neural Processing Unit found in sysfs.</p>';
    }

    /* Temps */
    if (hw.temperatures && hw.temperatures.length > 0) {
      let tempHtml = '';
      hw.temperatures.forEach(t => {
        tempHtml += `<div class="flex justify-between items-center"><span class="text-gray-500 font-medium">Zone ${t.zone}</span><span class="font-mono text-xs font-bold ${t.temp_c > 70 ? 'text-red-600' : t.temp_c > 55 ? 'text-amber-600' : 'text-gray-800'} bg-gray-50 px-2 py-1 rounded">${t.temp_c.toFixed(1)}&deg;C</span></div>`;
      });
      npuEl.innerHTML += '<div class="mt-3 pt-3 border-t border-gray-100"><p class="text-xs font-bold text-gray-400 uppercase mb-2">Thermal Zones</p>' + tempHtml + '</div>';
    }
  }
}

let streamMode = {}; /* per-camera: 'rtmp' or 'webrtc' */

function renderDashCameras(data) {
  const cont = document.getElementById('dash-cameras');
  if (!data.cameras || data.cameras.length === 0) {
    cont.innerHTML = '<div class="card text-center py-10"><p class="text-gray-400">No cameras configured</p></div>';
    return;
  }
  const streamServer = data.stream_server || '';
  const tenant = data.tenant || '';
  let html = '';
  data.cameras.forEach(cam => {
    const isStreaming = cam.streaming;
    const playerUrl = getPlayerUrl(streamServer, tenant, cam.id);
    const mode = streamMode[cam.id] || 'rtmp';
    const webrtcWs = streamServer ? streamServer.replace('rtmp://', 'wss://').replace('rtmps://', 'wss://').replace(/\/$/, '') + '/websocket' : '';
    html += `<div class="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden">
      <div class="flex items-center justify-between px-5 py-3 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white">
        <div class="flex items-center gap-3">
          <span class="w-3 h-3 rounded-full ${cam.enabled ? (isStreaming ? 'bg-red-500 animate-pulse shadow-lg shadow-red-500/50' : 'bg-emerald-500') : 'bg-gray-300'}"></span>
          <span class="text-sm font-extrabold text-gray-900">${esc(cam.id)}</span>
          ${isStreaming ? '<span class="badge badge-red"><span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span>LIVE</span>' : '<span class="badge badge-gray">Offline</span>'}
          ${cam.detecting ? '<span class="badge badge-green">Detecting</span>' : ''}
        </div>
        <div class="flex items-center gap-2">
          <button onclick="takeLiveSnapshot('${esc(cam.id)}')"
            class="px-3 py-2 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-600 text-white shadow-md shadow-amber-500/25 active:scale-95 transition-all">Snapshot</button>
          <button onclick="toggleDashDetect('${esc(cam.id)}')"
            class="px-3 py-2 rounded-xl text-xs font-bold ${cam.detecting ? 'bg-purple-500 hover:bg-purple-600' : 'bg-gray-400 hover:bg-gray-500'} text-white shadow-md active:scale-95 transition-all">Detect</button>
          <button onclick="toggleStream('${esc(cam.id)}', ${isStreaming})"
            class="px-4 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 shadow-md ${isStreaming
              ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-500/25'
              : 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-emerald-500/25'}">
            ${isStreaming ? 'Stop' : 'Start RTMP'}
          </button>
        </div>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2">
        <div class="relative bg-gray-900 aspect-video flex items-center justify-center">
          <span class="absolute top-2 left-2 px-2.5 py-1 rounded-lg text-[10px] font-bold bg-black/70 text-white backdrop-blur-sm">Snapshot</span>
          <img class="cam-snapshot max-w-full max-h-full object-contain" data-cam="${esc(cam.id)}"
            src="/api/camera/snapshot?cam=${esc(cam.id)}&t=${Date.now()}"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
          <div class="text-gray-500 text-xs flex items-center justify-center w-full h-full absolute inset-0" style="display:none">No snapshot</div>
        </div>
        <div class="relative bg-gray-900 aspect-video flex items-center justify-center">
          <div class="absolute top-2 left-2 z-10 flex items-center gap-1">
            <button onclick="switchStreamMode('${esc(cam.id)}','rtmp')"
              class="px-2 py-0.5 rounded text-[10px] font-bold backdrop-blur-sm transition ${mode==='rtmp' ? 'bg-blue-600 text-white' : 'bg-black/50 text-white/60 hover:text-white'}">RTMP</button>
            <button onclick="switchStreamMode('${esc(cam.id)}','webrtc')"
              class="px-2 py-0.5 rounded text-[10px] font-bold backdrop-blur-sm transition ${mode==='webrtc' ? 'bg-blue-600 text-white' : 'bg-black/50 text-white/60 hover:text-white'}">WebRTC</button>
          </div>
          ${isStreaming && mode === 'rtmp' && playerUrl
            ? '<iframe src="' + esc(playerUrl) + '" class="w-full h-full border-0" allowfullscreen></iframe>'
            : isStreaming && mode === 'webrtc' && webrtcWs
              ? '<video id="webrtc-' + esc(cam.id) + '" autoplay playsinline muted class="w-full h-full object-contain"></video>' +
                '<script>initWebRTC("' + esc(cam.id) + '","' + esc(webrtcWs) + '")<\/script>'
              : '<div class="text-gray-500 text-xs flex items-center justify-center w-full h-full">' +
                (playerUrl ? 'Stream not active' : 'No stream server') + '</div>'}
        </div>
      </div>
    </div>`;
  });
  cont.innerHTML = html;
}

function switchStreamMode(camId, mode) {
  streamMode[camId] = mode;
  loadDashboard();
}

async function takeLiveSnapshot(camId) {
  toast('Capturing snapshot...');
  try {
    const resp = await fetch('/api/camera/snapshot/live', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera_id: camId })
    });
    if (resp.ok) {
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      /* Update the snapshot image */
      const imgs = document.querySelectorAll(`.cam-snapshot[data-cam="${camId}"]`);
      imgs.forEach(img => { img.src = url; img.style.display = ''; const sib = img.nextElementSibling; if(sib) sib.style.display='none'; });
      toast('Snapshot captured');
    } else {
      const err = await resp.json().catch(() => ({}));
      toast(err.error || 'Snapshot failed', true);
    }
  } catch (e) { toast('Error: ' + e.message, true); }
}

/* ── WebRTC via Ant Media ─────────────────────────────────────────── */

function initWebRTC(camId, wsUrl) {
  const video = document.getElementById('webrtc-' + camId);
  if (!video) return;

  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.ontrack = (event) => { video.srcObject = event.streams[0]; };

  const ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    ws.send(JSON.stringify({ command: 'play', streamId: camId }));
  };
  ws.onmessage = async (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.command === 'takeConfiguration') {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: msg.type, sdp: msg.sdp }));
      if (msg.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ command: 'takeConfiguration', streamId: camId, type: 'answer', sdp: answer.sdp }));
      }
    } else if (msg.command === 'takeCandidate') {
      await pc.addIceCandidate(new RTCIceCandidate({ candidate: msg.candidate, sdpMLineIndex: msg.id }));
    }
  };
  pc.onicecandidate = (event) => {
    if (event.candidate && ws.readyState === 1) {
      ws.send(JSON.stringify({ command: 'takeCandidate', streamId: camId, candidate: event.candidate.candidate, id: event.candidate.sdpMLineIndex }));
    }
  };
}

/* ── Network Traffic ──────────────────────────────────────────────── */

async function pollTraffic() {
  const data = await api('/api/network/traffic');
  if (!data || !data.interfaces) return;
  const el = document.getElementById('traffic-data');
  document.getElementById('traffic-status').className = 'badge badge-green';
  document.getElementById('traffic-status').textContent = 'Live';

  let html = '';
  data.interfaces.forEach(iface => {
    let rxRate = '', txRate = '';
    if (prevTraffic) {
      const prev = prevTraffic.find(p => p.name === iface.name);
      if (prev) {
        const dt = 2; /* poll interval seconds */
        const rxBps = (iface.rx_bytes - prev.rx_bytes) / dt;
        const txBps = (iface.tx_bytes - prev.tx_bytes) / dt;
        rxRate = fmtBps(rxBps);
        txRate = fmtBps(txBps);
      }
    }
    html += `<div class="bg-gray-50 rounded-xl p-4">
      <div class="flex items-center justify-between mb-3">
        <span class="font-bold text-gray-800 text-sm">${esc(iface.name)}</span>
        ${rxRate ? '<span class="text-xs text-gray-400">Live</span>' : ''}
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <p class="text-[10px] font-bold text-emerald-500 uppercase">Download (RX)</p>
          <p class="text-lg font-extrabold text-gray-900">${rxRate || 'Measuring...'}</p>
          <p class="text-[10px] text-gray-400">${fmtBytes(iface.rx_bytes)} total / ${iface.rx_packets.toLocaleString()} pkts</p>
          ${iface.rx_errors > 0 ? '<p class="text-[10px] text-red-500">' + iface.rx_errors + ' errors</p>' : ''}
        </div>
        <div>
          <p class="text-[10px] font-bold text-blue-500 uppercase">Upload (TX)</p>
          <p class="text-lg font-extrabold text-gray-900">${txRate || 'Measuring...'}</p>
          <p class="text-[10px] text-gray-400">${fmtBytes(iface.tx_bytes)} total / ${iface.tx_packets.toLocaleString()} pkts</p>
          ${iface.tx_errors > 0 ? '<p class="text-[10px] text-red-500">' + iface.tx_errors + ' errors</p>' : ''}
        </div>
      </div>
    </div>`;
  });
  el.innerHTML = html || '<p class="text-sm text-gray-400">No interfaces found</p>';
  prevTraffic = data.interfaces;
}

/* ── Auto-refresh ─────────────────────────────────────────────────── */

function startAutoRefresh() {
  refreshCountdown = REFRESH_SEC;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshCountdown--;
    const el = document.getElementById('refresh-countdown');
    if (el) el.textContent = refreshCountdown;
    if (refreshCountdown <= 0) {
      refreshCountdown = REFRESH_SEC;
      if (currentSection === 'dashboard') loadDashboard();
    }
  }, 1000);
}

/* ── Formatting helpers ───────────────────────────────────────────── */

function fmtUptime(sec) {
  if (!sec && sec !== 0) return '-';
  sec = Math.floor(sec);
  const d = Math.floor(sec/86400), h = Math.floor((sec%86400)/3600), m = Math.floor((sec%3600)/60);
  let s=''; if (d) s+=d+'d '; if (h||d) s+=h+'h '; s+=m+'m';
  return s;
}

function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes/1048576).toFixed(1) + ' MB';
  return (bytes/1073741824).toFixed(2) + ' GB';
}

function fmtBps(bps) {
  if (bps < 1024) return Math.round(bps) + ' B/s';
  if (bps < 1048576) return (bps/1024).toFixed(1) + ' KB/s';
  return (bps/1048576).toFixed(2) + ' MB/s';
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1048576).toFixed(1) + ' MB';
}

/* ── Configuration ────────────────────────────────────────────────── */

let configData = null;

async function loadConfig() {
  configData = await api('/api/config');
  if (!configData) return;
  const f = document.getElementById('config-form');
  setInput(f,'agent.id',configData.agent.id);
  setInput(f,'agent.tenant',configData.agent.tenant);
  setInput(f,'agent.store_id',configData.agent.store_id);
  setInput(f,'agent.alias',configData.agent.alias);
  setInput(f,'agent.timezone',configData.agent.timezone);
  setInput(f,'agent.records_ttl',configData.agent.records_ttl);
  setInput(f,'agent.latitude',configData.agent.latitude||'');
  setInput(f,'agent.longitude',configData.agent.longitude||'');
  setCheck(f,'agent.records_enabled',configData.agent.records_enabled);
  setCheck(f,'agent.rtmps',configData.agent.rtmps);
  setInput(f,'agent.stream_server',configData.agent.stream_server);
  setInput(f,'agent.snapshots_url',configData.agent.snapshots_url);
  setInput(f,'agent.callback_url',configData.agent.callback_url);
  setInput(f,'mqtt.host',configData.mqtt.host);
  setInput(f,'mqtt.port',configData.mqtt.port);
  setInput(f,'storage.endpoint',configData.storage.endpoint);
  setInput(f,'storage.bucket',configData.storage.bucket);
  setInput(f,'storage.region',configData.storage.region);
  setInput(f,'storage.access_key',configData.storage.access_key);
  setInput(f,'storage.secret_key',configData.storage.secret_key);
}

document.getElementById('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = {
    agent: { id: getInput(f,'agent.id'), tenant: getInput(f,'agent.tenant'),
      store_id: getInput(f,'agent.store_id'), alias: getInput(f,'agent.alias'),
      timezone: getInput(f,'agent.timezone'), records_ttl: parseInt(getInput(f,'agent.records_ttl'))||30,
      latitude: parseFloat(getInput(f,'agent.latitude'))||0,
      longitude: parseFloat(getInput(f,'agent.longitude'))||0,
      records_enabled: getCheck(f,'agent.records_enabled'), rtmps: getCheck(f,'agent.rtmps'),
      stream_server: getInput(f,'agent.stream_server'), snapshots_url: getInput(f,'agent.snapshots_url'),
      callback_url: getInput(f,'agent.callback_url') },
    mqtt: { host: getInput(f,'mqtt.host'), port: parseInt(getInput(f,'mqtt.port'))||1883 },
    storage: { endpoint: getInput(f,'storage.endpoint'), bucket: getInput(f,'storage.bucket'),
      region: getInput(f,'storage.region'), access_key: getInput(f,'storage.access_key'),
      secret_key: getInput(f,'storage.secret_key') }
  };
  const r = await api('/api/config', { method:'POST', body:JSON.stringify(payload) });
  if (r && r.ok) toast('Configuration saved');
});

/* ── Cameras ──────────────────────────────────────────────────────── */

let cameraData = [];

async function loadCameras() {
  const [cfg, status] = await Promise.all([api('/api/config'), api('/api/status')]);
  if (!cfg) return;
  cameraData = cfg.cameras || [];
  if (status && status.cameras) {
    cameraData.forEach(cam => {
      const sc = status.cameras.find(c => c.id === cam.id);
      if (sc) { cam.streaming = sc.streaming; cam.rtmp_url = sc.rtmp_url || ''; }
    });
  }
  renderCameras();
}

function renderCameras() {
  const list = document.getElementById('cameras-list');
  list.innerHTML = '';
  cameraData.forEach((cam, i) => {
    const streaming = cam.streaming || false;
    list.innerHTML += `
    <div class="border-2 border-gray-100 rounded-2xl p-5 bg-gray-50/50">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <span class="w-3 h-3 rounded-full ${streaming ? 'bg-red-500 animate-pulse' : (cam.enabled ? 'bg-emerald-500' : 'bg-gray-300')}"></span>
          <span class="text-sm font-bold text-gray-800">Camera ${i+1}</span>
          ${streaming ? '<span class="badge badge-red">LIVE</span>' : ''}
        </div>
        <div class="flex items-center gap-3">
          <button onclick="toggleStream('${esc(cam.id)}', ${streaming})"
            class="text-xs px-4 py-2 rounded-xl font-bold transition-all active:scale-95 shadow-md ${streaming
              ? 'bg-red-500 hover:bg-red-600 text-white'
              : 'bg-emerald-500 hover:bg-emerald-600 text-white'}">
            ${streaming ? 'Stop RTMP' : 'Start RTMP'}
          </button>
          <button onclick="removeCamera(${i})" class="text-xs text-red-500 hover:text-red-700 font-bold">Remove</button>
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div><label class="field-label">ID</label><input name="cam_${i}_id" value="${esc(cam.id)}" class="field-input text-xs"></div>
        <div><label class="field-label">IP</label><input name="cam_${i}_ip" value="${esc(cam.ip)}" class="field-input text-xs"></div>
        <div><label class="field-label">Resolution</label>
          <select name="cam_${i}_resolution" class="field-input text-xs">
            ${RES_PRESETS.map(r=>`<option value="${r}" ${cam.resolution===r?'selected':''}>${r}</option>`).join('')}
            <option value="custom" ${!RES_PRESETS.includes(cam.resolution)&&cam.resolution?'selected':''}>Custom...</option>
          </select>
        </div>
        <div class="md:col-span-2"><label class="field-label">RTSP URL</label><input name="cam_${i}_rtsp" value="${esc(cam.rtsp)}" class="field-input text-xs"></div>
        <div class="flex items-end pb-1">
          <label class="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
            <input name="cam_${i}_enabled" type="checkbox" ${cam.enabled?'checked':''} class="w-5 h-5 rounded-lg text-blue-600"> Enabled
          </label>
        </div>
      </div>
    </div>`;
  });
}

function addCamera() {
  cameraData.push({ id:'cam'+(cameraData.length+1), ip:'', enabled:true, rtsp:'', resolution:'1280x720', record_path:'' });
  renderCameras();
}

function removeCamera(idx) {
  if (!confirm('Remove camera '+(idx+1)+'?')) return;
  cameraData.splice(idx, 1);
  renderCameras();
}

function setAllResolution(res) {
  document.querySelectorAll('[name^="cam_"][name$="_resolution"]').forEach(sel => { if(sel.tagName==='SELECT') sel.value=res; });
}

async function saveCameras() {
  const cameras = [];
  for (let i = 0; i < cameraData.length; i++) {
    const f = document;
    let res = f.querySelector(`[name="cam_${i}_resolution"]`)?.value || '';
    cameras.push({
      id: f.querySelector(`[name="cam_${i}_id"]`)?.value || '',
      ip: f.querySelector(`[name="cam_${i}_ip"]`)?.value || '',
      rtsp: f.querySelector(`[name="cam_${i}_rtsp"]`)?.value || '',
      resolution: res === 'custom' ? cameraData[i].resolution : res,
      enabled: f.querySelector(`[name="cam_${i}_enabled"]`)?.checked || false,
      record_path: cameraData[i].record_path || '',
    });
  }
  const cfg = await api('/api/config');
  if (!cfg) return;
  cfg.cameras = cameras;
  const r = await api('/api/config', { method:'POST', body:JSON.stringify(cfg) });
  if (r && r.ok) { toast('Cameras saved'); cameraData = cameras; }
}

/* ── Stream toggle ────────────────────────────────────────────────── */

async function toggleStream(camId, isStreaming) {
  const endpoint = isStreaming ? '/api/stream/stop' : '/api/stream/start';
  const r = await api(endpoint, { method:'POST', body:JSON.stringify({ camera_id: camId }) });
  if (r && r.ok) {
    toast(isStreaming ? 'Stream stopped' : 'Stream started');
    setTimeout(() => {
      if (currentSection === 'dashboard') loadDashboard();
      else if (currentSection === 'cameras') loadCameras();
    }, 1500);
  }
}

/* ── Network ──────────────────────────────────────────────────────── */

async function loadNetwork() {
  const data = await api('/api/network');
  if (!data) return;
  const f = document.getElementById('network-form');
  setInput(f,'ip',data.ip); setInput(f,'netmask',data.netmask);
  setInput(f,'gateway',data.gateway); setInput(f,'dns',data.dns);
  document.getElementById('raw-ifconfig').textContent = data.raw_ifconfig || '';
}

document.getElementById('network-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const r = await api('/api/network', { method:'POST', body:JSON.stringify({
    ip:getInput(f,'ip'), netmask:getInput(f,'netmask'),
    gateway:getInput(f,'gateway'), dns:getInput(f,'dns')
  })});
  if (r && r.ok) { toast('Network settings applied'); setTimeout(loadNetwork, 2000); }
});

/* ── Detection (per-camera) ───────────────────────────────────────── */

let currentDetectCam = '';
let detectPreviewTimer = null;
let detectEventsTimer = null;
let zoneBgTimer = null;

async function loadDetection() {
  /* Populate camera selector */
  const status = await api('/api/status');
  if (!status) return;
  const sel = document.getElementById('detect-cam-select');
  sel.innerHTML = '';
  (status.cameras || []).forEach(cam => {
    const opt = document.createElement('option');
    opt.value = cam.id;
    opt.textContent = `${cam.id}${cam.detecting ? ' (detecting)' : ''}`;
    sel.appendChild(opt);
  });
  if (status.cameras && status.cameras.length > 0) {
    currentDetectCam = status.cameras[0].id;
    loadCameraDetection(currentDetectCam);
  }
}

async function loadCameraDetection(camId) {
  if (!camId) return;
  currentDetectCam = camId;

  const data = await api(`/api/yolo/config?cam=${camId}`);
  if (!data) return;
  const f = document.getElementById('yolo-form');
  setCheck(f, 'enabled', data.enabled);
  f.querySelector('[name="model"]').value = data.model || 'yolo11n';
  f.querySelector('[name="confidence"]').value = data.confidence || 0.5;
  document.getElementById('conf-value').textContent = (data.confidence || 0.5).toFixed(2);
  f.querySelector('[name="fps"]').value = data.fps || 2;
  f.querySelector('[name="tracker"]').value = data.tracker || 'bytetrack';
  setCheck(f, 'notify_mqtt', data.notify_mqtt);

  const c = document.getElementById('target-classes');
  c.innerHTML = '';
  const active = data.targets || [];
  YOLO_CLASSES.forEach(cls => {
    c.innerHTML += `<label class="flex items-center gap-2 text-xs font-medium text-gray-700 py-1 cursor-pointer"><input type="checkbox" name="target_${cls}" ${active.includes(cls)?'checked':''} class="w-4 h-4 rounded text-blue-600 yolo-target" data-class="${cls}"> ${cls}</label>`;
  });

  /* Update start/stop button and preview */
  loadZones();
  const st = await api('/api/status');
  const camSt = st && (st.cameras || []).find(c => c.id === camId);
  if (camSt && camSt.detecting) checkDetectPreview();
  else stopDetectPreview();
  updateDetectToggle();
}

async function updateDetectToggle() {
  const status = await api('/api/status');
  if (!status) return;
  const cam = (status.cameras || []).find(c => c.id === currentDetectCam);
  const btn = document.getElementById('detect-toggle-btn');
  if (cam && cam.detecting) {
    btn.textContent = 'Stop Detection';
    btn.className = 'btn-outline text-xs text-red-600 border-red-200';
  } else {
    btn.textContent = 'Start Detection';
    btn.className = 'btn-outline text-xs';
  }
}

async function toggleDetection() {
  const status = await api('/api/status');
  if (!status) return;
  const cam = (status.cameras || []).find(c => c.id === currentDetectCam);
  if (cam && cam.detecting) {
    await api(`/api/camera/detection/stop?cam=${currentDetectCam}`, { method: 'POST' });
    toast('Detection stopped');
    stopDetectPreview();
  } else {
    await api(`/api/camera/detection/start?cam=${currentDetectCam}`, { method: 'POST' });
    toast('Detection started');
    setTimeout(checkDetectPreview, 2000);
  }
  setTimeout(updateDetectToggle, 1000);
}

function checkDetectPreview() {
  stopDetectPreview();
  const card = document.getElementById('detect-preview-card');
  const img = document.getElementById('detect-preview-img');
  if (!card || !img) return;

  let errCount = 0;
  function refreshPreview() {
    const test = new Image();
    test.onload = () => { img.src = test.src; errCount = 0; };
    test.onerror = () => { if (++errCount > 5) stopDetectPreview(); };
    test.src = `/api/camera/detection/preview?cam=${currentDetectCam}&t=${Date.now()}`;
  }
  function refreshEvents() {
    api(`/api/camera/detection/events?cam=${currentDetectCam}`).then(data => {
      if (!data) return;
      const badge = document.getElementById('detect-badge');
      const info = document.getElementById('detect-events-info');
      if (badge) badge.textContent = `${data.count || 0} objects`;
      if (info) {
        let html = '';
        const counts = {};
        (data.detections || []).forEach(d => { counts[d.class] = (counts[d.class]||0) + 1; });
        const parts = Object.entries(counts).map(([k,v]) => `${v} ${k}${v>1?'s':''}`);
        if (parts.length) html += `<p>${parts.join(', ')}</p>`;
        if (data.line_counts) {
          Object.entries(data.line_counts).forEach(([name, c]) => {
            html += `<p class="text-xs text-gray-400">${name}: Entry ${c.entry}, Exit ${c.exit}</p>`;
          });
        }
        info.innerHTML = html || '<p class="text-gray-400">No detections</p>';
      }
      /* Resource metrics */
      if (data.resources) {
        const r = data.resources;
        const el = id => document.getElementById(id);
        if (el('detect-cpu')) el('detect-cpu').textContent = r.cpu_percent != null ? r.cpu_percent + '%' : '--';
        if (el('detect-ram')) el('detect-ram').textContent = r.mem_percent != null ? r.mem_percent + '%' : '--';
        if (el('detect-proc-mem')) el('detect-proc-mem').textContent = r.proc_mem_mb != null ? r.proc_mem_mb + ' MB' : '--';
        if (r.gpu && el('detect-gpu-card')) {
          el('detect-gpu-card').classList.remove('hidden');
          el('detect-gpu').textContent = r.gpu.gpu_percent + '%';
        }
      }
    });
  }

  card.classList.remove('hidden');
  refreshPreview();
  refreshEvents();
  detectPreviewTimer = setInterval(refreshPreview, 500);
  detectEventsTimer = setInterval(refreshEvents, 2000);
}

function stopDetectPreview() {
  if (detectPreviewTimer) { clearInterval(detectPreviewTimer); detectPreviewTimer = null; }
  if (detectEventsTimer) { clearInterval(detectEventsTimer); detectEventsTimer = null; }
  stopZoneBgTimer();
  const card = document.getElementById('detect-preview-card');
  if (card) card.classList.add('hidden');
  /* Reset resource cards */
  const el = id => document.getElementById(id);
  if (el('detect-cpu')) el('detect-cpu').textContent = '--';
  if (el('detect-ram')) el('detect-ram').textContent = '--';
  if (el('detect-proc-mem')) el('detect-proc-mem').textContent = '--';
  if (el('detect-gpu-card')) el('detect-gpu-card').classList.add('hidden');
}

async function toggleDashDetect(camId) {
  const status = await api('/api/status');
  if (!status) return;
  const cam = (status.cameras || []).find(c => c.id === camId);
  if (cam && cam.detecting) {
    await api(`/api/camera/detection/stop?cam=${camId}`, { method: 'POST' });
    toast('Detection stopped for ' + camId);
  } else {
    await api(`/api/camera/detection/start?cam=${camId}`, { method: 'POST' });
    toast('Detection started for ' + camId);
  }
  setTimeout(loadDashboard, 1000);
}

document.getElementById('yolo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const targets = [];
  f.querySelectorAll('.yolo-target:checked').forEach(cb => targets.push(cb.dataset.class));
  const r = await api(`/api/yolo/config?cam=${currentDetectCam}`, { method:'POST', body:JSON.stringify({
    enabled:getCheck(f,'enabled'),
    model: f.querySelector('[name="model"]').value,
    confidence:parseFloat(f.querySelector('[name="confidence"]').value),
    fps: parseInt(f.querySelector('[name="fps"]').value),
    tracker: f.querySelector('[name="tracker"]').value,
    notify_mqtt:getCheck(f,'notify_mqtt'),
    targets
  })});
  if (r && r.ok) toast('Detection settings saved');
});

/* ── Detection Zones & Lines ──────────────────────────────────────── */

let zoneMode = null, currentPoints = [], allZones = [], allLines = [];

function initCanvas() {
  const canvas = document.getElementById('zone-canvas');
  if (!canvas) return;
  canvas.addEventListener('click', onCanvasClick);
  window.addEventListener('resize', drawCanvas);
}

function onCanvasClick(e) {
  if (!zoneMode) return;
  const canvas = e.target;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  currentPoints.push([x, y]);
  if (zoneMode === 'line' && currentPoints.length >= 2) {
    allLines.push({ name: 'Line ' + (allLines.length+1), enabled: true,
      x1: currentPoints[0][0], y1: currentPoints[0][1],
      x2: currentPoints[1][0], y2: currentPoints[1][1] });
    currentPoints = []; zoneMode = null;
  }
  drawCanvas();
}

function finishShape() {
  if (zoneMode === 'polygon' && currentPoints.length >= 3) {
    allZones.push({ name: 'Zone ' + (allZones.length+1), enabled: true, points: [...currentPoints] });
    currentPoints = []; zoneMode = null; drawCanvas();
  } else if (currentPoints.length > 0) {
    currentPoints = []; zoneMode = null; drawCanvas();
  }
}

function clearZones() { allZones = []; allLines = []; currentPoints = []; drawCanvas(); updateZonesList(); }

function drawCanvas() {
  const canvas = document.getElementById('zone-canvas');
  if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width; canvas.height = rect.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const w = canvas.width, h = canvas.height;
  const zc = ['rgba(59,130,246,0.3)','rgba(16,185,129,0.3)','rgba(245,158,11,0.3)','rgba(239,68,68,0.3)'];
  const lc = ['#3b82f6','#10b981','#f59e0b','#ef4444'];
  allZones.forEach((z, zi) => {
    if (!z.enabled || z.points.length < 3) return;
    ctx.beginPath(); ctx.moveTo(z.points[0][0]*w, z.points[0][1]*h);
    for (let i = 1; i < z.points.length; i++) ctx.lineTo(z.points[i][0]*w, z.points[i][1]*h);
    ctx.closePath(); ctx.fillStyle = zc[zi%zc.length]; ctx.fill();
    ctx.strokeStyle = lc[zi%lc.length]; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = lc[zi%lc.length]; ctx.font = '12px sans-serif';
    ctx.fillText(z.name, z.points[0][0]*w+4, z.points[0][1]*h-4);
  });
  allLines.forEach((l) => {
    if (!l.enabled) return;
    ctx.beginPath(); ctx.moveTo(l.x1*w, l.y1*h); ctx.lineTo(l.x2*w, l.y2*h);
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = '#ef4444'; ctx.font = 'bold 11px sans-serif';
    ctx.fillText(l.name, (l.x1+l.x2)/2*w+4, (l.y1+l.y2)/2*h-4);
  });
  if (currentPoints.length > 0) {
    ctx.beginPath(); ctx.moveTo(currentPoints[0][0]*w, currentPoints[0][1]*h);
    for (let i = 1; i < currentPoints.length; i++) ctx.lineTo(currentPoints[i][0]*w, currentPoints[i][1]*h);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([5,5]); ctx.stroke(); ctx.setLineDash([]);
    currentPoints.forEach(p => { ctx.beginPath(); ctx.arc(p[0]*w, p[1]*h, 4, 0, Math.PI*2); ctx.fillStyle = '#fff'; ctx.fill(); });
  }
  updateZonesList();
}

function updateZonesList() {
  const el = document.getElementById('zones-list');
  if (!el) return;
  let html = '';
  allZones.forEach((z,i) => { html += `<div class="flex justify-between items-center py-1"><span>${esc(z.name)} (${z.points.length} pts)</span><button onclick="allZones.splice(${i},1);drawCanvas()" class="text-red-500 text-xs font-bold">Remove</button></div>`; });
  allLines.forEach((l,i) => { html += `<div class="flex justify-between items-center py-1"><span>${esc(l.name)} (line)</span><button onclick="allLines.splice(${i},1);drawCanvas()" class="text-red-500 text-xs font-bold">Remove</button></div>`; });
  el.innerHTML = html || '<span class="text-gray-400">No zones or lines defined</span>';
}

async function loadZones() {
  if (!currentDetectCam) return;
  const data = await api(`/api/yolo/zones?cam=${currentDetectCam}`);
  if (!data) return;
  allZones = (data.zones||[]).map(z => ({ name:z.name, enabled:z.enabled, points:z.points }));
  allLines = (data.lines||[]).map(l => ({ name:l.name, enabled:l.enabled, x1:l.x1, y1:l.y1, x2:l.x2, y2:l.y2 }));
  updateZoneBg();
  setTimeout(drawCanvas, 200);
}

function stopZoneBgTimer() {
  if (zoneBgTimer) { clearInterval(zoneBgTimer); zoneBgTimer = null; }
}

async function updateZoneBg() {
  stopZoneBgTimer();
  if (!currentDetectCam) return;
  const bg = document.getElementById('zone-bg');
  if (!bg) return;

  async function refreshZoneBg() {
    const st = await api('/api/status');
    const cam = st && (st.cameras || []).find(c => c.id === currentDetectCam);
    if (cam && cam.detecting) {
      bg.src = `/api/camera/detection/preview?cam=${currentDetectCam}&t=${Date.now()}`;
    } else {
      bg.src = `/api/camera/snapshot?cam=${currentDetectCam}&t=${Date.now()}`;
      stopZoneBgTimer();
    }
  }

  /* Initial load */
  const st = await api('/api/status');
  const cam = st && (st.cameras || []).find(c => c.id === currentDetectCam);
  if (cam && cam.detecting) {
    bg.src = `/api/camera/detection/preview?cam=${currentDetectCam}&t=${Date.now()}`;
    zoneBgTimer = setInterval(refreshZoneBg, 1000);
  } else {
    bg.src = `/api/camera/snapshot?cam=${currentDetectCam}&t=${Date.now()}`;
  }
}

async function saveZones() {
  if (!currentDetectCam) { toast('Select a camera first'); return; }
  const r = await api(`/api/yolo/zones?cam=${currentDetectCam}`, { method:'POST', body:JSON.stringify({ zones:allZones, lines:allLines }) });
  if (r && r.ok) toast('Zones and lines saved');
}

/* ── Recordings ───────────────────────────────────────────────────── */

async function loadRecordings() {
  const data = await api('/api/recordings');
  if (!data) return;
  const sel = document.getElementById('rec-camera');
  sel.innerHTML = '<option value="">-- Select Camera --</option>';
  (data.cameras || []).forEach(c => {
    sel.innerHTML += '<option value="' + esc(c.id) + '">' + esc(c.id) + '</option>';
  });
  document.getElementById('rec-date').innerHTML = '<option value="">Select camera first</option>';
  document.getElementById('rec-files').innerHTML = '';
  document.getElementById('rec-empty').classList.add('hidden');
}

async function loadRecDates() {
  const cam = document.getElementById('rec-camera').value;
  const dateSel = document.getElementById('rec-date');
  if (!cam) {
    dateSel.innerHTML = '<option value="">Select camera first</option>';
    document.getElementById('rec-files').innerHTML = '';
    return;
  }
  const data = await api('/api/recordings?cam=' + encodeURIComponent(cam));
  if (!data) return;
  dateSel.innerHTML = '<option value="">-- Select Date --</option>';
  (data.dates || []).forEach(d => {
    dateSel.innerHTML += '<option value="' + esc(d) + '">' + esc(d) + '</option>';
  });
  /* Auto-select first (most recent) date */
  if (data.dates && data.dates.length > 0) {
    dateSel.value = data.dates[0];
    loadRecFiles();
  } else {
    document.getElementById('rec-files').innerHTML = '';
    document.getElementById('rec-empty').classList.remove('hidden');
  }
}

async function loadRecFiles() {
  const cam = document.getElementById('rec-camera').value;
  const date = document.getElementById('rec-date').value;
  const cont = document.getElementById('rec-files');
  const empty = document.getElementById('rec-empty');
  if (!cam || !date) { cont.innerHTML = ''; empty.classList.add('hidden'); return; }
  const data = await api('/api/recordings?cam=' + encodeURIComponent(cam) + '&date=' + encodeURIComponent(date));
  if (!data || !data.files || data.files.length === 0) {
    cont.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  /* Sort by mtime descending */
  const files = data.files.sort((a, b) => b.mtime - a.mtime);
  let html = '';
  files.forEach(f => {
    const time = new Date(f.mtime * 1000).toLocaleTimeString();
    html += '<div class="flex items-center gap-3 py-2.5 px-3 hover:bg-blue-50 rounded-xl transition">'
      + '<svg class="w-5 h-5 text-red-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm3 2h6v4H7V5zm8 8v2h1v-2h-1zm-2-2H7v4h6v-4zm2 0h1V9h-1v2zm-2-4v2h2V7h-2zM5 9v2h2V9H5zm0 4v2h2v-2H5z" clip-rule="evenodd"/></svg>'
      + '<span class="text-sm text-gray-700 flex-1 font-medium">' + esc(f.name) + '</span>'
      + '<span class="text-xs text-gray-400">' + time + '</span>'
      + '<span class="text-xs text-gray-500 font-mono">' + fmtSize(f.size) + '</span>'
      + '<button onclick="playRecording(\'' + esc(f.path).replace(/'/g, "\\'") + '\',\'' + esc(f.name).replace(/'/g, "\\'") + '\')" '
      + 'class="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-500 hover:bg-blue-600 text-white transition active:scale-95">Play</button>'
      + '</div>';
  });
  cont.innerHTML = html;
}

function playRecording(path, name) {
  const card = document.getElementById('rec-player-card');
  const video = document.getElementById('rec-video');
  const title = document.getElementById('rec-player-title');
  const dl = document.getElementById('rec-download');
  const url = '/api/recordings/play?path=' + encodeURIComponent(path);
  video.src = url;
  title.textContent = name || 'Video Player';
  dl.href = url;
  dl.download = name || 'recording.mp4';
  card.classList.remove('hidden');
  card.scrollIntoView({ behavior: 'smooth' });
}

/* ── Storage ──────────────────────────────────────────────────────── */

async function loadStorage() {
  const data = await api('/api/storage/info');
  if (!data) return;
  const cont = document.getElementById('storage-info');
  cont.innerHTML = '';
  ['internal','external'].forEach(key => {
    const s = data[key];
    if (!s || s.available === false) {
      if (key === 'external') cont.innerHTML += '<div class="text-sm text-gray-400">No external storage detected</div>';
      return;
    }
    const pct = s.percent || 0;
    const color = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-blue-500';
    cont.innerHTML += `<div>
      <div class="flex justify-between items-center mb-1"><span class="text-sm font-bold text-gray-700 capitalize">${key}</span><span class="text-xs text-gray-500">${s.path||''}</span></div>
      <div class="h-4 rounded-full overflow-hidden bg-gray-200"><div class="h-full rounded-full transition-all duration-500 ${color}" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="flex justify-between text-xs text-gray-500 mt-1"><span>Used: ${Math.round(s.used_mb)} MB (${pct.toFixed(1)}%)</span><span>Free: ${Math.round(s.free_mb)} / ${Math.round(s.total_mb)} MB</span></div>
    </div>`;
  });
  const sd = document.getElementById('sdcard-info');
  sd.innerHTML = data.sd_available
    ? '<span class="badge badge-green">SD card detected</span>' + (data.sd_mount ? ' at <span class="font-mono text-xs">'+esc(data.sd_mount)+'</span>' : '')
    : '<span class="badge badge-gray">No SD card</span>';
  /* Build file browser buttons from actual runtime paths */
  const recBase = (data.record_base || '/userdata/records').replace(/^\.\//, '');
  const snapDir = (data.snapshot_dir || '/tmp/snapshots').replace(/^\.\//, '');
  const sdMount = data.sd_mount || '';
  const btns = document.getElementById('file-browser-btns');
  let btnHtml = `<button onclick="browseFiles('${esc(recBase)}')" class="btn-outline text-xs">Recordings</button>`;
  btnHtml += `<button onclick="browseFiles('${esc(snapDir)}')" class="btn-outline text-xs">Snapshots</button>`;
  if (sdMount) btnHtml += `<button onclick="browseFiles('${esc(sdMount)}')" class="btn-outline text-xs">SD Card</button>`;
  btns.innerHTML = btnHtml;
  browseFiles(recBase);
}

async function formatSD(fstype) {
  if (!confirm('Format SD card as '+fstype+'? This will ERASE ALL DATA!')) return;
  const r = await api('/api/storage/sdcard/format', { method:'POST', body:JSON.stringify({filesystem:fstype}) });
  if (r && r.ok) toast('SD card formatted');
}
async function eraseSD() {
  if (!confirm('Erase all recordings and snapshots from SD card?')) return;
  const r = await api('/api/storage/sdcard/erase', { method:'POST' });
  if (r && r.ok) toast('SD card contents erased');
}

/* ── File Browser ─────────────────────────────────────────────────── */

async function browseFiles(path) {
  /* Strip ./ prefix (browsers normalize it away in URLs) */
  const cleanPath = path.replace(/^\.\//, '');
  document.getElementById('file-path').textContent = cleanPath;
  const sep = cleanPath.startsWith('/') ? '' : '/';
  const data = await api('/api/files' + sep + cleanPath);
  if (!data) { document.getElementById('file-list').innerHTML = '<p class="text-sm text-gray-400 py-3">Cannot access path</p>'; return; }
  const list = document.getElementById('file-list');
  const entries = (data.entries||[]).sort((a,b) => b.is_dir - a.is_dir || a.name.localeCompare(b.name));
  let html = '';
  const parts = cleanPath.split('/').filter(Boolean);
  if (parts.length > 1) {
    const parent = cleanPath.startsWith('/') ? '/' + parts.slice(0,-1).join('/') : parts.slice(0,-1).join('/');
    html += `<div class="flex items-center gap-3 py-2.5 px-3 hover:bg-blue-50 cursor-pointer rounded-xl transition" onclick="browseFiles('${parent}')"><span class="text-blue-500 font-bold">../</span><span class="text-sm text-blue-600 font-medium">Parent Directory</span></div>`;
  }
  entries.forEach(e => {
    const icon = e.is_dir ? '<svg class="w-5 h-5 text-amber-500" fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>'
      : '<svg class="w-5 h-5 text-gray-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clip-rule="evenodd"/></svg>';
    if (e.is_dir) { const ep = (e.path||'').replace(/^\.\//, ''); html += `<div class="flex items-center gap-3 py-2.5 px-3 hover:bg-blue-50 cursor-pointer rounded-xl transition" onclick="browseFiles('${esc(ep)}')">${icon}<span class="text-sm text-blue-600 font-medium flex-1">${esc(e.name)}</span><span class="text-xs text-gray-400">${e.mtime ? new Date(e.mtime*1000).toLocaleString() : ''}</span></div>`; }
    else html += `<div class="flex items-center gap-3 py-2.5 px-3 hover:bg-gray-50 rounded-xl">${icon}<span class="text-sm text-gray-700 flex-1">${esc(e.name)}</span><span class="text-xs text-gray-500 font-mono">${fmtSize(e.size)}</span><span class="text-xs text-gray-400">${e.mtime ? new Date(e.mtime*1000).toLocaleString() : ''}</span></div>`;
  });
  list.innerHTML = html || '<p class="text-sm text-gray-400 py-3">Empty directory</p>';
}

/* ── System ───────────────────────────────────────────────────────── */

async function loadSystem() {
  const [info, fw] = await Promise.all([api('/api/system/info'), api('/api/system/firmware/versions')]);
  if (info) {
    const el = document.getElementById('system-info');
    el.innerHTML = '';
    [['Agent ID',info.agent_id],['Version','v'+info.version],['System',info.sysname],
     ['Hostname',info.nodename],['Kernel',info.release],['Architecture',info.machine],
     ['Temperature', info.temperature != null ? info.temperature.toFixed(1)+'\u00B0C' : 'N/A']
    ].forEach(([k,v]) => {
      if (v) el.innerHTML += `<div class="flex justify-between items-center"><span class="text-gray-500 font-medium">${k}</span><span class="font-mono text-xs font-bold text-gray-800 bg-gray-50 px-3 py-1 rounded-lg">${esc(String(v))}</span></div>`;
    });
  }
  if (fw) {
    const el = document.getElementById('firmware-info');
    let html = '';
    if (fw.has_backup) html += '<span class="badge badge-green mr-1">Backup available</span>';
    if (fw.has_pending) html += '<span class="badge badge-blue mr-1">Pending update</span>';
    if (!fw.has_backup && !fw.has_pending) html += '<span class="badge badge-gray">No backup</span>';
    el.innerHTML = html;
  }
  loadLogs();
}

async function loadLogs() {
  const data = await api('/api/system/logs');
  if (data) document.getElementById('system-logs').textContent = data.logs || 'No logs available';
}

async function doReboot() {
  if (!confirm('Are you sure you want to reboot?')) return;
  const r = await api('/api/system/reboot', { method:'POST' });
  if (r && r.ok) toast('Device is rebooting...');
}

async function doFactoryReset() {
  if (!confirm('FACTORY RESET: This will erase all settings. Continue?')) return;
  if (!confirm('Are you absolutely sure?')) return;
  const r = await api('/api/system/factory-reset', { method:'POST' });
  if (r && r.ok) toast('Factory reset applied');
}

/* ── Firmware ─────────────────────────────────────────────────────── */

async function uploadFirmware() {
  const input = document.getElementById('firmware-file');
  if (!input.files.length) { toast('Select a firmware file first', true); return; }
  const file = input.files[0];
  if (file.size > 2*1024*1024) { toast('File too large (max 2MB)', true); return; }
  if (!confirm('Upload firmware: '+file.name+' ('+fmtSize(file.size)+')?')) return;
  const prog = document.getElementById('upload-progress');
  const bar = document.getElementById('upload-bar');
  const status = document.getElementById('upload-status');
  prog.classList.remove('hidden'); bar.style.width = '0%'; status.textContent = 'Uploading...';
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/system/firmware');
  xhr.setRequestHeader('Authorization', 'Basic ' + authToken);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const p=(e.loaded/e.total*100).toFixed(0); bar.style.width=p+'%'; status.textContent='Uploading... '+p+'%'; }};
  xhr.onload = () => { if (xhr.status===200) { bar.style.width='100%'; status.textContent='Complete!'; toast('Firmware uploaded'); loadSystem(); } else { status.textContent='Failed'; toast('Upload failed',true); }};
  xhr.onerror = () => { status.textContent='Error'; toast('Network error',true); };
  xhr.send(file);
}
async function applyFirmware() { if (!confirm('Apply pending firmware? Device will reboot.')) return; const r = await api('/api/system/firmware/apply',{method:'POST'}); if (r&&r.ok) toast('Applying firmware...'); }
async function rollbackFirmware() { if (!confirm('Rollback firmware? Device will reboot.')) return; const r = await api('/api/system/firmware/rollback',{method:'POST'}); if (r&&r.ok) toast('Rolling back...'); }

/* ── Setup from URL ───────────────────────────────────────────────── */

function showSetupModal() { document.getElementById('setup-modal').classList.remove('hidden'); }
function hideSetupModal() { document.getElementById('setup-modal').classList.add('hidden'); }
async function runSetup() {
  const url = document.getElementById('setup-url').value.trim();
  if (!url) { toast('Enter a setup URL or domain', true); return; }
  /* Try to extract domain + agent_id from URL pattern:
     https://{domain}/api/management/devices/agents/setup/{agent_id} */
  const m = url.match(/https?:\/\/([^/]+)\/api\/management\/devices\/agents\/setup\/(\w+)/);
  let body;
  if (m) {
    body = JSON.stringify({ domain: m[1], agent_id: m[2] });
  } else if (!url.startsWith('http')) {
    /* Assume it's just a domain, get agent_id from current config */
    const cfg = await api('/api/config');
    const aid = cfg && cfg.agent && cfg.agent.id;
    if (!aid) { toast('Cannot determine agent ID', true); return; }
    body = JSON.stringify({ domain: url, agent_id: aid });
  } else {
    body = JSON.stringify({ url });
  }
  const r = await api('/api/setup', { method:'POST', body });
  if (r && r.ok) { toast('Setup applied'); hideSetupModal(); loadConfig(); }
}

/* ── Speed Test ───────────────────────────────────────────────────── */

async function runSpeedTest() {
  const btn = document.getElementById('speedtest-btn');
  const running = document.getElementById('speedtest-running');
  const results = document.getElementById('speedtest-results');
  btn.disabled = true;
  btn.textContent = 'Testing...';
  running.classList.remove('hidden');
  results.classList.add('hidden');

  const data = await api('/api/speedtest');

  btn.disabled = false;
  btn.textContent = 'Run Speed Test';
  running.classList.add('hidden');

  if (!data) return;

  results.classList.remove('hidden');

  document.getElementById('st-download').textContent = data.download_mbps != null ? data.download_mbps.toFixed(1) : '-';
  document.getElementById('st-upload').textContent = data.upload_mbps != null ? data.upload_mbps.toFixed(1) : '-';
  document.getElementById('st-ping').textContent = data.ping_avg_ms != null && data.ping_avg_ms >= 0 ? data.ping_avg_ms.toFixed(0) : '-';
  document.getElementById('st-latency').textContent = data.latency_ms != null && data.latency_ms >= 0 ? data.latency_ms.toFixed(0) : '-';

  /* Star rating */
  const stars = data.stars || 0;
  const starsEl = document.getElementById('speedtest-stars');
  let starsHtml = '';
  for (let i = 0; i < 5; i++) {
    starsHtml += i < stars
      ? '<span class="text-amber-400">&#9733;</span>'
      : '<span class="text-gray-300">&#9733;</span>';
  }
  starsEl.innerHTML = starsHtml;

  const detail = document.getElementById('speedtest-detail');
  detail.textContent = `Required: ${data.required_mbps?.toFixed(0) || '?'} Mbps (${data.camera_count || 0} cameras x 2 Mbps). Rating: ${stars}/5 stars.`;
}

/* ── Password Change ──────────────────────────────────────────────── */

function showPasswordModal() { document.getElementById('password-modal').classList.remove('hidden'); }
function hidePasswordModal() {
  document.getElementById('password-modal').classList.add('hidden');
  document.getElementById('pw-current').value = '';
  document.getElementById('pw-new').value = '';
  document.getElementById('pw-confirm').value = '';
}

async function changePassword() {
  const cur = document.getElementById('pw-current').value;
  const newP = document.getElementById('pw-new').value;
  const confirm = document.getElementById('pw-confirm').value;

  if (!cur || !newP) { toast('Please fill all fields', true); return; }
  if (newP !== confirm) { toast('New passwords do not match', true); return; }
  if (newP.length < 3) { toast('Password too short (min 3 chars)', true); return; }

  const r = await api('/api/system/password', {
    method: 'POST',
    body: JSON.stringify({ current: cur, new: newP })
  });
  if (r && r.ok) {
    toast('Password changed. Re-login required.');
    hidePasswordModal();
    /* Update auth token with new password */
    const user = atob(authToken).split(':')[0];
    authToken = btoa(user + ':' + newP);
    localStorage.setItem('sh_auth', authToken);
  }
}

/* ── Form helpers ─────────────────────────────────────────────────── */

function setInput(f,n,v) { const e=f.querySelector(`[name="${n}"]`); if(e) e.value=v!=null?v:''; }
function getInput(f,n) { const e=f.querySelector(`[name="${n}"]`); return e?e.value:''; }
function setCheck(f,n,v) { const e=f.querySelector(`[name="${n}"]`); if(e) e.checked=!!v; }
function getCheck(f,n) { const e=f.querySelector(`[name="${n}"]`); return e?e.checked:false; }
function esc(s) { if(s==null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

/* ── Init ─────────────────────────────────────────────────────────── */

initCanvas();
if (checkAuth()) {
  loadDashboard();
  previewInterval = setInterval(refreshSnapshots, 5000);
}
startAutoRefresh();
