import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { invitations, memberships, roles, users } from '@/db/schema'
import type { AnyDb, TenantTx } from '@/db/tenant'
import { withoutTenantScope, withTenant } from '@/db/tenant'
import { AppError, forbidden, fromDatabaseError, notFound } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { generateToken, hashOpaqueToken, hashPassword } from '@/auth/password'
import { hashToken as hashResetToken, TOKEN_TTL_MINUTES as RESET_TTL_MINUTES } from '@/auth/password-reset'
import { ROLE_KEYS, type RoleKey } from '@/auth/permissions'
import type { RequestContext } from './context'
import { requirePermission } from './context'

/**
 * Members, roles and seats.
 *
 * A tenant is not a single-user system: the owner signs up, then brings their
 * bookkeeper and their salesperson. Everything here exists to make that
 * possible without ever letting an organization exceed the seats it pays for,
 * or letting one tenant's admin see another's people.
 *
 * The seat limit itself is NOT enforced here. It is a database trigger
 * (`enforce_seat_limit`), because service code can be bypassed by a new code
 * path, a bulk import or a direct API call, and because the count must be true
 * for the whole tenant regardless of who is asking. This module does an
 * advisory pre-check so the UI can say "no seats left" before sending an
 * invitation nobody can accept — that check is a courtesy, not a control.
 */

/** How long an invitation link stays usable. Long enough to survive a weekend
 *  and a holiday; short enough that a forwarded email does not stay live for a
 *  year. */
const INVITE_TTL_DAYS = 14

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type MemberRow = {
  membershipId: string
  userId: string
  email: string
  name: string | null
  roleKey: RoleKey
  roleName: string
  status: 'active' | 'invited' | 'deactivated'
  joinedAt: string
  lastLoginAt: string | null
  isSelf: boolean
}

export type InvitationRow = {
  id: string
  email: string
  roleKey: RoleKey
  roleName: string
  expiresAt: string
  createdAt: string
  expired: boolean
}

export type SeatUsage = {
  used: number
  licensed: number
  /** Sent, unaccepted and unexpired. These do not hold a seat — the seat is
   *  taken on acceptance — but an admin needs to see them coming. */
  pending: number
  plan: string
  status: string
  validUntil: string | null
}

export type MembersView = {
  members: MemberRow[]
  invitations: InvitationRow[]
  seats: SeatUsage
  assignableRoles: { key: RoleKey; name: string; id: string }[]
}

export async function listMembers(tx: TenantTx, ctx: RequestContext): Promise<MembersView> {
  requirePermission(ctx, 'member.read')

  const memberRows = await tx
    .select({
      membershipId: memberships.id,
      userId: users.id,
      email: users.email,
      name: users.name,
      roleKey: roles.key,
      roleName: roles.name,
      status: memberships.status,
      joinedAt: memberships.joinedAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(eq(memberships.organizationId, ctx.organizationId))
    .orderBy(memberships.status, users.email)

  const inviteRows = await tx
    .select({
      id: invitations.id,
      email: invitations.email,
      roleKey: roles.key,
      roleName: roles.name,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .innerJoin(roles, eq(roles.id, invitations.roleId))
    .where(
      and(
        eq(invitations.organizationId, ctx.organizationId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .orderBy(invitations.createdAt)

  const seats = await seatUsage(tx, ctx.organizationId)

  const assignable = await tx
    .select({ id: roles.id, key: roles.key, name: roles.name })
    .from(roles)
    .where(isNull(roles.organizationId))
    .orderBy(roles.key)

  const now = Date.now()

  return {
    members: memberRows.map((m) => ({
      membershipId: m.membershipId,
      userId: m.userId,
      email: m.email,
      name: m.name,
      roleKey: m.roleKey as RoleKey,
      roleName: m.roleName,
      status: m.status as MemberRow['status'],
      joinedAt: m.joinedAt.toISOString(),
      lastLoginAt: m.lastLoginAt ? m.lastLoginAt.toISOString() : null,
      isSelf: m.userId === ctx.userId,
    })),
    invitations: inviteRows.map((i) => ({
      id: i.id,
      email: i.email,
      roleKey: i.roleKey as RoleKey,
      roleName: i.roleName,
      expiresAt: i.expiresAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
      expired: i.expiresAt.getTime() < now,
    })),
    seats,
    // Ordered by privilege — owner, admin, finance, sales, readonly — not
    // alphabetically. A role picker is read as a ladder, and "Admin, Finance,
    // Owner, Readonly, Sales" makes the person choosing hunt for the one that
    // grants the least.
    assignableRoles: assignable
      .filter((r) => (ROLE_KEYS as readonly string[]).includes(r.key))
      .map((r) => ({ id: r.id, key: r.key as RoleKey, name: r.name }))
      .sort((a, b) => ROLE_KEYS.indexOf(a.key) - ROLE_KEYS.indexOf(b.key)),
  }
}

async function seatUsage(tx: TenantTx, organizationId: string): Promise<SeatUsage> {
  const res = await tx.execute(sql`
    select
      (select count(*)::int from memberships
        where organization_id = ${organizationId} and status = 'active')      as used,
      (select count(*)::int from invitations
        where organization_id = ${organizationId}
          and accepted_at is null and revoked_at is null
          and expires_at > now())                                            as pending,
      l.seat_count::int as licensed,
      l.plan            as plan,
      l.status          as status,
      l.valid_until     as valid_until
    from licenses l
    where l.organization_id = ${organizationId}
    limit 1
  `)
  const row = (
    res as unknown as {
      rows: {
        used: number
        pending: number
        licensed: number
        plan: string
        status: string
        valid_until: string | Date | null
      }[]
    }
  ).rows[0]

  if (!row) {
    // The licence row is created at signup and is the seat trigger's source of
    // truth. Its absence means this tenant was provisioned wrong, and the seat
    // limit is currently refusing every new member with SYNC_NO_LICENSE.
    throw new AppError(
      'NO_LICENSE',
      'This organization has no licence record. Nobody can be added until that is fixed.',
    )
  }

  return {
    used: row.used,
    pending: row.pending,
    licensed: row.licensed,
    plan: row.plan,
    status: row.status,
    validUntil: row.valid_until ? new Date(row.valid_until).toISOString() : null,
  }
}

// ---------------------------------------------------------------------------
// Inviting
// ---------------------------------------------------------------------------

export const inviteSchema = z.object({
  email: z.string().email().max(320),
  roleKey: z.enum(ROLE_KEYS),
})

export type InviteResult = {
  invitationId: string
  email: string
  /** The plaintext token, returned EXACTLY ONCE. Only its hash is stored, so
   *  this cannot be shown again — the same treatment API keys get. */
  token: string
  expiresAt: string
}

export async function inviteMember(
  tx: TenantTx,
  ctx: RequestContext,
  input: unknown,
): Promise<InviteResult> {
  requirePermission(ctx, 'member.invite')

  const parsed = inviteSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Enter a valid email and pick a role', parsed.error.issues)
  }
  const email = parsed.data.email.toLowerCase()

  // Only an owner may create another owner. Otherwise an admin could invite an
  // owner and, through them, acquire the one permission admins lack
  // (`org.delete`) — a privilege escalation two steps long.
  if (parsed.data.roleKey === 'owner' && ctx.role !== 'owner') {
    throw forbidden('Only an owner can invite another owner.')
  }

  const role = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.key, parsed.data.roleKey), isNull(roles.organizationId)))
    .limit(1)
  const roleId = role[0]?.id
  if (!roleId) throw new AppError('INTERNAL', 'System roles are missing.')

  // Already in this organization? An invitation would be accepted into a
  // membership that already exists.
  const existing = await tx
    .select({ status: memberships.status })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, ctx.organizationId), eq(users.email, email)))
    .limit(1)

  if (existing[0]) {
    throw new AppError(
      'CONFLICT',
      existing[0].status === 'active'
        ? 'That person is already a member.'
        : 'That person is already listed here — reactivate them instead of inviting them again.',
    )
  }

  const seats = await seatUsage(tx, ctx.organizationId)
  if (seats.used >= seats.licensed) {
    // Advisory. The trigger is what actually holds the line at acceptance time,
    // when seats may have filled anyway — but sending an invitation that cannot
    // be accepted wastes the recipient's time and looks broken.
    throw new AppError(
      'SEAT_LIMIT_REACHED',
      `All ${seats.licensed} seats are in use. Free a seat or add more before inviting anyone.`,
      { used: seats.used, licensed: seats.licensed },
    )
  }

  // Superseding rather than colliding: the partial unique index allows only one
  // live invitation per address, and re-inviting somebody is a normal thing to
  // do when the first link went to a typo'd address or got lost.
  await tx
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invitations.organizationId, ctx.organizationId),
        eq(invitations.email, email),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )

  const token = generateToken(32)
  const invitationId = newId()
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000)

  await tx.insert(invitations).values({
    id: invitationId,
    organizationId: ctx.organizationId,
    email,
    roleId,
    tokenHash: hashOpaqueToken(token),
    expiresAt,
    invitedBy: ctx.userId,
  })

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'member.invited',
    entityType: 'invitation',
    entityId: invitationId,
    // The token is deliberately absent. An audit log that records credentials
    // turns a log reader into an account.
    after: { email, role: parsed.data.roleKey, expiresAt: expiresAt.toISOString() },
    requestId: ctx.requestId,
  })

  return { invitationId, email, token, expiresAt: expiresAt.toISOString() }
}

export async function revokeInvitation(
  tx: TenantTx,
  ctx: RequestContext,
  invitationId: string,
): Promise<void> {
  requirePermission(ctx, 'member.invite')

  const updated = await tx
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.organizationId, ctx.organizationId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .returning({ email: invitations.email })

  if (!updated[0]) throw notFound('That invitation is no longer open.')

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'member.invitation_revoked',
    entityType: 'invitation',
    entityId: invitationId,
    before: { email: updated[0].email },
    requestId: ctx.requestId,
  })
}

// ---------------------------------------------------------------------------
// Changing a member
// ---------------------------------------------------------------------------

export async function changeRole(
  tx: TenantTx,
  ctx: RequestContext,
  membershipId: string,
  roleKey: string,
): Promise<void> {
  requirePermission(ctx, 'member.update')

  if (!(ROLE_KEYS as readonly string[]).includes(roleKey)) {
    throw new AppError('VALIDATION_FAILED', 'Unknown role.')
  }
  if (roleKey === 'owner' && ctx.role !== 'owner') {
    throw forbidden('Only an owner can make someone else an owner.')
  }

  const current = await memberOf(tx, ctx.organizationId, membershipId)

  // An admin demoting an owner would be taking control of the organization from
  // the person who owns it. The last-owner trigger stops the tenant becoming
  // ownerless; this stops a sideways power grab that leaves an owner in place.
  if (current.roleKey === 'owner' && ctx.role !== 'owner') {
    throw forbidden('Only an owner can change another owner’s role.')
  }

  const role = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.key, roleKey), isNull(roles.organizationId)))
    .limit(1)
  const roleId = role[0]?.id
  if (!roleId) throw new AppError('INTERNAL', 'System roles are missing.')

  try {
    await tx.update(memberships).set({ roleId }).where(eq(memberships.id, membershipId))
  } catch (err) {
    throw fromDatabaseError(err) ?? err
  }

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'member.role_changed',
    entityType: 'membership',
    entityId: membershipId,
    before: { role: current.roleKey, email: current.email },
    after: { role: roleKey, email: current.email },
    requestId: ctx.requestId,
  })
}

export async function setMemberActive(
  tx: TenantTx,
  ctx: RequestContext,
  membershipId: string,
  active: boolean,
): Promise<void> {
  requirePermission(ctx, 'member.deactivate')

  const current = await memberOf(tx, ctx.organizationId, membershipId)

  if (current.userId === ctx.userId && !active) {
    // Not a security control — the last-owner trigger is. This is to stop
    // somebody locking themselves out with one click and then needing support
    // to get back in.
    throw new AppError('CONFLICT', 'You cannot deactivate your own account here.')
  }
  if (current.roleKey === 'owner' && ctx.role !== 'owner') {
    throw forbidden('Only an owner can deactivate another owner.')
  }

  try {
    await tx
      .update(memberships)
      .set(
        active
          ? { status: 'active', deactivatedAt: null, deactivatedBy: null }
          : { status: 'deactivated', deactivatedAt: new Date(), deactivatedBy: ctx.userId },
      )
      .where(eq(memberships.id, membershipId))
  } catch (err) {
    // Reactivation runs through the seat trigger, so this is where "you are
    // full" arrives when someone tries to bring an ex-employee back.
    throw fromDatabaseError(err) ?? err
  }

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: active ? 'member.reactivated' : 'member.deactivated',
    entityType: 'membership',
    entityId: membershipId,
    before: { status: current.status, email: current.email },
    after: { status: active ? 'active' : 'deactivated', email: current.email },
    requestId: ctx.requestId,
  })
}

export type PasswordResetIssued = {
  email: string
  /** The plaintext token, returned EXACTLY ONCE — same treatment invitations
   *  and API keys get, and for the same reason: only its hash is stored. */
  token: string
  expiresAt: string
}

/**
 * Issues a password reset for another member, for an owner or admin to hand
 * over directly.
 *
 * WHY THIS EXISTS: the self-service flow at /forgot-password needs a mail
 * server, and the standalone desktop install has none — SMTP is simply not
 * configurable offline. Without this, a forgotten password there is a dead
 * end with no support line to call. An administrator who can already see this
 * person's name in this list can reset their password and read them the link
 * face to face, the same way an invitation link is handed over today.
 *
 * This is not desktop-only. A hosted admin locked out of SMTP, or one who
 * would simply rather not wait on an email, gets the same escape hatch.
 *
 * Shares `password_reset_tokens` with the self-service flow — same table,
 * same hash, same TTL — so `completeReset` cannot tell the two apart and
 * needs no changes to accept either.
 */
export async function adminResetPassword(
  tx: TenantTx,
  ctx: RequestContext,
  membershipId: string,
): Promise<PasswordResetIssued> {
  requirePermission(ctx, 'member.update')

  const current = await memberOf(tx, ctx.organizationId, membershipId)

  // Same rule changeRole applies to a role change: an admin resetting an
  // owner's password is a route to their account that a plain role change
  // already refuses.
  if (current.roleKey === 'owner' && ctx.role !== 'owner') {
    throw forbidden('Only an owner can reset another owner’s password.')
  }

  const token = generateToken(32)
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000)

  // Through the function, not an INSERT — the application role has no
  // privilege on password_reset_tokens at all, matching the self-service path
  // in src/auth/password-reset.ts. No ipHash: this was not triggered by a
  // request from the recipient's network, so there is nothing to rate-limit.
  await tx.execute(sql`
    select public.issue_password_reset(
      ${newId()}::uuid, ${current.userId}::uuid, ${hashResetToken(token)}, null
    )
  `)

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'member.password_reset_issued',
    entityType: 'membership',
    entityId: membershipId,
    // The token is deliberately absent — see member.invited above.
    after: { email: current.email },
    requestId: ctx.requestId,
  })

  return { email: current.email, token, expiresAt: expiresAt.toISOString() }
}

/** Builds the link an admin hands over. Mirrors invitationUrl above — same
 *  reasoning: the origin this request arrived on, never a hard-coded host. */
export function resetPasswordUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`
}

async function memberOf(tx: TenantTx, organizationId: string, membershipId: string) {
  const rows = await tx
    .select({
      userId: memberships.userId,
      status: memberships.status,
      roleKey: roles.key,
      email: users.email,
    })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)))
    .limit(1)

  const row = rows[0]
  // The organization_id predicate is belt-and-braces over RLS: a membership id
  // from another tenant is invisible anyway, and this makes that explicit
  // rather than relying on it.
  if (!row) throw notFound('That member no longer exists.')
  return row
}

// ---------------------------------------------------------------------------
// Accepting — the pre-tenant half
// ---------------------------------------------------------------------------

export type ResolvedInvitation = {
  invitationId: string
  organizationId: string
  organizationName: string
  email: string
  roleId: string
  roleKey: string
  roleName: string
  /** Set when the link cannot be used, with the reason already phrased for a
   *  human. Null means it is good. */
  problem: string | null
  /** Whether an account already exists for the invited address, which decides
   *  whether the recipient sets a password or signs in. */
  userExists: boolean
}

/**
 * Looks an invitation up by its token.
 *
 * Pre-tenant: there is no `app.org_id` yet — resolving which organization this
 * is IS the question — so it goes through the `resolve_invitation` SECURITY
 * DEFINER function rather than a direct query, which RLS would filter to
 * nothing.
 */
export async function resolveInvitation(
  db: AnyDb,
  token: string,
): Promise<ResolvedInvitation | null> {
  if (!token) return null

  const res = await withoutTenantScope(db, (tx) =>
    tx.execute(sql`select * from public.resolve_invitation(${hashOpaqueToken(token)})`),
  )
  const row = (
    res as unknown as {
      rows: {
        invitation_id: string
        organization_id: string
        organization_name: string
        email: string
        role_id: string
        role_key: string
        role_name: string
        expired: boolean
        accepted: boolean
        revoked: boolean
        user_exists: boolean
      }[]
    }
  ).rows[0]

  // No such token. Deliberately indistinguishable from a revoked one to anybody
  // guessing: both render the same "this link is not valid" screen.
  if (!row) return null

  const problem = row.revoked
    ? 'This invitation was withdrawn.'
    : row.accepted
      ? 'This invitation has already been used.'
      : row.expired
        ? 'This invitation has expired. Ask for a new one.'
        : null

  return {
    invitationId: row.invitation_id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    email: row.email,
    roleId: row.role_id,
    roleKey: row.role_key,
    roleName: row.role_name,
    problem,
    userExists: row.user_exists,
  }
}

export const acceptSchema = z.object({
  token: z.string().min(10).max(512),
  /** Required only when the invited address has no account yet. */
  name: z.string().min(2).max(120).optional(),
  password: z.string().min(12).max(1024).optional(),
})

export type AcceptResult = {
  organizationId: string
  organizationSlug: string
  userId: string
  /** True when this call created the account, so the caller knows it can sign
   *  the person straight in with the credentials it just took. */
  created: boolean
}

/**
 * Accepts an invitation.
 *
 * Two shapes, and both end in exactly one membership:
 *
 *  - the invited address has no account — create the user and the membership
 *    together, in one transaction;
 *  - it already has one — the caller must already be signed in AS that user,
 *    and only the membership is created.
 *
 * `signedInUserId` is what makes the second case safe. Without it, holding a
 * token for someone else's address would be enough to join a tenant as them.
 */
export async function acceptInvitation(
  db: AnyDb,
  input: unknown,
  signedInUserId?: string | null,
): Promise<AcceptResult> {
  const parsed = acceptSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Check the form and try again', parsed.error.issues)
  }

  const invite = await resolveInvitation(db, parsed.data.token)
  if (!invite) throw notFound('This invitation link is not valid.')
  if (invite.problem) throw new AppError('CONFLICT', invite.problem)

  // Who this is going to become a member. Resolved from the invited ADDRESS,
  // never from anything the caller supplies.
  const existingUser = await withoutTenantScope(db, async (tx) => {
    const rows = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.email, invite.email))
      .limit(1)
    return rows[0]
  })

  if (existingUser) {
    if (!signedInUserId || signedInUserId !== existingUser.id) {
      throw new AppError(
        'UNAUTHENTICATED',
        `This invitation is for ${invite.email}. Sign in with that account to accept it.`,
      )
    }
    if (existingUser.status !== 'active') {
      throw forbidden('That account is deactivated.')
    }
  } else if (!parsed.data.name || !parsed.data.password) {
    throw new AppError('VALIDATION_FAILED', 'Enter your name and choose a password.')
  }

  const userId = existingUser?.id ?? newId()
  const created = !existingUser
  const passwordHash = created ? await hashPassword(parsed.data.password!) : null

  const slug = await withTenant(
    db,
    { organizationId: invite.organizationId, userId },
    async (tx) => {
      if (created) {
        await tx.insert(users).values({
          id: userId,
          email: invite.email,
          name: parsed.data.name!.trim(),
          passwordHash,
          status: 'active',
        })
      }

      // Claiming the invitation BEFORE creating the membership, and only if it
      // is still open. Two clicks on the same link race here; the second
      // updates zero rows and is refused rather than producing a second
      // membership or, worse, silently consuming two seats.
      const claimed = await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(invitations.id, invite.invitationId),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ id: invitations.id })

      if (!claimed[0]) throw new AppError('CONFLICT', 'This invitation has already been used.')

      try {
        await tx.insert(memberships).values({
          id: newId(),
          organizationId: invite.organizationId,
          userId,
          roleId: invite.roleId,
          status: 'active',
        })
      } catch (err) {
        // Seats can fill between sending and accepting — that is exactly why
        // the limit is a trigger and not just the pre-check at invite time.
        throw fromDatabaseError(err) ?? err
      }

      await writeAudit(tx, {
        organizationId: invite.organizationId,
        actorUserId: userId,
        action: 'member.joined',
        entityType: 'membership',
        entityId: invite.invitationId,
        after: { email: invite.email, role: invite.roleKey, createdAccount: created },
      })

      const org = await tx.execute(
        sql`select slug from organizations where id = ${invite.organizationId}`,
      )
      return (org as unknown as { rows: { slug: string }[] }).rows[0]?.slug ?? ''
    },
  )

  return { organizationId: invite.organizationId, organizationSlug: slug, userId, created }
}

/** Builds the link an admin sends. Same origin the app is served from — a
 *  hard-coded host would send half the customers to the wrong deployment. */
export function invitationUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/invite/${encodeURIComponent(token)}`
}
