/**
 * Cockpit — a single grid cell.
 *
 * Renders one camera: a header strip (drag handle + label + per-cell fullscreen)
 * over the app's PUBLIC embed player (<LivePlayer access="public">, i.e. a
 * subscribe-only play-token — no login needed). When auto-play is off the player
 * is mounted lazily behind a click-to-play poster so a wall of cameras doesn't
 * open N connections at once.
 *
 * Dragging is initiated from the header handle ONLY, so the in-player controls
 * (mute / fullscreen / unmute) stay clickable.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LivePlayer } from '@/components/player'

export interface CockpitCamera {
  /** Stable id used for drag ordering (the public streamId). */
  id: string
  /** LiveKit room to subscribe to. */
  room: string
  /** Human label (participant / streamId). */
  label: string
}

export interface CockpitCellProps {
  app: string
  camera: CockpitCamera
  autoPlay: boolean
  showLabels: boolean
  /** True while THIS cell is the one being dragged. */
  dragging: boolean
  /** True while a dragged cell is hovering over THIS cell (drop target hint). */
  dropTarget: boolean
  onDragStart: (id: string) => void
  onDragEnter: (id: string) => void
  onDragEnd: () => void
  onDrop: (id: string) => void
}

const iconCls = 'h-3.5 w-3.5'

export function CockpitCell({
  app,
  camera,
  autoPlay,
  showLabels,
  dragging,
  dropTarget,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop,
}: CockpitCellProps) {
  const { t } = useTranslation('cockpit')
  const cellRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(autoPlay)
  const [isFs, setIsFs] = useState(false)

  // Follow the config: turning auto-play on plays idle cells; turning it off
  // does NOT tear down an already-playing cell (avoids flicker on config edits).
  useEffect(() => {
    if (autoPlay) setPlaying(true)
  }, [autoPlay])

  useEffect(() => {
    const onChange = () => setIsFs(document.fullscreenElement === cellRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const el = cellRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void el.requestFullscreen().catch(() => {})
  }, [])

  return (
    <div
      ref={cellRef}
      onDragEnter={() => onDragEnter(camera.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        onDrop(camera.id)
      }}
      className={[
        'group relative flex flex-col overflow-hidden rounded-lg bg-gray-900 ring-1 transition',
        dropTarget ? 'ring-2 ring-primary-500' : 'ring-gray-700',
        dragging ? 'opacity-50' : 'opacity-100',
        isFs ? 'h-full' : '',
      ].join(' ')}
    >
      {/* Header strip: drag handle + label + fullscreen. */}
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', camera.id)
          onDragStart(camera.id)
        }}
        onDragEnd={onDragEnd}
        className="flex cursor-grab items-center gap-1.5 border-b border-gray-700 bg-gray-800/80 px-2 py-1 active:cursor-grabbing"
      >
        <svg
          className={`${iconCls} shrink-0 text-gray-500`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01"
          />
        </svg>
        {showLabels ? (
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-gray-200">
            {camera.label}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={isFs ? t('cell.exitFullscreen') : t('cell.fullscreen')}
          title={isFs ? t('cell.exitFullscreen') : t('cell.fullscreen')}
          className="shrink-0 rounded p-0.5 text-gray-400 transition hover:text-white"
        >
          <svg
            className={iconCls}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d={
                isFs
                  ? 'M9 9H5m4 0V5m6 4h4m-4 0V5m0 10h4m-4 0v4m-6-4H5m4 0v4'
                  : 'M8 4H4v4m0 8v4h4m8-16h4v4m0 8v4h-4'
              }
            />
          </svg>
        </button>
      </div>

      {/* Player area (16:9). */}
      <div className="relative aspect-video w-full flex-1 bg-black">
        {playing ? (
          <LivePlayer
            app={app}
            room={camera.room}
            access="public"
            className="!rounded-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-400 transition hover:text-white"
            aria-label={t('cell.play', { name: camera.label })}
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
              <svg
                className="h-5 w-5"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
            <span className="text-[11px]">{t('cell.clickToPlay')}</span>
          </button>
        )}
      </div>
    </div>
  )
}

/** A muted empty slot so the grid keeps its fixed CCTV shape when under-filled. */
export function CockpitEmptyCell() {
  const { t } = useTranslation('cockpit')
  return (
    <div className="flex aspect-video flex-col items-center justify-center rounded-lg bg-gray-100 text-gray-400 ring-1 ring-dashed ring-gray-300 dark:bg-gray-900/40 dark:text-gray-600 dark:ring-gray-700">
      <svg
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15 10l4.5-2.5v9L15 14M3 7h12v10H3z"
        />
      </svg>
      <span className="mt-1 text-[11px]">{t('cell.noSignal')}</span>
    </div>
  )
}
