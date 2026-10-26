import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  ConnectionQuality,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type LocalTrackPublication,
  type Participant,
  type RoomConnectOptions,
  type RoomOptions,
} from "livekit-client";

import type {
  StreamHubAdaptorConfig,
  AntMediaCallback,
  AntMediaErrorCallback,
} from "./types.js";
import { resolveToken } from "./tokenClient.js";
import {
  applyInlinePlaybackAttributes,
  classifyGetUserMediaError,
  installAutoplayUnlock,
  supportsScreenShare,
  withTurnHint,
} from "./browserCompat.js";

const textEncoder =
  typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
const textDecoder =
  typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

/**
 * StreamHubAdaptor — an AntMedia `WebRTCAdaptor` look-alike backed by
 * `livekit-client` + the StreamHub media server.
 *
 * It emits the same *string-based* callbacks AntMedia apps already listen for
 * (`initialized`, `publish_started`, `play_started`, `newStreamAvailable`,
 * `roomInformation`, `data_received`, `available_devices`, ...) by mapping
 * `RoomEvent.*` from LiveKit. The intent is a drop-in migration: apps swap the
 * import/CDN and keep their existing callback `switch`/`if` logic.
 */
export class StreamHubAdaptor {
  /** AntMedia static plugin hook list. No-op in StreamHub; kept for source compat. */
  static pluginInitMethods: any[] = [];

  // ---- AntMedia-compatible public surface (some apps poke these directly) ----
  public config: StreamHubAdaptorConfig;
  public mediaConstraints: StreamHubAdaptorConfig["mediaConstraints"];
  public localVideoElement: HTMLVideoElement | null = null;
  public remoteVideoElement: HTMLVideoElement | null = null;
  public isPlayMode = false;
  /**
   * Map keyed by streamId, AntMedia exposes per-peer RTCPeerConnection-like
   * objects here. We provide a shim exposing `getSenders()` so code that does
   * `remotePeerConnection[id].getSenders().find(...).replaceTrack(...)`
   * (track/resolution/bitrate switching) keeps working. See `peerShim`.
   */
  public remotePeerConnection: Record<string, any> = {};
  /** AntMedia `mediaManager` compat: `.bandwidth` and `.getDevices()`. */
  public mediaManager: {
    bandwidth: number;
    getDevices: () => Promise<MediaDeviceInfo[]>;
  };

  // ---- internals ----
  private room: Room;
  private callback: AntMediaCallback;
  private callbackError: AntMediaErrorCallback;
  private debug: boolean;

  private roomName: string | null = null;
  private localStreamId: string | null = null;
  private connecting: Promise<void> | null = null;
  private connected = false;
  private publishStarted = false;
  private dataChannelOpened = false;
  private dataChannelEnabled: boolean;

  private statsTimer: any = null;
  private lastStatsSample: {
    ts: number;
    bytesSent: number;
  } | null = null;
  /** Disposer for the one-shot gesture listener that unlocks blocked audio. */
  private autoplayUnlockDispose: (() => void) | null = null;

  constructor(config: StreamHubAdaptorConfig) {
    this.config = config;
    this.mediaConstraints = config.mediaConstraints || { video: true, audio: true };
    this.isPlayMode = config.isPlayMode ?? config.playOnly ?? false;
    this.dataChannelEnabled = config.dataChannelEnabled ?? true;
    this.debug = config.debug ?? false;

    this.callback = config.callback || (() => {});
    this.callbackError =
      config.callbackError || config.callback_error || (() => {});

    this.localVideoElement =
      config.localVideoElement ||
      (config.localVideoId
        ? (document.getElementById(config.localVideoId) as HTMLVideoElement)
        : null);
    this.remoteVideoElement =
      config.remoteVideoElement ||
      (config.remoteVideoId
        ? (document.getElementById(config.remoteVideoId) as HTMLVideoElement)
        : null);

    // iOS/WebKit hardening (WEBRTC-BROWSER-COMPAT): make sure the app's video
    // elements play INLINE (no fullscreen hijack) and the local preview is
    // muted (echo + muted-autoplay policy). Attribute-level, additive, safe
    // even when the app already set them.
    applyInlinePlaybackAttributes(this.localVideoElement, { muted: true });
    applyInlinePlaybackAttributes(this.remoteVideoElement);

    // Adaptive stream + dynacast (LIVEKIT-UNUSED-FEATURES): config-driven,
    // default ON — adaptiveStream drops layers the element can't display,
    // dynacast pauses layers nobody subscribes to. Pass `false` to disable.
    const roomOptions: RoomOptions = {
      adaptiveStream: config.adaptiveStream ?? true,
      dynacast: config.dynacast ?? true,
      publishDefaults: {
        simulcast: true,
        // H.264 by default (WEBRTC-BROWSER-COMPAT): AntMedia parity, hardware
        // codec on Safari/iOS, and what HLS/MP4 egress wants. livekit-client's
        // own default is vp8 — override unless the app picks another codec.
        videoCodec: config.videoCodec ?? "h264",
        videoEncoding: config.bandwidth
          ? { maxBitrate: config.bandwidth * 1000 }
          : undefined,
      },
    };
    this.room = new Room(roomOptions);

    this.mediaManager = {
      bandwidth: config.bandwidth ?? 900,
      getDevices: () => this.emitAvailableDevices(),
    };

    this.wireRoomEvents();

    // AntMedia signals "initialized" once the signalling socket is ready.
    // We emit it on the next tick so apps can call publish()/joinRoom().
    Promise.resolve().then(() => this.emit("initialized"));
  }

  // =========================================================================
  // AntMedia method surface
  // =========================================================================

  /**
   * Join a conference room. AntMedia: `joinRoom(roomName, streamId, mode)`.
   * Connects to the LiveKit room and emits `joinedTheRoom`.
   * `mode` (multitrack/mcu/legacy) is accepted but ignored — LiveKit is always
   * a multi-track SFU (MCU mixing is a server egress concern, see README).
   */
  async joinRoom(
    roomName: string,
    streamId?: string,
    _mode?: string,
  ): Promise<void> {
    this.roomName = roomName;
    this.localStreamId = streamId || this.localStreamId || randomId("anon");
    try {
      await this.ensureConnected(roomName, this.localStreamId, {
        canPublish: !this.isPlayMode,
        canSubscribe: true,
      });
      this.emit("joinedTheRoom", this.roomInfoPayload());
      // Surface current room state immediately, like AntMedia's first poll.
      this.emit("roomInformation", this.roomInfoPayload());
    } catch (e: any) {
      this.error("joinRoomError", e?.message || String(e));
    }
  }

  /**
   * Publish local media. AntMedia signature:
   * `publish(streamId, token, subscriberId, subscriberCode, streamName, mainTrackId, metaData)`.
   * In StreamHub, `token`/`subscriberCode` (TOTP) are ignored — auth is the LiveKit
   * grant minted by the StreamHub API. If no room was joined yet (single-publish
   * apps), `streamId` is used as the room name.
   */
  async publish(
    streamId: string,
    _token?: string,
    _subscriberId?: string,
    _subscriberCode?: string,
    _streamName?: string,
    _mainTrackId?: string,
    _metaData?: string,
  ): Promise<void> {
    this.localStreamId = streamId;
    const room = this.roomName || streamId;
    this.roomName = room;
    try {
      await this.ensureConnected(room, streamId, {
        canPublish: true,
        canSubscribe: true,
      });
      const wantVideo = this.mediaConstraints?.video !== false;
      const wantAudio = this.mediaConstraints?.audio !== false;
      if (wantVideo) {
        await this.room.localParticipant.setCameraEnabled(
          true,
          this.videoCaptureOptions(),
        );
      }
      if (wantAudio) {
        await this.room.localParticipant.setMicrophoneEnabled(true);
      }
      this.attachLocalPreview();
      // publish_started is also emitted from RoomEvent.LocalTrackPublished;
      // emit here too in case media was already enabled (idempotent guard).
      if (!this.publishStarted) {
        this.publishStarted = true;
        this.emit("publish_started", { streamId });
      }
    } catch (e: any) {
      // AntMedia parity: camera/mic acquisition failures surface the
      // DOMException NAME ("NotAllowedError", "NotFoundError", …) — apps key
      // their permission UIs on those exact strings.
      const gumError = classifyGetUserMediaError(e);
      if (gumError) {
        this.error(gumError, e?.message || String(e));
      } else {
        this.error("publishError", e?.message || String(e));
      }
    }
  }

  /**
   * Subscribe/play. AntMedia signature:
   * `play(streamId, token, roomId, enableTracks, subscriberId, subscriberCode, metaData)`.
   * LiveKit auto-subscribes, so this mostly connects (if needed) and flips the
   * play flag. Already-present remote tracks are (re)announced as
   * `newStreamAvailable`. Emits `play_started`.
   */
  async play(
    streamId: string,
    _token?: string,
    roomId?: string,
    _enableTracks?: any,
    _subscriberId?: string,
    _subscriberCode?: string,
    _metaData?: string,
  ): Promise<void> {
    const room = roomId || this.roomName || streamId;
    this.roomName = room;
    try {
      await this.ensureConnected(room, this.localStreamId || randomId("viewer"), {
        canPublish: !this.isPlayMode,
        canSubscribe: true,
      });
      // Re-announce already-subscribed tracks for this play call.
      for (const p of this.room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (pub.track) {
            this.announceTrack(pub.track as RemoteTrack, p);
          }
        }
      }
      this.emit("play_started", { streamId: streamId || room });
    } catch (e: any) {
      this.error("playError", e?.message || String(e));
    }
  }

  /** Leave a conference room. AntMedia: `leaveFromRoom(roomName)`. */
  async leaveFromRoom(_roomName?: string): Promise<void> {
    await this.disconnectInternal();
    this.emit("leavedFromRoom", { ATTR_ROOM_NAME: this.roomName });
  }

  /** Stop a publish/play and disconnect. AntMedia: `stop(streamId)`. */
  async stop(streamId?: string): Promise<void> {
    await this.disconnectInternal();
    this.emit("publish_finished", { streamId });
  }

  /** Send a message over the data channel. AntMedia: `sendData(streamId, data)`. */
  async sendData(_streamId: string, data: any): Promise<void> {
    if (!this.connected) return;
    const payload =
      data instanceof Uint8Array
        ? data
        : textEncoder!.encode(
            typeof data === "string" ? data : JSON.stringify(data),
          );
    await this.room.localParticipant.publishData(payload, { reliable: true });
  }

  /** AntMedia: `turnOffLocalCamera(streamId)`. */
  async turnOffLocalCamera(_streamId?: string): Promise<void> {
    await this.room.localParticipant.setCameraEnabled(false);
  }

  /** AntMedia: `turnOnLocalCamera(streamId)`. */
  async turnOnLocalCamera(_streamId?: string): Promise<void> {
    await this.room.localParticipant.setCameraEnabled(
      true,
      this.videoCaptureOptions(),
    );
    this.attachLocalPreview();
  }

  /** AntMedia: `muteLocalMic()`. */
  async muteLocalMic(): Promise<void> {
    await this.room.localParticipant.setMicrophoneEnabled(false);
  }

  /** AntMedia: `unmuteLocalMic()`. */
  async unmuteLocalMic(): Promise<void> {
    await this.room.localParticipant.setMicrophoneEnabled(true);
  }

  /** AntMedia: `switchVideoCameraCapture(streamId, deviceId)`. */
  async switchVideoCameraCapture(
    _streamId: string,
    deviceId?: string,
  ): Promise<void> {
    if (deviceId) {
      await this.room.switchActiveDevice("videoinput", deviceId);
    } else {
      // No deviceId -> flip facingMode by re-enabling with the other camera.
      await this.room.localParticipant.setCameraEnabled(
        true,
        this.videoCaptureOptions(true),
      );
    }
    this.attachLocalPreview();
  }

  /** AntMedia: `switchAudioInputSource(streamId, deviceId)`. */
  async switchAudioInputSource(
    _streamId: string,
    deviceId: string,
  ): Promise<void> {
    await this.room.switchActiveDevice("audioinput", deviceId);
  }

  /** AntMedia: `switchDesktopCapture(streamId)` — screen share on. */
  async switchDesktopCapture(_streamId?: string): Promise<void> {
    // iOS/iPadOS Safari has NO getDisplayMedia at all — fail fast with a
    // clear message instead of a cryptic DeviceUnsupportedError. (Browser
    // contexts only; non-DOM test environments skip the guard.)
    if (typeof window !== "undefined" && !supportsScreenShare()) {
      this.error(
        "screenShareError",
        "getDisplayMedia is not supported in this browser — iOS/iPadOS " +
          "Safari cannot capture the screen from a web page.",
      );
      return;
    }
    try {
      await this.room.localParticipant.setScreenShareEnabled(true);
      this.emit("screen_share_started");
    } catch (e: any) {
      this.error("screenShareError", e?.message || String(e));
    }
  }

  /** Stop screen share (LiveKit equivalent of AntMedia desktop-capture stop). */
  async stopDesktopCapture(_streamId?: string): Promise<void> {
    await this.room.localParticipant.setScreenShareEnabled(false);
    this.emit("screen_share_stopped");
  }

  /** Begin periodic stats. AntMedia: `enableStats(streamId)`. */
  enableStats(_streamId?: string): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => this.sampleStats(), 2000);
  }

  /** AntMedia: `disableStats(streamId)`. */
  disableStats(_streamId?: string): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  /** AntMedia: `getRoomInfo(roomName, streamId)` -> emits `roomInformation`. */
  getRoomInfo(roomName?: string, _streamId?: string): void {
    if (roomName) this.roomName = roomName;
    this.emit("roomInformation", this.roomInfoPayload());
  }

  /** AntMedia: `getDebugInfo(streamId)` -> emits `debugInfo`. */
  async getDebugInfo(_streamId?: string): Promise<void> {
    const info = {
      connectionState: this.room.state,
      participants: this.room.numParticipants,
      localTracks: this.room.localParticipant.trackPublications.size,
    };
    this.emit("debugInfo", { debugInfo: JSON.stringify(info) });
  }

  /** AntMedia: `closeWebSocket()`. */
  closeWebSocket(): void {
    void this.disconnectInternal();
  }

  /**
   * AntMedia: `applyConstraints(streamId, constraints)` — apply new video/audio
   * constraints to the live local tracks.
   */
  async applyConstraints(constraints: MediaTrackConstraints): Promise<void> {
    const pubs = this.room.localParticipant.trackPublications;
    for (const pub of pubs.values()) {
      const mst = pub.track?.mediaStreamTrack;
      if (mst && pub.kind === Track.Kind.Video) {
        try {
          await mst.applyConstraints(constraints);
        } catch (e) {
          this.log("applyConstraints failed", e);
        }
      }
    }
  }

  /**
   * AntMedia: `iceConnectionState(streamId)` — best-effort map of LiveKit
   * connection state to an ICE-state string.
   */
  iceConnectionState(_streamId?: string): string {
    switch (this.room.state) {
      case ConnectionState.Connected:
        return "connected";
      case ConnectionState.Connecting:
        return "checking";
      case ConnectionState.Reconnecting:
        return "disconnected";
      default:
        return "closed";
    }
  }

  /**
   * AntMedia: `assignVideoTrack(videoTrackId, streamId, enable)`. In AntMedia
   * this maps a server "track slot" (ARDAMSxN) to a participant. LiveKit
   * subscribes per-publication automatically; we set the publication's
   * `enabled` state if found. Best-effort.
   */
  assignVideoTrack(videoTrackId: string, streamId: string, enable: boolean): void {
    const p = this.room.remoteParticipants.get(streamId);
    if (!p) return;
    for (const pub of p.trackPublications.values()) {
      if (pub.kind === Track.Kind.Video) {
        (pub as RemoteTrackPublication).setEnabled(enable);
      }
    }
    void videoTrackId;
  }

  /** AntMedia: `setMaxVideoTrackCount(count)`. No-op (LiveKit adaptiveStream handles this). */
  setMaxVideoTrackCount(_count: number): void {
    this.log("setMaxVideoTrackCount is a no-op (LiveKit adaptiveStream)");
  }

  /** AntMedia: `enableAudioLevelForLocalStream(callback, period)`. */
  enableAudioLevelForLocalStream(cb?: (level: number) => void): void {
    // LiveKit exposes audioLevel on participants; poll the local one.
    if (this.statsTimer == null) {
      this.statsTimer = setInterval(() => {
        const level = this.room.localParticipant.audioLevel;
        cb?.(level);
        this.emit("updated_audio_level", { audioLevel: level });
      }, 1000);
    }
  }

  /** AntMedia: `updateAudioLevel(...)`. Handled natively by LiveKit; no-op. */
  updateAudioLevel(): void {}

  /**
   * StreamHub extension — resume blocked audio playback (Safari/iOS autoplay
   * policy). Call from a click/tap handler ("tap to unmute" button). The
   * adaptor also arms an automatic first-gesture unlock whenever LiveKit
   * reports playback blocked (see `audioPlaybackStatusChanged`), so calling
   * this manually is optional.
   */
  async startAudioPlayback(): Promise<void> {
    try {
      await this.room.startAudio();
    } catch (e) {
      this.log("startAudio failed (needs a user gesture)", e);
    }
  }

  /**
   * AntMedia EE: virtual-background / blur (`enableEffect`, `setBackgroundImage`).
   * No equivalent shipped with livekit-client core (needs @livekit/track-processors).
   * Documented no-op so calls don't throw. See README "No-op / deprecated".
   */
  enableEffect(_effectName?: string): Promise<void> {
    this.log("enableEffect: no-op (requires @livekit/track-processors)");
    return Promise.resolve();
  }
  setBackgroundImage(_url?: string): void {
    this.log("setBackgroundImage: no-op (requires @livekit/track-processors)");
  }

  // =========================================================================
  // LiveKit RoomEvent -> AntMedia callback mapping
  // =========================================================================

  private wireRoomEvents(): void {
    const r = this.room;

    r.on(RoomEvent.Connected, () => {
      this.connected = true;
      this.emit("session_restored");
    });

    r.on(RoomEvent.Disconnected, () => {
      this.connected = false;
      this.publishStarted = false;
      this.dataChannelOpened = false;
      this.emit("closed");
    });

    r.on(RoomEvent.Reconnecting, () => this.log("reconnecting"));
    r.on(RoomEvent.Reconnected, () => this.emit("session_restored"));

    // Local media published -> publish_started (AntMedia parity).
    r.on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
      this.refreshPeerShim();
      if (!this.publishStarted) {
        this.publishStarted = true;
        this.emit("publish_started", { streamId: this.localStreamId });
      }
      void pub;
    });

    r.on(RoomEvent.LocalTrackUnpublished, () => this.refreshPeerShim());

    // Remote track available -> newStreamAvailable.
    r.on(
      RoomEvent.TrackSubscribed,
      (
        track: RemoteTrack,
        _pub: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        this.announceTrack(track, participant);
      },
    );

    r.on(
      RoomEvent.TrackUnsubscribed,
      (
        _track: RemoteTrack,
        _pub: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        // AntMedia parity: a played remote stream going away fires
        // `play_finished` (README: "on unsubscribe / stop"). Without this the
        // event was documented but never emitted, so viewer tiles never cleaned
        // up on the drop-in path.
        this.emit("play_finished", { streamId: participant?.identity });
        this.emit("roomInformation", this.roomInfoPayload());
      },
    );

    // Roster changes -> roomInformation (the streamList the app diffs against).
    r.on(RoomEvent.ParticipantConnected, () =>
      this.emit("roomInformation", this.roomInfoPayload()),
    );
    r.on(RoomEvent.ParticipantDisconnected, () =>
      this.emit("roomInformation", this.roomInfoPayload()),
    );
    r.on(RoomEvent.TrackPublished, () =>
      this.emit("roomInformation", this.roomInfoPayload()),
    );

    // Data channel -> data_received (+ open/close lifecycle from connection).
    r.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: RemoteParticipant, _kind?: any, topic?: string) => {
        const str = textDecoder ? textDecoder.decode(payload) : "";
        this.emit("data_received", {
          streamId: participant?.identity,
          data: str,
          topic,
          event: { data: str },
        });
      },
    );

    r.on(RoomEvent.LocalTrackPublished, () => {
      // AntMedia fires `data_channel_opened` once, when the single data channel
      // opens — not once per published track. Guard so publishing camera+mic
      // (two tracks) doesn't double-emit.
      if (this.dataChannelEnabled && !this.dataChannelOpened) {
        this.dataChannelOpened = true;
        this.emit("data_channel_opened", {});
      }
    });

    // Device hot-plug -> available_devices.
    r.on(RoomEvent.MediaDevicesChanged, () => {
      void this.emitAvailableDevices();
    });

    r.on(
      RoomEvent.ConnectionStateChanged,
      (state: ConnectionState) => {
        this.emit("ice_connection_state_changed", {
          state: this.mapIceState(state),
          streamId: this.localStreamId,
        });
      },
    );

    // ---- StreamHub extensions (no AntMedia equivalent — see README) --------

    // Room metadata set server-side (PATCH /apps/:app/rooms/:room/metadata).
    r.on(RoomEvent.RoomMetadataChanged, (metadata: string) => {
      this.emit("roomMetadataChanged", {
        room: this.roomName,
        metadata,
      });
    });

    // Participant metadata set server-side (PATCH .../participants/:identity).
    r.on(
      RoomEvent.ParticipantMetadataChanged,
      (prevMetadata: string | undefined, participant: Participant) => {
        this.emit("participantMetadataChanged", {
          streamId: participant.identity,
          metadata: participant.metadata,
          prevMetadata,
          isLocal: participant === r.localParticipant,
        });
      },
    );

    // Connection quality (excellent/good/poor/lost) per participant — drives
    // poor-connection banners in players.
    r.on(
      RoomEvent.ConnectionQualityChanged,
      (quality: ConnectionQuality, participant: Participant) => {
        this.emit("connectionQualityChanged", {
          streamId: participant.identity,
          quality: String(quality),
          isLocal: participant === r.localParticipant,
        });
      },
    );

    // Active speakers (ordered by audio level) — drives speaker highlight.
    r.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      this.emit("activeSpeakersChanged", {
        speakers: speakers.map((p) => p.identity),
      });
    });

    // Autoplay policy (WEBRTC-BROWSER-COMPAT): Safari/iOS block audio
    // playback until a user gesture. When LiveKit reports it blocked, arm a
    // ONE-SHOT first-gesture unlock (room.startAudio()) so drop-in apps get
    // sound on the first tap with zero code changes, and surface the state so
    // apps can render their own "tap to unmute" UI.
    r.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      const canPlayback = r.canPlaybackAudio;
      this.emit("audioPlaybackStatusChanged", { canPlayback });
      if (!canPlayback) {
        this.armAutoplayUnlock();
      } else if (this.autoplayUnlockDispose) {
        this.autoplayUnlockDispose();
        this.autoplayUnlockDispose = null;
      }
    });

    // Camera/mic acquisition failures OUTSIDE an explicit publish() call
    // (device switch, reconnect re-acquire). AntMedia parity: emit the
    // DOMException name apps already switch on.
    r.on(RoomEvent.MediaDevicesError, (e: Error) => {
      this.error(
        classifyGetUserMediaError(e) ?? "mediaDevicesError",
        e?.message || String(e),
      );
    });
  }

  /** Arm the one-shot gesture unlock for blocked audio (idempotent). */
  private armAutoplayUnlock(): void {
    if (this.autoplayUnlockDispose) return;
    this.autoplayUnlockDispose = installAutoplayUnlock(() => {
      this.autoplayUnlockDispose = null;
      void this.startAudioPlayback();
    });
  }

  private announceTrack(track: RemoteTrack, participant: Participant): void {
    const mst = track.mediaStreamTrack;
    const stream = new MediaStream([mst]);
    if (track.kind === Track.Kind.Video) {
      this.emit("newStreamAvailable", {
        // AntMedia trackId convention: "ARDAMSx" + <slot/streamId>.
        trackId: "ARDAMSx" + participant.identity,
        track: mst,
        streamId: participant.identity,
        stream,
        streamName: participant.name || participant.identity,
      });
    } else if (track.kind === Track.Kind.Audio) {
      this.emit("newStreamAvailable", {
        trackId: "ARDAMSx" + participant.identity,
        track: mst,
        streamId: participant.identity,
        stream,
      });
    }
  }

  // =========================================================================
  // helpers
  // =========================================================================

  private async ensureConnected(
    room: string,
    identity: string,
    grants: { canPublish: boolean; canSubscribe: boolean },
  ): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const tok = await resolveToken(this.config, {
        room,
        identity,
        canPublish: grants.canPublish,
        canSubscribe: grants.canSubscribe,
      });
      const connectOpts: RoomConnectOptions = { autoSubscribe: true };
      try {
        await this.room.connect(tok.wsUrl, tok.token, connectOpts);
      } catch (e: any) {
        // Transport-level failures get the TURN hint appended: Safari behind
        // symmetric NAT/VPN is the #1 "connects on WiFi, fails at the office"
        // report, and the fix (TURN/TLS) is server-side.
        throw new Error(withTurnHint(e?.message || String(e)));
      }
      this.connected = true;
      this.roomName = tok.room || room;
      this.refreshPeerShim();
      void this.emitAvailableDevices();
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async disconnectInternal(): Promise<void> {
    this.disableStats();
    if (this.autoplayUnlockDispose) {
      this.autoplayUnlockDispose();
      this.autoplayUnlockDispose = null;
    }
    if (this.connected || this.room.state !== ConnectionState.Disconnected) {
      await this.room.disconnect();
    }
    this.connected = false;
    this.publishStarted = false;
  }

  private roomInfoPayload() {
    const streams = Array.from(this.room.remoteParticipants.values()).map(
      (p) => p.identity,
    );
    return {
      ATTR_ROOM_NAME: this.roomName,
      streamId: this.localStreamId,
      streams,
      streamList: streams,
      maxTrackCount: streams.length,
    };
  }

  private async emitAvailableDevices(): Promise<MediaDeviceInfo[]> {
    let devices: MediaDeviceInfo[] = [];
    try {
      devices = await Room.getLocalDevices();
    } catch {
      try {
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch {
        devices = [];
      }
    }
    // AntMedia passes the raw device array as `obj`.
    this.emit("available_devices", devices as any);
    return devices;
  }

  private attachLocalPreview(): void {
    if (!this.localVideoElement) return;
    // Re-assert inline/muted before every attach — apps re-create or re-parent
    // preview elements between camera switches (iOS drops the attributes).
    applyInlinePlaybackAttributes(this.localVideoElement, { muted: true });
    const camPub = this.room.localParticipant.getTrackPublication(
      Track.Source.Camera,
    );
    if (camPub?.track) {
      camPub.track.attach(this.localVideoElement);
    }
  }

  private videoCaptureOptions(flip = false): any {
    const v = this.mediaConstraints?.video;
    const opts: any = {};
    if (v && typeof v === "object") {
      if (v.deviceId) opts.deviceId = (v.deviceId as any).exact ?? v.deviceId;
      const w = (v.width as any)?.ideal ?? v.width;
      const h = (v.height as any)?.ideal ?? v.height;
      if (w && h) opts.resolution = { width: w, height: h };
      if (v.facingMode) opts.facingMode = v.facingMode;
    }
    if (flip) {
      opts.facingMode = opts.facingMode === "environment" ? "user" : "environment";
    }
    return opts;
  }

  /**
   * Build/refresh the AntMedia `remotePeerConnection[streamId]` shim so apps
   * that reach into `getSenders()` (replaceTrack / setParameters for bitrate &
   * device switching — e.g. streambuy's mobile-streamer) keep working.
   */
  private refreshPeerShim(): void {
    const self = this;
    const shim = {
      getSenders(): RTCRtpSender[] {
        const senders: RTCRtpSender[] = [];
        for (const pub of self.room.localParticipant.trackPublications.values()) {
          const sender = (pub.track as any)?.sender as RTCRtpSender | undefined;
          if (sender) senders.push(sender);
        }
        return senders;
      },
      getReceivers(): RTCRtpReceiver[] {
        return [];
      },
    };
    if (this.localStreamId) this.remotePeerConnection[this.localStreamId] = shim;
  }

  private async sampleStats(): Promise<void> {
    try {
      let bytesSent = 0;
      let packetsSent = 0;
      let videoPacketsLost = 0;
      let audioPacketsLost = 0;
      let videoJitter = 0;
      let audioJitter = 0;
      let videoRtt = 0;
      let audioRtt = 0;
      let videoPacketsSent = 0;
      let audioPacketsSent = 0;

      for (const pub of this.room.localParticipant.trackPublications.values()) {
        const track: any = pub.track;
        if (!track?.getRTCStatsReport) continue;
        const report: RTCStatsReport = await track.getRTCStatsReport();
        report.forEach((s: any) => {
          if (s.type === "outbound-rtp") {
            bytesSent += s.bytesSent || 0;
            packetsSent += s.packetsSent || 0;
            if (s.kind === "video") videoPacketsSent += s.packetsSent || 0;
            if (s.kind === "audio") audioPacketsSent += s.packetsSent || 0;
          }
          if (s.type === "remote-inbound-rtp") {
            if (s.kind === "video") {
              videoPacketsLost += s.packetsLost || 0;
              videoJitter = (s.jitter || 0) * 1000;
              videoRtt = (s.roundTripTime || 0) * 1000;
            } else if (s.kind === "audio") {
              audioPacketsLost += s.packetsLost || 0;
              audioJitter = (s.jitter || 0) * 1000;
              audioRtt = (s.roundTripTime || 0) * 1000;
            }
          }
        });
      }

      const now = Date.now();
      let currentOutgoingBitrate = 0;
      if (this.lastStatsSample) {
        const dt = (now - this.lastStatsSample.ts) / 1000;
        if (dt > 0) {
          currentOutgoingBitrate = Math.round(
            ((bytesSent - this.lastStatsSample.bytesSent) * 8) / dt / 1000,
          );
        }
      }
      this.lastStatsSample = { ts: now, bytesSent };

      this.emit("updated_stats", {
        videoRoundTripTime: videoRtt,
        audioRoundTripTime: audioRtt,
        videoJitter,
        audioJitter,
        currentOutgoingBitrate,
        videoPacketsLost,
        audioPacketsLost,
        totalVideoPacketsSent: videoPacketsSent,
        totalAudioPacketsSent: audioPacketsSent,
        totalBytesSent: bytesSent,
        totalPacketsSent: packetsSent,
      });
    } catch (e) {
      this.log("sampleStats failed", e);
    }
  }

  private mapIceState(state: ConnectionState): string {
    switch (state) {
      case ConnectionState.Connected:
        return "connected";
      case ConnectionState.Connecting:
        return "checking";
      case ConnectionState.Reconnecting:
        return "disconnected";
      case ConnectionState.Disconnected:
        return "closed";
      default:
        return "new";
    }
  }

  private emit(info: string, obj?: any): void {
    this.log("callback", info, obj);
    try {
      this.callback(info, obj);
    } catch (e) {
      this.log("callback threw", e);
    }
  }

  private error(error: string, message?: any): void {
    this.log("error", error, message);
    try {
      this.callbackError(error, message);
    } catch (e) {
      this.log("callbackError threw", e);
    }
  }

  private log(...args: any[]): void {
    if (this.debug) console.log("[StreamHubAdaptor]", ...args);
  }
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
