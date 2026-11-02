/**
 * Encoders tab — field devices of this app (streamhub-docs/features/devices.md):
 * claim a device by the code on its screen (POST /apps/:app/devices/claim),
 * list devices with liveness + last status, link a device channel to a room
 * (the core mints the ingress and pushes it to the device), send commands,
 * rename and revoke. The whole plane is off by default server side
 * (STREAMHUB_DEVICES_ENABLE): a 503 renders an "enable it" notice.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import type { Device, DeviceAction, DeviceChannelStatus, DeviceCommandResult } from '@/api'
import { formatDateTime } from '@/lib/datetime'
import { useAppTimezone } from '@/lib/appTimezone'
import { channelStateTone, linkableChannels, normalizePairingCode } from '@/lib/devices'
import {
  Badge,
  Button,
  Card,
  CopyField,
  Empty,
  ErrorBanner,
  Field,
  Loading,
  SectionTitle,
  Select,
  TextInput,
  errMessage,
  isServiceUnavailable,
} from './ui'

export function DevicesTab({ app }: { app: string }) {
  const { t } = useTranslation('devicesTab')
  const qc = useQueryClient()
  const key = ['devices', app]

  const list = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.devices.list(app, signal),
    refetchInterval: 10_000,
    retry: (n, err) => !isServiceUnavailable(err) && n < 2,
  })

  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const claim = useMutation({
    mutationFn: () => api.devices.claim(app, normalizePairingCode(code) ?? code, name.trim() || undefined),
    onSuccess: () => {
      setCode('')
      setName('')
      void qc.invalidateQueries({ queryKey: key })
    },
  })

  if (list.isError && isServiceUnavailable(list.error)) {
    return (
      <Card>
        <SectionTitle title={t('disabled.title')} subtitle={t('disabled.body')} />
        <code className="text-xs text-sky2">STREAMHUB_DEVICES_ENABLE=on</code>
      </Card>
    )
  }

  const codeOk = normalizePairingCode(code) !== null
  const devices = list.data ?? []

  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle title={t('claim.title')} subtitle={t('claim.subtitle')} />
        <form
          className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault()
            if (codeOk) claim.mutate()
          }}
        >
          <Field label={t('claim.codeLabel')} hint={t('claim.codeHint')}>
            <TextInput
              value={code}
              placeholder="K7Q4-M2XP"
              autoComplete="off"
              spellCheck={false}
              className="font-mono uppercase tracking-widest"
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Field label={t('claim.nameLabel')}>
            <TextInput value={name} placeholder={t('claim.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button variant="accent" type="submit" disabled={!codeOk || claim.isPending}>
            {claim.isPending ? t('claim.claiming') : t('claim.submit')}
          </Button>
        </form>
        {claim.isError && (
          <div className="mt-4">
            <ErrorBanner message={errMessage(claim.error, t('claim.error'))} />
          </div>
        )}
        {claim.data && <p className="mt-3 text-xs text-emerald-300">{t('claim.done', { name: claim.data.name })}</p>}
      </Card>

      {list.isLoading ? (
        <Loading />
      ) : list.isError ? (
        <ErrorBanner message={errMessage(list.error, t('list.error'))} />
      ) : devices.length === 0 ? (
        <Card>
          <Empty label={t('list.empty')} />
        </Card>
      ) : (
        devices.map((d) => <DeviceCard key={d.id} app={app} device={d} />)
      )}
    </div>
  )
}

function DeviceCard({ app, device: d }: { app: string; device: Device }) {
  const { t } = useTranslation('devicesTab')
  const tz = useAppTimezone()
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['devices', app] })

  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState(d.name)
  const rename = useMutation({
    mutationFn: () => api.devices.rename(app, d.id, newName.trim()),
    onSuccess: () => {
      setRenaming(false)
      void refresh()
    },
  })
  const revoke = useMutation({ mutationFn: () => api.devices.revoke(app, d.id), onSuccess: refresh })

  const [lastResult, setLastResult] = useState<DeviceCommandResult | null>(null)
  const command = useMutation({
    mutationFn: (body: { action: DeviceAction; channel?: string; preset?: string; confirm?: boolean }) =>
      api.devices.command(app, d.id, body),
    onSuccess: setLastResult,
  })

  const status = d.status
  const chanStatus = new Map((status?.channels ?? []).map((c) => [c.id, c]))
  const channels = linkableChannels(d.capabilities?.channels, d.channels)
  const linked = new Map(d.channels.map((c) => [c.id, c]))

  return (
    <Card>
      <SectionTitle
        title={d.name}
        subtitle={[d.model, d.version && `v${d.version}`, d.serial].filter(Boolean).join(' · ') || d.id}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={d.online ? 'green' : 'slate'}>{d.online ? t('device.online') : t('device.offline')}</Badge>
            {!d.paired && <Badge tone="amber">{t('device.awaitingCredential')}</Badge>}
          </div>
        }
      />

      <dl className="mb-4 grid gap-x-6 gap-y-1 text-xs text-fg-muted sm:grid-cols-4">
        <div>
          <dt className="text-fg-subtle">{t('device.lastSeen')}</dt>
          <dd>{formatDateTime(d.lastSeenAt, tz)}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">CPU / GPU</dt>
          <dd className="tabular-nums">
            {status?.cpu ?? '—'}% / {status?.gpu ?? '—'}%
          </dd>
        </div>
        <div>
          <dt className="text-fg-subtle">{t('device.temperature')}</dt>
          <dd className="tabular-nums">{status?.temperature != null ? `${status.temperature} °C` : '—'}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">IP</dt>
          <dd className="font-mono">{d.lastIp ?? '—'}</dd>
        </div>
      </dl>
      {(status?.errors?.length ?? 0) > 0 && (
        <div className="mb-4">
          <ErrorBanner message={(status?.errors ?? []).join(' · ')} />
        </div>
      )}

      <div className="space-y-3">
        {channels.length === 0 && <p className="text-xs text-fg-subtle">{t('channels.none')}</p>}
        {channels.map((c) => (
          <ChannelRow
            key={c.id}
            app={app}
            deviceId={d.id}
            channel={c}
            link={linked.get(c.id)}
            state={chanStatus.get(c.id)}
            online={d.online}
            onCommand={(action) => command.mutate({ action, channel: c.id })}
            busy={command.isPending}
          />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-700 pt-4">
        {renaming ? (
          <>
            <TextInput value={newName} onChange={(e) => setNewName(e.target.value)} className="max-w-xs" />
            <Button variant="accent" disabled={!newName.trim() || rename.isPending} onClick={() => rename.mutate()}>
              {t('device.save')}
            </Button>
            <Button onClick={() => setRenaming(false)}>{t('device.cancel')}</Button>
          </>
        ) : (
          <Button onClick={() => setRenaming(true)}>{t('device.rename')}</Button>
        )}
        <Button
          disabled={!d.online || command.isPending}
          onClick={() => {
            if (window.confirm(t('device.rebootConfirm', { name: d.name }))) command.mutate({ action: 'reboot', confirm: true })
          }}
        >
          {t('device.reboot')}
        </Button>
        <Button
          variant="danger"
          className="ml-auto"
          disabled={revoke.isPending}
          onClick={() => {
            if (window.confirm(t('device.revokeConfirm', { name: d.name }))) revoke.mutate()
          }}
        >
          {t('device.revoke')}
        </Button>
      </div>
      {lastResult && (
        <p className={`mt-3 text-xs ${lastResult.ok ? 'text-emerald-300' : 'text-warn'}`}>
          {lastResult.ok ? t('command.ok') : t('command.failed')}
          {lastResult.message ? ` — ${lastResult.message}` : ''}
        </p>
      )}
      {(command.isError || rename.isError || revoke.isError) && (
        <div className="mt-3">
          <ErrorBanner message={errMessage(command.error ?? rename.error ?? revoke.error, t('command.error'))} />
        </div>
      )}
    </Card>
  )
}

function ChannelRow({
  app,
  deviceId,
  channel,
  link,
  state,
  online,
  onCommand,
  busy,
}: {
  app: string
  deviceId: string
  channel: { id: string; name?: string }
  link?: Device['channels'][number]
  state?: DeviceChannelStatus
  online: boolean
  onCommand: (a: DeviceAction) => void
  busy: boolean
}) {
  const { t } = useTranslation('devicesTab')
  const qc = useQueryClient()
  const [room, setRoom] = useState(link?.room ?? '')
  const [protocol, setProtocol] = useState<'rtmp' | 'srt'>(link?.protocol === 'srt' ? 'srt' : 'rtmp')
  const [editing, setEditing] = useState(!link)
  const refresh = () => qc.invalidateQueries({ queryKey: ['devices', app] })
  const save = useMutation({
    mutationFn: () => api.devices.linkChannel(app, deviceId, channel.id, { room: room.trim(), protocol, name: channel.name }),
    onSuccess: () => {
      setEditing(false)
      void refresh()
    },
  })
  const unlink = useMutation({ mutationFn: () => api.devices.unlinkChannel(app, deviceId, channel.id), onSuccess: refresh })

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-700/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-fg">#{channel.id}</span>
        {channel.name && <span className="text-xs text-fg-muted">{channel.name}</span>}
        {state?.state && <Badge tone={channelStateTone(state.state)}>{state.state}</Badge>}
        {state?.bitrateKbps != null && <span className="text-xs tabular-nums text-fg-muted">{state.bitrateKbps} kbps</span>}
        {state?.fps != null && <span className="text-xs tabular-nums text-fg-muted">{state.fps} fps</span>}
        {state?.error && <span className="text-xs text-warn">{state.error}</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {(['start', 'stop', 'restart'] as const).map((a) => (
            <Button key={a} disabled={!online || busy || !link} onClick={() => onCommand(a)}>
              {t(`command.${a}`)}
            </Button>
          ))}
        </div>
      </div>

      {editing ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <Field label={t('channels.room')}>
            <TextInput value={room} placeholder="truck-2" onChange={(e) => setRoom(e.target.value)} />
          </Field>
          <Field label={t('channels.protocol')}>
            <Select value={protocol} onChange={(e) => setProtocol(e.target.value === 'srt' ? 'srt' : 'rtmp')}>
              <option value="rtmp">{t('channels.rtmp')}</option>
              <option value="srt">{t('channels.srt')}</option>
            </Select>
          </Field>
          <div className="flex gap-2">
            <Button variant="accent" disabled={!room.trim() || save.isPending} onClick={() => save.mutate()}>
              {t('channels.link')}
            </Button>
            {link && <Button onClick={() => setEditing(false)}>{t('device.cancel')}</Button>}
          </div>
        </div>
      ) : (
        link && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-fg-muted">
              {t('channels.linkedTo', { room: link.room, protocol: link.protocol.toUpperCase() })}
            </p>
            <CopyField label={t('channels.publishUrl')} value={link.publishUrl} />
            <div className="flex gap-2">
              <Button onClick={() => setEditing(true)}>{t('channels.relink')}</Button>
              <Button
                variant="danger"
                disabled={unlink.isPending}
                onClick={() => {
                  if (window.confirm(t('channels.unlinkConfirm'))) unlink.mutate()
                }}
              >
                {t('channels.unlink')}
              </Button>
            </div>
          </div>
        )
      )}
      {(save.isError || unlink.isError) && (
        <div className="mt-2">
          <ErrorBanner message={errMessage(save.error ?? unlink.error, t('channels.error'))} />
        </div>
      )}
    </div>
  )
}
