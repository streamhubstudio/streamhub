/**
 * Team invitations ("Mi cuenta" → Perfil): since 3.3.4 an owner can't attach
 * an existing account to their team — the account gets a pending invitation
 * and answers it here.
 *
 *  - GET /account/invitations lists them (team, role, who invited).
 *  - POST /account/invitations/:tenantId/accept|decline answers one.
 *    Accepting does NOT move this session to that team.
 *
 * Renders nothing when there is no pending invitation.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import { formatDateTime } from '@/lib/datetime'
import {
  Button,
  Card,
  ErrorBanner,
  RoleBadge,
  SectionTitle,
  errMessage,
} from './ui'

export function InvitationsCard() {
  const { t } = useTranslation('account')
  const qc = useQueryClient()

  const invitations = useQuery({
    queryKey: ['account-invitations'],
    queryFn: ({ signal }) => api.account.invitations(signal),
  })

  const answer = useMutation({
    mutationFn: (v: { tenantId: string; answer: 'accept' | 'decline' }) =>
      api.account.answerInvitation(v.tenantId, v.answer),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['account-invitations'] })
    },
  })

  const list = invitations.data ?? []
  if (list.length === 0 && !answer.isError) return null

  return (
    <Card>
      <SectionTitle
        title={t('invitations.title')}
        subtitle={t('invitations.subtitle')}
      />
      <ul className="divide-y divide-gray-700">
        {list.map((inv) => (
          <li
            key={inv.tenantId}
            className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-fg">{inv.tenantName}</span>
                <RoleBadge role={inv.role} />
              </div>
              <div className="mt-0.5 text-xs text-slate-400">
                {inv.invitedBy
                  ? t('invitations.invitedBy', { email: inv.invitedBy })
                  : t('invitations.invited')}{' '}
                · {formatDateTime(inv.createdAt)}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="accent"
                disabled={answer.isPending}
                onClick={() =>
                  answer.mutate({ tenantId: inv.tenantId, answer: 'accept' })
                }
              >
                {t('invitations.accept')}
              </Button>
              <Button
                variant="danger"
                disabled={answer.isPending}
                onClick={() =>
                  answer.mutate({ tenantId: inv.tenantId, answer: 'decline' })
                }
              >
                {t('invitations.decline')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {answer.isError && (
        <div className="mt-3">
          <ErrorBanner
            message={errMessage(answer.error, t('invitations.answerError'))}
          />
        </div>
      )}
    </Card>
  )
}
