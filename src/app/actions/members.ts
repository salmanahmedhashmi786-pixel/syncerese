'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { auth } from '@/auth'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { getSession } from '@/server/session'
import { sendEmail } from '@/email/send'
import { invitationEmail, passwordResetEmail } from '@/email/templates'
import { TOKEN_TTL_MINUTES } from '@/auth/password-reset'
import { AppError } from '@/lib/errors'
import {
  acceptInvitation,
  adminResetPassword,
  changeRole,
  inviteMember,
  invitationUrl,
  resetPasswordUrl,
  revokeInvitation,
  setMemberActive,
} from '@/server/members'

/**
 * Member management.
 *
 * Thin, like every other action module: re-resolve the session, then hand off
 * to the service, which checks the permission. A server action is a public HTTP
 * endpoint — "only our settings page calls this" is not access control.
 */

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

const fail = (err: unknown): Result<never> => {
  if (err instanceof AppError) return { ok: false, error: err.message }
  console.error('[members]', err)
  return { ok: false, error: 'Something went wrong.' }
}

async function tenant(fn: Parameters<typeof withTenant<void>>[2]): Promise<Result> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  try {
    const handle = await db()
    await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      fn,
    )
    revalidatePath('/settings')
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

export async function inviteMemberAction(input: {
  email: string
  roleKey: string
}): Promise<Result<{ email: string; url: string; expiresAt: string; emailed: boolean }>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    const handle = await db()
    const invite = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx) => inviteMember(tx, ctx, input),
    )
    revalidatePath('/settings')

    // The token is returned to the CALLER exactly once and never stored in
    // plaintext, so the link has to be built here, at the moment it exists.
    const url = invitationUrl(await origin(), invite.token)

    // Sent if a mail server is configured, and the link is returned EITHER WAY.
    // A send that failed silently, with the panel implying the invitation is on
    // its way, is worse than no email at all — so the admin always gets
    // something they can paste into a message themselves.
    const { organizations } = await getSession()
    const organizationName =
      organizations.find((o) => o.organizationId === ctx.organizationId)?.organizationName ?? ''
    // No inviter name: `RequestContext` carries the user id, not the display
    // name, and fetching one purely to personalise a subject line is not worth
    // the query. The template reads fine without it.
    const delivery = await sendEmail(invitationEmail(invite.email, url, organizationName, null))

    return {
      ok: true,
      data: {
        email: invite.email,
        url,
        expiresAt: invite.expiresAt,
        emailed: delivery.sent,
      },
    }
  } catch (err) {
    return fail(err)
  }
}

export async function revokeInvitationAction(invitationId: string): Promise<Result> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  return tenant((tx) => revokeInvitation(tx, ctx, invitationId))
}

export async function changeRoleAction(membershipId: string, roleKey: string): Promise<Result> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  return tenant((tx) => changeRole(tx, ctx, membershipId, roleKey))
}

export async function setMemberActiveAction(
  membershipId: string,
  active: boolean,
): Promise<Result> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  return tenant((tx) => setMemberActive(tx, ctx, membershipId, active))
}

/**
 * Resets a member's password and returns the link, whether or not the email
 * actually went out — same reasoning as inviteMemberAction: a send that
 * failed silently, behind a panel implying it is on its way, is worse than no
 * email at all.
 */
export async function adminResetPasswordAction(
  membershipId: string,
): Promise<Result<{ email: string; url: string; expiresAt: string; emailed: boolean }>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    const handle = await db()
    const issued = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx) => adminResetPassword(tx, ctx, membershipId),
    )
    revalidatePath('/settings')

    const url = resetPasswordUrl(await origin(), issued.token)
    const delivery = await sendEmail(passwordResetEmail(issued.email, url, TOKEN_TTL_MINUTES))

    return {
      ok: true,
      data: { email: issued.email, url, expiresAt: issued.expiresAt, emailed: delivery.sent },
    }
  } catch (err) {
    return fail(err)
  }
}

/**
 * Accept an invitation.
 *
 * Deliberately NOT wrapped in the session guard above: the whole point is that
 * the caller may have no account yet. The service decides — an invitation for
 * an address that already has an account is refused unless the caller is signed
 * in as exactly that user.
 */
export async function acceptInvitationAction(input: {
  token: string
  name?: string
  password?: string
}): Promise<Result<{ created: boolean; organizationId: string }>> {
  try {
    // `auth()` rather than `getSession()`: getSession resolves a TENANT context
    // and returns null when the caller has no active membership anywhere. That
    // is exactly the person accepting an invitation after being removed from
    // their only previous organization — they are signed in, and getSession
    // would report them as anonymous, so the existing-account branch would
    // refuse them.
    const session = await auth()
    const handle = await db()
    const result = await acceptInvitation(handle, input, session?.user?.id ?? null)
    return {
      ok: true,
      data: { created: result.created, organizationId: result.organizationId },
    }
  } catch (err) {
    return fail(err)
  }
}

/** The origin this request arrived on, so an invitation link points back at the
 *  deployment the admin is actually using rather than a hard-coded host. */
async function origin(): Promise<string> {
  const h = await headers()
  const configured = process.env.AUTH_URL
  if (configured) return configured
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}
