'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  chipButtonStyle,
  inputStyle,
  panelStyle,
  primaryButtonStyle,
} from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import {
  adminResetPasswordAction,
  changeRoleAction,
  inviteMemberAction,
  revokeInvitationAction,
  setMemberActiveAction,
} from '@/app/actions/members'
import type { InvitationRow, MemberRow, SeatUsage } from '@/server/members'

/**
 * Members and seats.
 *
 * The seat figure shown here is display only. What actually stops an
 * organization exceeding its licence is a database trigger — this panel could
 * be wrong, or tampered with in the browser, and the limit would still hold.
 * That separation is deliberate (MUST DO #16: never trust the client on seats).
 */

const ROLE_HELP: Record<string, string> = {
  owner: 'Everything, including deleting the organization.',
  admin: 'Everything except deleting the organization.',
  finance: 'Invoices, payments, banking, the ledger and reports.',
  sales: 'Customers, deals, quotes and sales orders.',
  readonly: 'Can look at everything, change nothing.',
}

const STATUS_COLOR: Record<string, string> = {
  active: '#0d9488',
  invited: '#b45309',
  deactivated: '#6b7382',
}

export function MembersPanel({
  members,
  invitations,
  seats,
  assignableRoles,
  canInvite,
  canUpdate,
  canDeactivate,
  isOwner,
}: {
  members: MemberRow[]
  invitations: InvitationRow[]
  seats: SeatUsage
  assignableRoles: { key: string; name: string; id: string }[]
  canInvite: boolean
  canUpdate: boolean
  canDeactivate: boolean
  isOwner: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [email, setEmail] = useState('')
  const [roleKey, setRoleKey] = useState('sales')
  const [issued, setIssued] = useState<{
    email: string
    url: string
    expiresAt: string
    emailed: boolean
  } | null>(
    null,
  )
  const [resetIssued, setResetIssued] = useState<
    { membershipId: string; email: string; url: string; expiresAt: string; emailed: boolean } | null
  >(null)

  const full = seats.used >= seats.licensed

  const invite = () => {
    if (!email.trim()) {
      toast('Enter an email address', 'err')
      return
    }
    startTransition(async () => {
      const result = await inviteMemberAction({ email: email.trim(), roleKey })
      if (result.ok && result.data) {
        setIssued(result.data)
        setEmail('')
        router.refresh()
      } else if (!result.ok) {
        toast(result.error, 'err')
      }
    })
  }

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) =>
    startTransition(async () => {
      const result = await fn()
      if (result.ok) {
        toast(success)
        router.refresh()
      } else {
        toast(result.error ?? 'Something went wrong.', 'err')
      }
    })

  const resetPassword = (membershipId: string) =>
    startTransition(async () => {
      const result = await adminResetPasswordAction(membershipId)
      if (result.ok && result.data) {
        setResetIssued({ membershipId, ...result.data })
      } else if (!result.ok) {
        toast(result.error, 'err')
      }
    })

  return (
    <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Members &amp; seats</div>
      <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 16 }}>
        Everyone with access to this organization. Deactivating someone frees their seat and
        keeps their name on everything they created.
      </div>

      <SeatMeter seats={seats} />

      {/* --- invite ------------------------------------------------------ */}
      {canInvite && (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--bd)' }}>
          <div style={{ ...labelStyle, marginBottom: 8 }}>INVITE SOMEONE</div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && invite()}
              style={{ ...inputStyle, flex: 1 }}
            />
            <select
              value={roleKey}
              onChange={(e) => setRoleKey(e.target.value)}
              style={{ ...inputStyle, width: 150 }}
            >
              {assignableRoles
                // Only an owner can create another owner — offering the option
                // to an admin would produce a refusal from the server, which
                // reads as a bug rather than a rule.
                .filter((r) => r.key !== 'owner' || isOwner)
                .map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              onClick={invite}
              disabled={pending || full}
              style={{
                ...primaryButtonStyle,
                fontFamily: 'inherit',
                opacity: pending || full ? 0.5 : 1,
              }}
            >
              Invite
            </button>
          </div>

          <div style={{ color: 'var(--mut)', fontSize: 10.5, marginTop: 6 }}>
            {full
              ? `All ${seats.licensed} seats are in use. Free one or add seats before inviting.`
              : (ROLE_HELP[roleKey] ?? '')}
          </div>

          {issued && <InviteLink issued={issued} onDismiss={() => setIssued(null)} />}
        </div>
      )}

      {/* --- members ----------------------------------------------------- */}
      <div style={{ marginTop: 18 }}>
        <div style={{ ...labelStyle, marginBottom: 8 }}>MEMBERS ({members.length})</div>

        {members.map((m) => (
          <div key={m.membershipId}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 0',
                borderBottom: resetIssued?.membershipId === m.membershipId ? 'none' : '1px solid var(--bd)',
                opacity: m.status === 'deactivated' ? 0.55 : 1,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>
                  {m.name || m.email}
                  {m.isSelf && <span style={{ color: 'var(--mut)', fontWeight: 400 }}> · you</span>}
                </div>
                <div style={{ color: 'var(--mut)', fontSize: 11, marginTop: 1 }}>
                  {m.name ? `${m.email} · ` : ''}
                  {m.lastLoginAt
                    ? `last signed in ${new Date(m.lastLoginAt).toLocaleDateString()}`
                    : 'never signed in'}
                </div>
              </div>

              <Badge color={STATUS_COLOR[m.status] ?? '#6b7382'}>{m.status}</Badge>

              {canUpdate && m.status !== 'deactivated' ? (
                <select
                  value={m.roleKey}
                  disabled={pending || (m.roleKey === 'owner' && !isOwner)}
                  onChange={(e) =>
                    run(
                      () => changeRoleAction(m.membershipId, e.target.value),
                      `${m.name || m.email} is now ${e.target.value}`,
                    )
                  }
                  style={{ ...inputStyle, width: 128, height: 28 }}
                >
                  {assignableRoles
                    .filter((r) => r.key !== 'owner' || isOwner || m.roleKey === 'owner')
                    .map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.name}
                      </option>
                    ))}
                </select>
              ) : (
                <span style={{ fontSize: 11.5, color: 'var(--mut)', width: 128 }}>{m.roleName}</span>
              )}

              {canUpdate && m.status !== 'deactivated' && !m.isSelf && (m.roleKey !== 'owner' || isOwner) && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => resetPassword(m.membershipId)}
                  style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
                >
                  Reset password
                </button>
              )}

              {canDeactivate && !m.isSelf && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => setMemberActiveAction(m.membershipId, m.status === 'deactivated'),
                      m.status === 'deactivated'
                        ? `${m.name || m.email} reactivated`
                        : `${m.name || m.email} deactivated — seat freed`,
                    )
                  }
                  style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
                >
                  {m.status === 'deactivated' ? 'Reactivate' : 'Deactivate'}
                </button>
              )}
            </div>

            {resetIssued?.membershipId === m.membershipId && (
              <div style={{ paddingBottom: 10, borderBottom: '1px solid var(--bd)' }}>
                <InviteLink
                  kind="reset"
                  issued={resetIssued}
                  onDismiss={() => setResetIssued(null)}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* --- pending invitations ----------------------------------------- */}
      {invitations.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ ...labelStyle, marginBottom: 8 }}>
            PENDING INVITATIONS ({invitations.length})
          </div>
          {invitations.map((i) => (
            <div
              key={i.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 0',
                borderBottom: '1px solid var(--bd)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5 }}>{i.email}</div>
                <div style={{ color: 'var(--mut)', fontSize: 11, marginTop: 1 }}>
                  {i.roleName} ·{' '}
                  {i.expired
                    ? 'expired'
                    : `expires ${new Date(i.expiresAt).toLocaleDateString()}`}
                </div>
              </div>
              {i.expired && <Badge color="#b45309">expired</Badge>}
              {canInvite && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(() => revokeInvitationAction(i.id), `Invitation to ${i.email} withdrawn`)
                  }
                  style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
                >
                  Withdraw
                </button>
              )}
            </div>
          ))}
          <div style={{ color: 'var(--mut)', fontSize: 10.5, marginTop: 8 }}>
            A pending invitation does not hold a seat. The seat is taken when it is accepted,
            and acceptance fails if the seats have filled by then.
          </div>
        </div>
      )}
    </section>
  )
}

function SeatMeter({ seats }: { seats: SeatUsage }) {
  const pct = Math.min(100, Math.round((seats.used / Math.max(1, seats.licensed)) * 100))
  const full = seats.used >= seats.licensed
  const expires = seats.validUntil ? new Date(seats.validUntil) : null
  const daysLeft = expires
    ? Math.ceil((expires.getTime() - Date.now()) / 86_400_000)
    : null

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12.5 }}>
          <strong style={{ fontSize: 15 }}>{seats.used}</strong>
          <span style={{ color: 'var(--mut)' }}> of {seats.licensed} seats in use</span>
          {seats.pending > 0 && (
            <span style={{ color: 'var(--mut)' }}> · {seats.pending} invited</span>
          )}
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>
          {/* A trial plan has status "trial" too, and "trial · trial" reads as
              a bug. Only show the status when it says something the plan does
              not — which is exactly when it matters (past_due, suspended). */}
          {seats.plan}
          {seats.status !== seats.plan && ` · ${seats.status.replace(/_/g, ' ')}`}
          {daysLeft !== null && (daysLeft > 0 ? ` · ${daysLeft} days left` : ' · expired')}
        </span>
      </div>

      <div style={{ height: 6, borderRadius: 3, background: 'var(--track)', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: full ? '#b45309' : 'var(--ac)',
            transition: 'width .2s ease',
          }}
        />
      </div>

      {daysLeft !== null && daysLeft <= 7 && (
        <div style={{ color: '#b45309', fontSize: 11, marginTop: 7 }}>
          {daysLeft > 0
            ? `This ${seats.plan} licence expires in ${daysLeft} days.`
            : `This ${seats.plan} licence has expired.`}
        </div>
      )}
    </div>
  )
}

/**
 * The invitation or password-reset link, shown once.
 *
 * Only a hash of the token is stored, so this cannot be recovered afterwards —
 * the same treatment API keys get, and for the same reason. If it is lost, the
 * admin issues another, which supersedes it.
 *
 * The link is shown WHETHER OR NOT the email went out. A send that quietly
 * failed, behind a panel implying it is on its way, is worse than no email at
 * all — so the admin always has something they can paste into a message
 * themselves, which is the whole point on a standalone install with no mail
 * server at all.
 */
function InviteLink({
  kind = 'invite',
  issued,
  onDismiss,
}: {
  kind?: 'invite' | 'reset'
  issued: { email: string; url: string; expiresAt: string; emailed: boolean }
  onDismiss: () => void
}) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access is denied over plain http on some browsers, which is
      // exactly the local-development case. The link is selectable regardless.
      toast('Could not copy — select the link and copy it manually', 'err')
    }
  }

  return (
    <div
      style={{
        marginTop: 12,
        padding: '12px 14px',
        border: '1px solid var(--ac)',
        borderRadius: 8,
        background: 'var(--acs)',
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
        {issued.emailed
          ? `Emailed to ${issued.email}. The link below is the same one — keep it in case the message does not arrive.`
          : kind === 'reset'
            ? `Give this link to ${issued.email} to set a new password`
            : `Send this link to ${issued.email}`}
      </div>
      <div style={{ color: 'var(--mut)', fontSize: 11, marginBottom: 9, lineHeight: 1.5 }}>
        It is shown once and cannot be retrieved again — only a hash is stored. Valid until{' '}
        {new Date(issued.expiresAt).toLocaleString()}.{' '}
        {kind === 'reset'
          ? `Anyone holding it can set a new password for ${issued.email}`
          : `Anyone holding it can join as ${issued.email}`}
        , so send it the way you would send a password.
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          readOnly
          value={issued.url}
          onFocus={(e) => e.currentTarget.select()}
          style={{ ...inputStyle, flex: 1, fontFamily: 'var(--font-mono), monospace', fontSize: 11 }}
        />
        <button type="button" onClick={copy} style={{ ...primaryButtonStyle, fontFamily: 'inherit' }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={onDismiss} style={{ ...chipButtonStyle, fontFamily: 'inherit' }}>
          Done
        </button>
      </div>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  font: '500 9.5px var(--font-mono), monospace',
  letterSpacing: '.07em',
  color: 'var(--mut)',
}
