/**
 * Headless smoke test for the Meet-style `conference.html` sample.
 *
 * It renders the conference template exactly the way the core SamplesService
 * does (resolving the {{APP}}/{{ROOM}}/… placeholders), serves it from a throwaway
 * local HTTP server, and drives it with headless Chrome (puppeteer-core + the
 * system Chrome). It asserts that the PRE-JOIN screen renders and wires up —
 * which needs NO LiveKit server (the page only dials LiveKit once you click
 * "Join now"). The LiveKit CDN <script> is stubbed via request interception so
 * the test is fully offline and deterministic.
 *
 * Run:  cd scripts && npm install && npm run smoke:conference
 * Env:  PUPPETEER_EXECUTABLE_PATH  override the Chrome binary
 *       SMOKE_SCREENSHOT           override the screenshot output path
 *
 * Exit code 0 = all assertions passed; non-zero = failure (details on stderr).
 * The full end-to-end call flow (media, grid, screen share, chat over the data
 * channel) is validated live after deploy — this only guards the entry screen.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { TEMPLATES } from '../streamhub-core/src/modules/samples/sample-templates.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- 1. render the template like SamplesService.render() -------------------
const CTX = {
  APP: 'demo',
  ROOM: 'standup',
  WS_URL: 'wss://media.example.invalid/ws',
  API_URL: 'https://demo.example.invalid/api/v1',
  ADAPTOR_URL: 'https://demo.example.invalid/sdk/streamhub-adaptor.global.js',
  HLS_URL: 'https://demo.example.invalid/hls/demo',
};
const render = (tpl) =>
  tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(CTX, k) ? CTX[k] : m,
  );
const html = render(TEMPLATES['conference.html']);

// A tiny stub that stands in for the LiveKit UMD bundle so the page's top-level
// <script src> resolves without any network. Pre-join never touches it.
const LK_STUB = 'window.LivekitClient={Room:function(){},RoomEvent:{},' +
  'Track:{Source:{Camera:"camera",Microphone:"microphone",ScreenShare:"screen_share"}}};';

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exitCode = 1;
}

function findChrome() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    envPath,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

async function main() {
  // ---- 2. serve the rendered page --------------------------------------
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/conference.html`;

  const execPath = findChrome();
  if (!execPath) {
    console.error(
      'No Chrome binary found. Set PUPPETEER_EXECUTABLE_PATH to your Chrome/Chromium.',
    );
    server.close();
    process.exit(2);
  }

  const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: true,
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--window-size=1280,800',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Stub the LiveKit CDN; allow our own origin; block any other external host.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('livekit-client')) {
        req.respond({ status: 200, contentType: 'application/javascript', body: LK_STUB });
      } else if (u.startsWith(`http://127.0.0.1:${port}`) || u.startsWith('data:')) {
        req.continue();
      } else {
        req.abort();
      }
    });

    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Let the pre-join preview / device enumeration settle.
    await page.waitForSelector('#prejoin', { visible: true, timeout: 10000 });
    await new Promise((r) => setTimeout(r, 1200));

    // ---- 3. assertions -------------------------------------------------
    const checks = await page.evaluate(() => {
      const vis = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const call = document.getElementById('call');
      return {
        brand: (document.querySelector('.topbar .brand') || {}).textContent || '',
        heading: (document.querySelector('.pjcard h1') || {}).textContent || '',
        prejoinVisible: vis('#prejoin'),
        nameInput: !!document.getElementById('fName'),
        roomInput: !!document.getElementById('fRoom'),
        joinBtn: (document.getElementById('join') || {}).textContent || '',
        camSelect: !!document.getElementById('camSelect'),
        micSelect: !!document.getElementById('micSelect'),
        camOptions: (document.getElementById('camSelect') || { options: [] }).options.length,
        micOptions: (document.getElementById('micSelect') || { options: [] }).options.length,
        netStatus: (document.getElementById('netlbl') || {}).textContent || '',
        preview: !!document.getElementById('preview'),
        // in-call surface exists but is hidden before joining
        callHidden: !call || getComputedStyle(call).display === 'none',
        // control-bar buttons present in the DOM (hidden until join)
        controls: ['mic', 'cam', 'screen', 'chatToggle', 'leave'].every(
          (id) => !!document.getElementById(id),
        ),
        roomFromUrl: (document.getElementById('roomName') || {}).textContent || '',
      };
    });

    const assert = (cond, label) => {
      if (cond) console.log('OK   ' + label);
      else fail(label);
    };

    assert(checks.brand.trim() === 'StreamHub', 'brand wordmark = StreamHub');
    assert(/ready to join/i.test(checks.heading), 'pre-join heading rendered');
    assert(checks.prejoinVisible, 'pre-join screen is visible');
    assert(checks.nameInput, 'display-name input present');
    assert(checks.roomInput, 'room input present');
    assert(/join/i.test(checks.joinBtn), 'join button present');
    assert(checks.camSelect, 'camera device picker present');
    assert(checks.micSelect, 'microphone device picker present');
    assert(checks.preview, 'camera preview element present');
    // The preview reached a terminal state (getUserMedia resolved or was denied),
    // proving the pre-join media path ran without throwing.
    assert(checks.netStatus.trim().length > 0, `pre-join media path ran (status: "${checks.netStatus.trim()}")`);
    // Device dropdowns populate when the host exposes cameras/mics; headless CI
    // may expose a fake stream without enumerable devices, so this is INFO-only.
    console.log(`INFO device options detected: cam=${checks.camOptions} mic=${checks.micOptions} (0 is expected on hosts with no enumerable devices)`);
    assert(checks.callHidden, 'in-call surface hidden before joining');
    assert(checks.controls, 'control bar (mic/cam/screen/chat/leave) in DOM');
    assert(checks.roomFromUrl.trim() === 'standup', 'room name resolved from default/URL');
    assert(pageErrors.length === 0, 'no uncaught page errors' + (pageErrors.length ? ': ' + pageErrors.join(' | ') : ''));

    // ---- 4. screenshot -------------------------------------------------
    const shot = process.env.SMOKE_SCREENSHOT || join(HERE, 'conference-prejoin.png');
    await page.screenshot({ path: shot });
    console.log('screenshot: ' + shot);

    console.log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
