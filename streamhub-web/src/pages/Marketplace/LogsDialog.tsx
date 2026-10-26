/**
 * Plugin logs dialog — the modal wrapper around the shared `PluginLogsView`
 * body (which reads GET /plugins/:id/logs, newest first). Non-blocking: a
 * missing backend just shows the empty/error state.
 */
import { useTranslation } from 'react-i18next'
import type { PluginView } from '@/plugins'
import { Modal } from './Modal'
import { PluginLogsView } from './PluginLogsView'

export function LogsDialog({
  app,
  view,
  onClose,
}: {
  app: string
  view: PluginView
  onClose: () => void
}) {
  const { t } = useTranslation('marketplace')
  return (
    <Modal title={t('logs.title', { name: view.name })} onClose={onClose} wide>
      <PluginLogsView app={app} view={view} />
    </Modal>
  )
}
