/**
 * Deterministic in-memory fake of the slice of `livekit-client` the adaptor
 * consumes. No WebRTC, no WebSocket, no browser — every method records its
 * calls and every RoomEvent is fired by the test on demand via `room.fire(...)`.
 *
 * The exported enum-like constants use livekit's real string values so the
 * shapes asserted here are the shapes a real server would produce.
 *
 * Wired into the module graph per spec with:
 *   mock.module("livekit-client", { namedExports })
 */

// --- enum-like constants (real livekit string values) ----------------------

export const RoomEvent = {
  Connected: "connected",
  Reconnecting: "reconnecting",
  Reconnected: "reconnected",
  Disconnected: "disconnected",
  LocalTrackPublished: "localTrackPublished",
  LocalTrackUnpublished: "localTrackUnpublished",
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  ParticipantConnected: "participantConnected",
  ParticipantDisconnected: "participantDisconnected",
  TrackPublished: "trackPublished",
  DataReceived: "dataReceived",
  MediaDevicesChanged: "mediaDevicesChanged",
  ConnectionStateChanged: "connectionStateChanged",
  RoomMetadataChanged: "roomMetadataChanged",
  ParticipantMetadataChanged: "participantMetadataChanged",
  ConnectionQualityChanged: "connectionQualityChanged",
  ActiveSpeakersChanged: "activeSpeakersChanged",
  AudioPlaybackStatusChanged: "audioPlaybackChanged",
  MediaDevicesError: "mediaDevicesError",
} as const;

export const Track = {
  Kind: { Audio: "audio", Video: "video", Unknown: "unknown" },
  Source: {
    Camera: "camera",
    Microphone: "microphone",
    ScreenShare: "screen_share",
    ScreenShareAudio: "screen_share_audio",
    Unknown: "unknown",
  },
} as const;

export const ConnectionState = {
  Disconnected: "disconnected",
  Connecting: "connecting",
  Connected: "connected",
  Reconnecting: "reconnecting",
} as const;

export const ConnectionQuality = {
  Excellent: "excellent",
  Good: "good",
  Poor: "poor",
  Lost: "lost",
  Unknown: "unknown",
} as const;

// --- tiny event emitter (mirrors room.on / participant.on) ------------------

class Emitter {
  private _handlers = new Map<string, Function[]>();
  on(event: string, handler: Function): this {
    const arr = this._handlers.get(event) ?? [];
    arr.push(handler);
    this._handlers.set(event, arr);
    return this;
  }
  off(event: string, handler: Function): this {
    const arr = this._handlers.get(event);
    if (arr) this._handlers.set(event, arr.filter((h) => h !== handler));
    return this;
  }
  /** Test-only: synchronously invoke every handler registered for `event`. */
  fire(event: string, ...args: any[]): void {
    for (const h of (this._handlers.get(event) ?? []).slice()) h(...args);
  }
  listenerCount(event: string): number {
    return (this._handlers.get(event) ?? []).length;
  }
}

// --- media primitives -------------------------------------------------------

let mstSeq = 0;
export class FakeMediaStreamTrack {
  kind: string;
  id: string;
  enabled = true;
  appliedConstraints: MediaTrackConstraints | null = null;
  stopped = false;
  constructor(kind: string) {
    this.kind = kind;
    this.id = `mst-${kind}-${mstSeq++}`;
  }
  async applyConstraints(c: MediaTrackConstraints): Promise<void> {
    this.appliedConstraints = c;
  }
  stop(): void {
    this.stopped = true;
  }
}

/** A local track — exposes the `.sender` + `.getRTCStatsReport()` the adaptor pokes. */
export class FakeLocalTrack {
  kind: string;
  mediaStreamTrack: FakeMediaStreamTrack;
  attached: any[] = [];
  detached: any[] = [];
  sender: any;
  /** Overridable stats report used by sampleStats(); default empty. */
  statsReport: Map<string, any> = new Map();
  constructor(kind: string) {
    this.kind = kind;
    this.mediaStreamTrack = new FakeMediaStreamTrack(kind);
    const self = this;
    this.sender = {
      track: this.mediaStreamTrack,
      _params: { encodings: [{}] },
      replaced: null as any,
      replaceTrack(t: any) {
        this.replaced = t;
        return Promise.resolve();
      },
      getParameters() {
        return this._params;
      },
      setParameters(p: any) {
        this._params = p;
        return Promise.resolve();
      },
      get _owner() {
        return self;
      },
    };
  }
  attach(el: any): any {
    this.attached.push(el);
    return el;
  }
  detach(el?: any): any[] {
    this.detached.push(el);
    return [];
  }
  async getRTCStatsReport(): Promise<Map<string, any>> {
    return this.statsReport;
  }
}

export interface FakeLocalPublication {
  kind: string;
  source: string;
  track: FakeLocalTrack;
}

export class FakeLocalParticipant extends Emitter {
  identity: string;
  name?: string;
  metadata?: string;
  audioLevel = 0;
  trackPublications = new Map<string, FakeLocalPublication>();
  /** Set to make setScreenShareEnabled(true) reject (error-path coverage). */
  failScreenShare = false;
  /** Set to make setCameraEnabled(true) reject (getUserMedia error-path). */
  failCamera: Error | null = null;
  calls = {
    setCameraEnabled: [] as Array<{ enabled: boolean; opts?: any }>,
    setMicrophoneEnabled: [] as boolean[],
    setScreenShareEnabled: [] as boolean[],
    publishData: [] as Array<{ payload: Uint8Array; opts?: any }>,
  };
  constructor(identity = "local") {
    super();
    this.identity = identity;
  }

  private _setPub(source: string, kind: string, enabled: boolean) {
    if (enabled) {
      this.trackPublications.set(source, {
        kind,
        source,
        track: new FakeLocalTrack(kind),
      });
    } else {
      this.trackPublications.delete(source);
    }
  }

  async setCameraEnabled(enabled: boolean, opts?: any): Promise<void> {
    this.calls.setCameraEnabled.push({ enabled, opts });
    if (enabled && this.failCamera) throw this.failCamera;
    this._setPub(Track.Source.Camera, Track.Kind.Video, enabled);
  }
  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    this.calls.setMicrophoneEnabled.push(enabled);
    this._setPub(Track.Source.Microphone, Track.Kind.Audio, enabled);
  }
  async setScreenShareEnabled(enabled: boolean): Promise<void> {
    if (enabled && this.failScreenShare) {
      throw new Error("screen share denied");
    }
    this.calls.setScreenShareEnabled.push(enabled);
    this._setPub(Track.Source.ScreenShare, Track.Kind.Video, enabled);
  }
  getTrackPublication(source: string): FakeLocalPublication | undefined {
    return this.trackPublications.get(source);
  }
  async publishData(payload: Uint8Array, opts?: any): Promise<void> {
    this.calls.publishData.push({ payload, opts });
  }
}

// --- remote side ------------------------------------------------------------

export interface FakeRemoteTrack {
  kind: string;
  mediaStreamTrack: FakeMediaStreamTrack;
}
export interface FakeRemotePublication {
  kind: string;
  track?: FakeRemoteTrack;
  enabledState?: boolean;
  setEnabled(v: boolean): void;
}

export class FakeRemoteParticipant extends Emitter {
  identity: string;
  name?: string;
  metadata?: string;
  trackPublications = new Map<string, FakeRemotePublication>();
  constructor(identity: string, name?: string, metadata?: string) {
    super();
    this.identity = identity;
    this.name = name;
    this.metadata = metadata;
  }
  addPublication(kind: string, subscribed = true): FakeRemotePublication {
    const track: FakeRemoteTrack | undefined = subscribed
      ? { kind, mediaStreamTrack: new FakeMediaStreamTrack(kind) }
      : undefined;
    const pub: FakeRemotePublication = {
      kind,
      track,
      enabledState: undefined,
      setEnabled(v: boolean) {
        this.enabledState = v;
      },
    };
    this.trackPublications.set(`${kind}-${this.trackPublications.size}`, pub);
    return pub;
  }
}

// --- the Room ---------------------------------------------------------------

export class FakeRoom extends Emitter {
  static _localDevices: MediaDeviceInfo[] = [
    { deviceId: "cam-1", kind: "videoinput", label: "Fake Cam", groupId: "g1", toJSON() {} } as any,
    { deviceId: "mic-1", kind: "audioinput", label: "Fake Mic", groupId: "g2", toJSON() {} } as any,
  ];
  static getLocalDevices(): Promise<MediaDeviceInfo[]> {
    return Promise.resolve(FakeRoom._localDevices);
  }

  ctorOptions: any;
  state: string = ConnectionState.Disconnected;
  localParticipant = new FakeLocalParticipant();
  remoteParticipants = new Map<string, FakeRemoteParticipant>();
  /** Autoplay-policy state polled by the adaptor (Room.canPlaybackAudio). */
  canPlaybackAudio = true;
  /** Set to make connect() reject (transport-failure / TURN-hint coverage). */
  failConnect: Error | null = null;
  calls = {
    connect: [] as Array<{ wsUrl: string; token: string; opts?: any }>,
    disconnect: 0,
    switchActiveDevice: [] as Array<{ kind: string; deviceId: string }>,
    startAudio: 0,
  };
  constructor(options?: any) {
    super();
    this.ctorOptions = options;
  }
  get numParticipants(): number {
    return this.remoteParticipants.size;
  }
  async connect(wsUrl: string, token: string, opts?: any): Promise<void> {
    this.calls.connect.push({ wsUrl, token, opts });
    if (this.failConnect) throw this.failConnect;
    this.state = ConnectionState.Connected;
  }
  /** Room.startAudio(): resumes blocked audio; models the unlock succeeding. */
  async startAudio(): Promise<void> {
    this.calls.startAudio++;
    this.canPlaybackAudio = true;
  }
  async disconnect(): Promise<void> {
    this.calls.disconnect++;
    this.state = ConnectionState.Disconnected;
  }
  async switchActiveDevice(kind: string, deviceId: string): Promise<void> {
    this.calls.switchActiveDevice.push({ kind, deviceId });
  }
}

// --- module surface handed to mock.module -----------------------------------

export const namedExports = {
  Room: FakeRoom,
  RoomEvent,
  Track,
  ConnectionState,
  ConnectionQuality,
};
