/**
 * usePublisher — owns the full Studio publish lifecycle for the Broadcast page.
 *
 * Responsibilities:
 *  - Acquire a local camera preview track (and enumerate cameras/mics once the
 *    browser grants permission) so the user sees themselves BEFORE going live.
 *  - On start(): mint a publish token (POST /apps/:app/tokens { room,
 *    canPublish:true }), connect to LiveKit with livekit-client and PUBLISH the
 *    camera + mic, then call POST /apps/:app/broadcast/start with the *actual*
 *    (prefixed) room name so the room-composite egress pushes to the RTMP URL.
 *  - On stop(): POST /apps/:app/broadcast/:id/stop, disconnect, drop the mic.
 *  - Poll GET /apps/:app/broadcast to reflect the live egress status, and react
 *    to unexpected room disconnects / terminal egress states without crashing.
 *
 * The browser publishes over WebRTC; the SERVER renders the room and forwards
 * it to RTMP. This is NOT a direct RTMP push from the browser.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from 'livekit-client'
import { api, ApiRequestError } from '@/api'
import i18n from '@/i18n'

const t = (key: string, opts?: Record<string, unknown>) =>
  i18n.t(`broadcast:errors.${key}`, opts ?? {})

export type Phase = 'idle' | 'connecting' | 'live' | 'stopping'
export type Permission = 'unknown' | 'granted' | 'denied' | 'error'

export interface EgressInfo {
  id: string
  status: string
}

export interface PublisherState {
  phase: Phase
  permission: Permission
  /** Fatal/blocking error (start failed, connection lost, …). */
  error: string | null
  /** Non-blocking notice (e.g. mic unavailable, egress stop failed). */
  warning: string | null
  cameras: MediaDeviceInfo[]
  mics: MediaDeviceInfo[]
  cameraId: string
  micId: string
  /** Live local camera track to attach to a <video> for preview. */
  previewTrack: LocalVideoTrack | null
  egress: EgressInfo | null
  /** Epoch ms when the broadcast went live (for the duration timer). */
  startedAt: number | null
  /** Audio-only broadcast: publish + compose only the mic (no camera). */
  audioOnly: boolean
}

const TERMINAL = /COMPLETE|FAILED|ABORTED|ENDED/i

/** Accept rtmp:// or rtmps:// with a host AND a path (the stream key). */
export function isValidRtmpUrl(raw: string): boolean {
  return /^rtmps?:\/\/[^\s/]+\/.+/i.test(raw.trim())
}

function messageFrom(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.message
  if (err instanceof Error) return err.message
  return fallback
}

export function usePublisher(app: string) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [permission, setPermission] = useState<Permission>('unknown')
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [cameraId, setCameraId] = useState('')
  const [micId, setMicId] = useState('')
  const [previewTrack, setPreviewTrack] = useState<LocalVideoTrack | null>(null)
  const [egress, setEgress] = useState<EgressInfo | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [audioOnly, setAudioOnlyState] = useState(false)

  // Imperative handles + a phase mirror readable inside event callbacks.
  const roomRef = useRef<Room | null>(null)
  const previewRef = useRef<LocalVideoTrack | null>(null)
  const audioRef = useRef<LocalAudioTrack | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const phaseRef = useRef<Phase>('idle')
  const audioOnlyRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  /** Tear down the live session. Optionally keep the preview track alive. */
  const teardown = useCallback(
    async (keepPreview: boolean) => {
      stopPolling()
      const room = roomRef.current
      roomRef.current = null
      if (room) {
        try {
          await room.disconnect()
        } catch {
          /* ignore */
        }
      }
      if (audioRef.current) {
        audioRef.current.stop()
        audioRef.current = null
      }
      if (!keepPreview && previewRef.current) {
        previewRef.current.stop()
        previewRef.current = null
        if (mountedRef.current) setPreviewTrack(null)
      }
    },
    [stopPolling],
  )

  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      if (!mountedRef.current) return
      const vids = all.filter((d) => d.kind === 'videoinput')
      const auds = all.filter((d) => d.kind === 'audioinput')
      setCameras(vids)
      setMics(auds)
      setCameraId((cur) => cur || vids[0]?.deviceId || '')
      setMicId((cur) => cur || auds[0]?.deviceId || '')
    } catch {
      /* enumeration is best-effort */
    }
  }, [])

  /** Open (or re-open) the camera preview. Requests permission as a side effect. */
  const openPreview = useCallback(
    async (deviceId?: string) => {
      try {
        const track = await createLocalVideoTrack(
          deviceId ? { deviceId } : {},
        )
        if (!mountedRef.current) {
          track.stop()
          return
        }
        previewRef.current?.stop()
        previewRef.current = track
        setPreviewTrack(track)
        setPermission('granted')
        setError(null)
        await refreshDevices()
      } catch (err) {
        if (!mountedRef.current) return
        const name = (err as { name?: string })?.name
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setPermission('denied')
        } else {
          setPermission('error')
          setError(
            name === 'NotFoundError'
              ? t('noCamera')
              : messageFrom(err, t('cameraAccess')),
          )
        }
      }
    },
    [refreshDevices],
  )

  // Acquire the preview once on mount.
  useEffect(() => {
    mountedRef.current = true
    void openPreview()
    return () => {
      mountedRef.current = false
      stopPolling()
      void roomRef.current?.disconnect()
      audioRef.current?.stop()
      previewRef.current?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Switch the preview camera (only allowed while idle). */
  const selectCamera = useCallback(
    (deviceId: string) => {
      setCameraId(deviceId)
      if (phaseRef.current === 'idle' && !audioOnlyRef.current) void openPreview(deviceId)
    },
    [openPreview],
  )

  const selectMic = useCallback((deviceId: string) => setMicId(deviceId), [])

  /** Toggle audio-only mode (only meaningful while idle). */
  const setAudioOnly = useCallback(
    (v: boolean) => {
      setAudioOnlyState(v)
      audioOnlyRef.current = v
      if (v) {
        // Drop the camera preview — audio-only publishes no video.
        previewRef.current?.stop()
        previewRef.current = null
        if (mountedRef.current) setPreviewTrack(null)
      } else if (phaseRef.current === 'idle') {
        void openPreview(cameraId || undefined)
      }
    },
    [openPreview, cameraId],
  )

  const startPolling = useCallback(
    (egressId: string) => {
      stopPolling()
      pollRef.current = setInterval(async () => {
        try {
          const list = await api.broadcast.list(app)
          const mine = list.find((e) => e.egressId === egressId)
          if (!mountedRef.current) return
          if (!mine) return
          setEgress({ id: mine.egressId, status: mine.status })
          if (TERMINAL.test(mine.status) && phaseRef.current === 'live') {
            setWarning(t('egressEnded', { status: mine.status }))
            void teardown(true)
            setStartedAt(null)
            setEgress(null)
            setPhase('idle')
          }
        } catch {
          /* transient poll error — ignore */
        }
      }, 4000)
    },
    [app, stopPolling, teardown],
  )

  const start = useCallback(
    async (rtmpUrl: string, roomName: string) => {
      const url = rtmpUrl.trim()
      const room = roomName.trim() || 'studio'
      if (!isValidRtmpUrl(url)) {
        setError(t('rtmpInvalid'))
        return
      }
      setError(null)
      setWarning(null)
      setPhase('connecting')

      const audioOnlyNow = audioOnlyRef.current
      try {
        // Ensure a camera track exists (reuse the preview) — unless audio-only.
        let video: LocalVideoTrack | null = null
        if (!audioOnlyNow) {
          video = previewRef.current
          if (!video) {
            video = await createLocalVideoTrack(cameraId ? { deviceId: cameraId } : {})
            previewRef.current = video
            setPreviewTrack(video)
          }
        }

        // Mic: best-effort with video; REQUIRED in audio-only mode.
        let audio: LocalAudioTrack | null = null
        try {
          audio = await createLocalAudioTrack(micId ? { deviceId: micId } : {})
          audioRef.current = audio
        } catch (micErr) {
          const detail = messageFrom(micErr, t('audioAccess'))
          if (audioOnlyNow) {
            throw new Error(t('micRequired', { detail }))
          }
          setWarning(t('micFallbackVideo', { detail }))
        }

        // 1) publish token
        const minted = await api.tokens.mint(app, {
          room,
          canPublish: true,
          canSubscribe: false,
          audioOnly: audioOnlyNow,
        })
        if (!minted?.token || !minted?.wsUrl) {
          throw new Error(t('noToken'))
        }

        // 2) connect + publish over WebRTC
        const lkRoom = new Room({ adaptiveStream: false, dynacast: false })
        roomRef.current = lkRoom
        lkRoom.on(RoomEvent.Disconnected, () => {
          if (phaseRef.current === 'live' || phaseRef.current === 'connecting') {
            if (mountedRef.current) {
              setError(t('connLost'))
              setWarning(null)
              setEgress(null)
              setStartedAt(null)
              setPhase('idle')
            }
            void teardown(true)
          }
        })

        await lkRoom.connect(minted.wsUrl, minted.token)
        if (video) {
          await lkRoom.localParticipant.publishTrack(video, {
            source: Track.Source.Camera,
            name: 'camera',
          })
        }
        if (audio) {
          await lkRoom.localParticipant.publishTrack(audio, {
            source: Track.Source.Microphone,
          })
        }

        // 3) start the room-composite egress against the ACTUAL room name
        //    (the server namespaces it with the app prefix on token mint).
        const actualRoom = lkRoom.name || room
        const eg = await api.broadcast.start(app, {
          roomName: actualRoom,
          rtmpUrl: url,
        })
        if (!mountedRef.current) {
          void teardown(true)
          return
        }
        setEgress({ id: eg.egressId, status: eg.status })
        setStartedAt(Date.now())
        setPhase('live')
        startPolling(eg.egressId)
      } catch (err) {
        await teardown(true)
        if (!mountedRef.current) return
        setError(messageFrom(err, t('startFailed')))
        setPhase('idle')
      }
    },
    [app, cameraId, micId, startPolling, teardown],
  )

  const stop = useCallback(async () => {
    setPhase('stopping')
    const current = egress
    try {
      if (current?.id) await api.broadcast.stop(app, current.id)
    } catch (err) {
      setWarning(
        t('stopUnconfirmed', { detail: messageFrom(err, t('unknown')) }),
      )
    }
    await teardown(true)
    if (!mountedRef.current) return
    setEgress(null)
    setStartedAt(null)
    setPhase('idle')
  }, [app, egress, teardown])

  const state: PublisherState = {
    phase,
    permission,
    error,
    warning,
    cameras,
    mics,
    cameraId,
    micId,
    previewTrack,
    egress,
    startedAt,
    audioOnly,
  }

  return {
    state,
    start,
    stop,
    selectCamera,
    selectMic,
    setAudioOnly,
    retryPermission: () => openPreview(cameraId || undefined),
    clearError: () => setError(null),
    clearWarning: () => setWarning(null),
  }
}
