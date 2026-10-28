/**
 * cameras plugin — PURE helpers (no React, no DOM), unit-tested under both
 * node:test and vitest: response parsing, grid filters/counts, formatters, the
 * PTZ press-and-hold controller (deadman repeat) and the RTMP url/key split of
 * the alta flow. index.tsx is the React shell.
 */

export interface CameraSummary {
  rssi: number | null
  ssid: string | null
  ip: string | null
  streamRunning: boolean | null
  streamSource: number | null
  bitrateKbps: number | null
  recordRunning: boolean | null
  sdPresent: boolean | null
  sdFreeKb: number | null
  sdTotalKb: number | null
  queueFiles: number | null
  queueBytes: number | null
  ptzX: number | null
  ptzY: number | null
  ptzMoving: boolean | null
  ptzPreset: number | null
  memFreeKb: number | null
  load1: number | null
  safeMode: boolean | null
  uptimeS: number | null
  lastRebootReason: string | null
  configRev: number | null
}

export interface CameraView {
  device: string
  name: string | null
  site: string | null
  stand: string | null
  model: string | null
  room: string | null
  tags: string[]
  provisioned: boolean
  linked: boolean
  online: boolean
  status: 'online' | 'offline' | 'unknown'
  lastSeen: string | null
  ageMs: number | null
  fw: string | null
  caps: string[]
  capsKnown: boolean
  eventsLost: number
  thumbAt: string | null
  hdUntil: string | null
  streamUrl: string | null
  hasStreamKey: boolean
  hlsPath: string | null
  summary: CameraSummary
}

export interface CamerasList {
  active: boolean
  baseTopic: string
  cameras: CameraView[]
  generatedAt: string
}

export type CommandStatus =
  | 'sent'
  | 'pending'
  | 'accepted'
  | 'progress'
  | 'done'
  | 'failed'
  | 'timeout'

export interface CommandRow {
  id: string
  device: string
  cmd: string
  status: CommandStatus
  pct: number | null
  code: string | null
  error: string | null
  createdAt: string
  long: boolean
}

export interface EventRow {
  id: number
  ts: string
  seq: number | null
  level: string
  src: string | null
  event: string | null
  msg: string | null
}

export interface HistoryPoint {
  ts: string
  rssi: number | null
  memFreeKb: number | null
  load1: number | null
  queueBytes: number | null
  sdFreeKb: number | null
  bitrateKbps: number | null
}

export interface CameraDetail {
  camera: CameraView
  history: HistoryPoint[]
  commands: CommandRow[]
  events: EventRow[]
}

export type CameraFilter = 'all' | 'online' | 'offline'

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

function parseSummary(raw: unknown): CameraSummary {
  const s = obj(raw)
  return {
    rssi: num(s.rssi),
    ssid: str(s.ssid),
    ip: str(s.ip),
    streamRunning: bool(s.streamRunning),
    streamSource: num(s.streamSource),
    bitrateKbps: num(s.bitrateKbps),
    recordRunning: bool(s.recordRunning),
    sdPresent: bool(s.sdPresent),
    sdFreeKb: num(s.sdFreeKb),
    sdTotalKb: num(s.sdTotalKb),
    queueFiles: num(s.queueFiles),
    queueBytes: num(s.queueBytes),
    ptzX: num(s.ptzX),
    ptzY: num(s.ptzY),
    ptzMoving: bool(s.ptzMoving),
    ptzPreset: num(s.ptzPreset),
    memFreeKb: num(s.memFreeKb),
    load1: num(s.load1),
    safeMode: bool(s.safeMode),
    uptimeS: num(s.uptimeS),
    lastRebootReason: str(s.lastRebootReason),
    configRev: num(s.configRev),
  }
}

/** Coerce one camera (null when it carries no device id). */
export function parseCamera(raw: unknown): CameraView | null {
  const r = obj(raw)
  const device = str(r.device)
  if (!device) return null
  const status = r.status === 'online' || r.status === 'offline' ? r.status : 'unknown'
  return {
    device,
    name: str(r.name),
    site: str(r.site),
    stand: str(r.stand),
    model: str(r.model),
    room: str(r.room),
    tags: strs(r.tags),
    provisioned: r.provisioned === true,
    linked: r.linked === true,
    online: r.online === true,
    status,
    lastSeen: str(r.lastSeen),
    ageMs: num(r.ageMs),
    fw: str(r.fw),
    caps: strs(r.caps),
    capsKnown: r.capsKnown === true,
    eventsLost: num(r.eventsLost) ?? 0,
    thumbAt: str(r.thumbAt),
    hdUntil: str(r.hdUntil),
    streamUrl: str(r.streamUrl),
    hasStreamKey: r.hasStreamKey === true,
    hlsPath: str(r.hlsPath),
    summary: parseSummary(r.summary),
  }
}

/** Coerce GET .../cameras into a safe list. */
export function parseCameras(body: unknown): CamerasList {
  const b = obj(body)
  const cameras = Array.isArray(b.cameras)
    ? b.cameras.map(parseCamera).filter((c): c is CameraView => c !== null)
    : []
  return {
    active: b.active === true,
    baseTopic: str(b.baseTopic) ?? 'opencam',
    cameras,
    generatedAt: str(b.generatedAt) ?? '',
  }
}

const STATUSES: CommandStatus[] = ['sent', 'pending', 'accepted', 'progress', 'done', 'failed', 'timeout']

export function parseCommand(raw: unknown): CommandRow | null {
  const r = obj(raw)
  const id = str(r.id)
  if (!id) return null
  const status = STATUSES.includes(r.status as CommandStatus) ? (r.status as CommandStatus) : 'pending'
  return {
    id,
    device: str(r.device) ?? '',
    cmd: str(r.cmd) ?? '',
    status,
    pct: num(r.pct),
    code: str(r.code),
    error: str(r.error),
    createdAt: str(r.createdAt) ?? '',
    long: r.long === true,
  }
}

export function parseEvent(raw: unknown): EventRow | null {
  const r = obj(raw)
  const id = num(r.id)
  if (id === null) return null
  return {
    id,
    ts: str(r.ts) ?? '',
    seq: num(r.seq),
    level: str(r.level) ?? 'info',
    src: str(r.src),
    event: str(r.event),
    msg: str(r.msg),
  }
}

/** Coerce GET .../cameras/:device (null when the camera is missing). */
export function parseDetail(body: unknown): CameraDetail | null {
  const b = obj(body)
  const camera = parseCamera(b.camera)
  if (!camera) return null
  const hist = Array.isArray(b.history) ? b.history : []
  return {
    camera,
    history: hist.map((h) => {
      const p = obj(h)
      return {
        ts: str(p.ts) ?? '',
        rssi: num(p.rssi),
        memFreeKb: num(p.memFreeKb),
        load1: num(p.load1),
        queueBytes: num(p.queueBytes),
        sdFreeKb: num(p.sdFreeKb),
        bitrateKbps: num(p.bitrateKbps),
      }
    }),
    commands: (Array.isArray(b.commands) ? b.commands : [])
      .map(parseCommand)
      .filter((c): c is CommandRow => c !== null),
    events: parseEvents(b.events),
  }
}

export function parseEvents(raw: unknown): EventRow[] {
  const list = Array.isArray(raw) ? raw : Array.isArray(obj(raw).events) ? (obj(raw).events as unknown[]) : []
  return list.map(parseEvent).filter((e): e is EventRow => e !== null)
}

// ---------------------------------------------------------------------------
// Grid filters
// ---------------------------------------------------------------------------

export function filterCameras(list: CameraView[], filter: CameraFilter, site = ''): CameraView[] {
  return list.filter(
    (c) =>
      (filter === 'all' || (filter === 'online' ? c.online : !c.online)) &&
      (site === '' || c.site === site),
  )
}

export function cameraCounts(list: CameraView[]): Record<CameraFilter, number> {
  const online = list.filter((c) => c.online).length
  return { all: list.length, online, offline: list.length - online }
}

/** Distinct, sorted, non-empty sites (the site select). */
export function sitesOf(list: CameraView[]): string[] {
  return [...new Set(list.map((c) => c.site).filter((s): s is string => !!s))].sort()
}

/** Whether the console offers a capability: caps unknown (api-0) → assume yes. */
export function hasCap(c: Pick<CameraView, 'caps' | 'capsKnown'>, cap: string): boolean {
  return !c.capsKnown || c.caps.includes(cap)
}

/** A command still waiting on the camera. */
export function isOpen(s: CommandStatus): boolean {
  return s === 'pending' || s === 'accepted' || s === 'progress'
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** 0..4 signal bars from an RSSI in dBm (null → 0). */
export function rssiBars(rssi: number | null): number {
  if (rssi == null || !Number.isFinite(rssi)) return 0
  if (rssi >= -55) return 4
  if (rssi >= -65) return 3
  if (rssi >= -75) return 2
  if (rssi >= -85) return 1
  return 0
}

/** "-61 dBm" or "—". */
export function formatRssi(rssi: number | null): string {
  return rssi == null || !Number.isFinite(rssi) ? '—' : `${Math.round(rssi)} dBm`
}

/** Used share of the SD card as "35%" (or "—"). */
export function formatSdUsed(freeKb: number | null, totalKb: number | null): string {
  if (freeKb == null || totalKb == null || totalKb <= 0) return '—'
  const used = Math.min(100, Math.max(0, ((totalKb - freeKb) / totalKb) * 100))
  return `${Math.round(used)}%`
}

/** Human bytes: "0 B", "12.3 KB", "4.5 MB", "1.2 GB". */
export function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** Human uptime like "2d 4h", "3h 12m", "45m", "12s". */
export function formatUptime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/** Short age "3s", "5m", "2h", "1d" (or "—"). */
export function formatAge(ageMs: number | null): string {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return '—'
  const s = Math.floor(ageMs / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// ---------------------------------------------------------------------------
// PTZ press-and-hold (deadman)
// ---------------------------------------------------------------------------

export type PtzDir = 'up' | 'down' | 'left' | 'right' | 'ul' | 'ur' | 'dl' | 'dr'

export const PTZ_REPEAT_MS = 300
export const PTZ_HOLD_MS = 500

export interface PtzTimers {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (h: unknown) => void
}

/**
 * Press-and-hold controller for the PTZ pad. start(dir) sends a move at once
 * and repeats it every PTZ_REPEAT_MS while held (each carries hold_ms, so the
 * camera stops by itself if the repeats stop arriving); stop() clears the
 * repeat and sends exactly ONE stop. start() with the same dir while held is a
 * no-op; a different dir switches direction without an intermediate stop.
 */
export class PtzHold {
  private timer: unknown = null
  private dir: PtzDir | null = null
  private readonly move: (dir: PtzDir) => void
  private readonly halt: () => void
  private readonly timers: PtzTimers
  private readonly repeatMs: number

  constructor(
    move: (dir: PtzDir) => void,
    halt: () => void,
    timers: PtzTimers = {
      setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
      clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
    },
    repeatMs = PTZ_REPEAT_MS,
  ) {
    this.move = move
    this.halt = halt
    this.timers = timers
    this.repeatMs = repeatMs
  }

  get active(): PtzDir | null {
    return this.dir
  }

  start(dir: PtzDir): void {
    if (this.dir === dir) return
    if (this.timer !== null) this.timers.clearInterval(this.timer)
    this.dir = dir
    this.move(dir)
    this.timer = this.timers.setInterval(() => {
      if (this.dir) this.move(this.dir)
    }, this.repeatMs)
  }

  stop(): void {
    if (this.dir === null) return
    if (this.timer !== null) this.timers.clearInterval(this.timer)
    this.timer = null
    this.dir = null
    this.halt()
  }

  /** Tear down without sending a stop (unmount after stop()). */
  dispose(): void {
    if (this.timer !== null) this.timers.clearInterval(this.timer)
    this.timer = null
  }
}

// ---------------------------------------------------------------------------
// Alta: passthrough ingress → camera stream url/key
// ---------------------------------------------------------------------------

/**
 * Split a passthrough `rtmpUrl` ("rtmp://h:1935/live/<key>") into what OpenCam
 * wants: `url` (without the key) + `key`. When the URL does not end in the key
 * it is returned whole.
 */
export function splitRtmpUrl(rtmpUrl: string, streamKey: string): { url: string; key: string } {
  const u = rtmpUrl.trim()
  const k = streamKey.trim()
  if (k && u.endsWith('/' + k)) return { url: u.slice(0, -(k.length + 1)), key: k }
  return { url: u, key: k }
}

const DEVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Same rule as the backend (one safe MQTT topic level). */
export function validDevice(id: string): boolean {
  return DEVICE_RE.test(id)
}
