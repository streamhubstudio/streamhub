/**
 * useRadioMaster — drives the "máster" side of a WebRTC radio (Wave 4, spec §6).
 *
 * The máster publishes AUDIO ONLY (mic) to the room with a publish token; the
 * listeners join elsewhere as subscribe-only participants. No server egress is
 * involved — this is pure low-latency WebRTC fan-out via LiveKit.
 *
 * Flow:
 *  - start(): mint a publish token (POST /apps/:app/tokens { room,
 *    canPublish:true, audioOnly:true }), connect with livekit-client and publish
 *    ONLY the microphone.
 *  - stop(): disconnect + release the mic.
 *  - listeners: live count of remote participants (the oyentes) in the room.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  type LocalAudioTrack,
} from 'livekit-client'
import { api, ApiRequestError } from '@/api'
import i18n from '@/i18n'

const t = (key: string, opts?: Record<string, unknown>) =>
  i18n.t(`radio:errors.${key}`, opts ?? {})

export type RadioPhase = 'idle' | 'connecting' | 'live' | 'stopping'
export type RadioPermission = 'unknown' | 'granted' | 'denied' | 'error'

export interface RadioMasterState {
  phase: RadioPhase
  permission: RadioPermission
  error: string | null
  mics: MediaDeviceInfo[]
  micId: string
  /** Live count of subscribe-only listeners (remote participants). */
  listeners: number
  /** Epoch ms when we went on air. */
  startedAt: number | null
}

function messageFrom(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.message
  if (err instanceof Error) return err.message
  return fallback
}

export function useRadioMaster(app: string, room: string) {
  const [phase, setPhase] = useState<RadioPhase>('idle')
  const [permission, setPermission] = useState<RadioPermission>('unknown')
  const [error, setError] = useState<string | null>(null)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [micId, setMicId] = useState('')
  const [listeners, setListeners] = useState(0)
  const [startedAt, setStartedAt] = useState<number | null>(null)

  const roomRef = useRef<Room | null>(null)
  const audioRef = useRef<LocalAudioTrack | null>(null)
  const phaseRef = useRef<RadioPhase>('idle')
  const mountedRef = useRef(true)

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const refreshMics = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      if (!mountedRef.current) return
      const auds = all.filter((d) => d.kind === 'audioinput')
      setMics(auds)
      setMicId((cur) => cur || auds[0]?.deviceId || '')
    } catch {
      /* best-effort */
    }
  }, [])

  // Probe for mic permission + enumerate once on mount.
  useEffect(() => {
    mountedRef.current = true
    void refreshMics()
    return () => {
      mountedRef.current = false
      void roomRef.current?.disconnect()
      audioRef.current?.stop()
    }
  }, [refreshMics])

  const teardown = useCallback(async () => {
    const r = roomRef.current
    roomRef.current = null
    if (r) {
      try {
        await r.disconnect()
      } catch {
        /* ignore */
      }
    }
    if (audioRef.current) {
      audioRef.current.stop()
      audioRef.current = null
    }
  }, [])

  const start = useCallback(async () => {
    const roomName = room.trim()
    if (!roomName) {
      setError(t('noRoom'))
      return
    }
    setError(null)
    setPhase('connecting')

    try {
      // Mic is REQUIRED for radio.
      let audio: LocalAudioTrack
      try {
        audio = await createLocalAudioTrack(micId ? { deviceId: micId } : {})
        audioRef.current = audio
        setPermission('granted')
        void refreshMics()
      } catch (micErr) {
        const name = (micErr as { name?: string })?.name
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setPermission('denied')
          throw new Error(t('micDenied'))
        }
        setPermission('error')
        throw new Error(messageFrom(micErr, t('micAccess')))
      }

      const minted = await api.tokens.mint(app, {
        room: roomName,
        canPublish: true,
        canSubscribe: false,
        audioOnly: true,
      })
      if (!minted?.token || !minted?.wsUrl) {
        throw new Error(t('noToken'))
      }

      const lkRoom = new Room({ adaptiveStream: false, dynacast: false })
      roomRef.current = lkRoom

      const syncListeners = () => {
        if (mountedRef.current) setListeners(lkRoom.remoteParticipants.size)
      }
      lkRoom.on(RoomEvent.ParticipantConnected, syncListeners)
      lkRoom.on(RoomEvent.ParticipantDisconnected, syncListeners)
      lkRoom.on(RoomEvent.Disconnected, () => {
        if (phaseRef.current === 'live' || phaseRef.current === 'connecting') {
          if (mountedRef.current) {
            setError(t('connLost'))
            setListeners(0)
            setStartedAt(null)
            setPhase('idle')
          }
          void teardown()
        }
      })

      await lkRoom.connect(minted.wsUrl, minted.token)
      await lkRoom.localParticipant.publishTrack(audio, {
        source: Track.Source.Microphone,
        name: 'radio',
      })
      if (!mountedRef.current) {
        void teardown()
        return
      }
      syncListeners()
      setStartedAt(Date.now())
      setPhase('live')
    } catch (err) {
      await teardown()
      if (!mountedRef.current) return
      setError(messageFrom(err, t('goLiveFailed')))
      setPhase('idle')
    }
  }, [app, room, micId, refreshMics, teardown])

  const stop = useCallback(async () => {
    setPhase('stopping')
    await teardown()
    if (!mountedRef.current) return
    setListeners(0)
    setStartedAt(null)
    setPhase('idle')
  }, [teardown])

  const selectMic = useCallback((id: string) => setMicId(id), [])

  const state: RadioMasterState = {
    phase,
    permission,
    error,
    mics,
    micId,
    listeners,
    startedAt,
  }

  return { state, start, stop, selectMic, clearError: () => setError(null) }
}
