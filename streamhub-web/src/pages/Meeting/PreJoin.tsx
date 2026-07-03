/**
 * Pre-join card: choose a display name and whether to enter with camera/mic
 * on, before a join token is minted and the LiveKit connection opens.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface JoinChoices {
  name: string
  audio: boolean
  video: boolean
}

interface PreJoinProps {
  app: string
  room: string
  connecting: boolean
  onJoin: (choices: JoinChoices) => void
}

function Switch({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-lg border border-gray-800 bg-gray-800 px-4 py-3 text-sm text-gray-200 transition hover:border-gray-800/80"
    >
      <span>{label}</span>
      <span
        className={[
          'relative h-5 w-9 rounded-full transition',
          checked ? 'bg-primary-500' : 'bg-gray-700',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-0.5 h-4 w-4 rounded-full bg-white transition',
            checked ? 'left-4' : 'left-0.5',
          ].join(' ')}
        />
      </span>
    </button>
  )
}

export default function PreJoin({ app, room, connecting, onJoin }: PreJoinProps) {
  const { t } = useTranslation('meeting')
  const [name, setName] = useState('')
  const [audio, setAudio] = useState(true)
  const [video, setVideo] = useState(true)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    onJoin({ name: name.trim(), audio, video })
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-md bg-gray-900/90 ring-1 ring-white/10 backdrop-blur rounded-2xl p-6 sm:p-8">
        <p className="text-xs uppercase tracking-wider text-primary-400">{app}</p>
        <h1 className="mt-1 text-2xl font-semibold text-fg">{room}</h1>
        <p className="mt-1 text-sm text-gray-400">
          {t('prejoin.subtitle')}
        </p>

        <label className="mt-6 block text-xs font-medium text-gray-400">
          {t('prejoin.nameLabel')}
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('prejoin.namePlaceholder')}
          autoFocus
          className="mt-1.5 w-full rounded-lg border border-gray-800 bg-gray-800 px-3 py-2.5 text-sm text-fg placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/60"
        />

        <div className="mt-4 space-y-2.5">
          <Switch label={t('prejoin.withMic')} checked={audio} onChange={setAudio} />
          <Switch label={t('prejoin.withCam')} checked={video} onChange={setVideo} />
        </div>

        <button
          type="submit"
          disabled={connecting}
          className="bg-primary-500 text-white hover:bg-primary-600 mt-6 w-full rounded-lg py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          {connecting ? t('prejoin.connecting') : t('prejoin.join')}
        </button>
      </form>
    </div>
  )
}
