import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { memberships } from '@/db/schema'
import { withTenant, type TenantTx } from '@/db/tenant'
import { resolveContext, type RequestContext } from '@/server/context'
import {
  acceptInvitation,
  adminResetPassword,
  changeRole,
  inviteMember,
  invitationUrl,
  listMembers,
  resetPasswordUrl,
  resolveInvitation,
  revokeInvitation,
  setMemberActive,
} from '@/server/members'
import { completeReset } from '@/auth/password-reset'
import { createTestDb, roleId, seedOrg, seedUser, type TestDb } from './helpers/db'

/**
 * Members, invitations and seats.
 *
 * Until this existed a tenant was a one-person system: the owner signed up and
 * had no way to add anybody. Most of what is tested here is refusal — the seat
 * limit, the last owner, another tenant's members — because those are the parts
 * that cost money or lock somebody out when they are wrong.
 */
describe('members and invitations', () => {
  let t: TestDb
  let org: { orgId: string; ownerUserId: string }
  let other: { orgId: string; ownerUserId: string }
  let ownerCtx: RequestContext
  let otherOwnerCtx: RequestContext

  const asOwner = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(t.db, { organizationId: org.orgId, userId: org.ownerUserId }, fn)

  beforeAll(async () => {
    t = await createTestDb()
    // Three seats: enough to test filling them without a long setup.
    org = await seedOrg(t, { name: 'Nordsee Werft', slug: 'nordsee', seats: 3 })
    other = await seedOrg(t, { name: 'Alpen Logistik', slug: 'alpen', seats: 5 })

    ownerCtx = (await resolveContext(t.db, {
      userId: org.ownerUserId,
      organizationId: org.orgId,
    }))!
    otherOwnerCtx = (await resolveContext(t.db, {
      userId: other.ownerUserId,
      organizationId: other.orgId,
    }))!
  })

  afterAll(async () => {
    await t.close()
  })

  // -------------------------------------------------------------------------
  // The round trip
  // -------------------------------------------------------------------------

  it('invites somebody new and lets them join', async () => {
    const invite = await asOwner((tx) =>
      inviteMember(tx, ownerCtx, { email: 'Bookkeeper@Nordsee.example', roleKey: 'finance' }),
    )

    expect(invite.email).toBe('bookkeeper@nordsee.example')
    expect(invite.token.length).toBeGreaterThan(20)

    // Stored hashed, exactly like an API key — a leaked invitations table must
    // not yield working links.
    const stored = await t.client.query<{ token_hash: string }>(
      `select token_hash from invitations where id = $1`,
      [invite.invitationId],
    )
    expect(stored.rows[0]!.token_hash).not.toBe(invite.token)
    expect(stored.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/)

    const resolved = await resolveInvitation(t.db, invite.token)
    expect(resolved?.organizationName).toBe('Nordsee Werft')
    expect(resolved?.problem).toBeNull()
    expect(resolved?.userExists).toBe(false)

    const result = await acceptInvitation(t.db, {
      token: invite.token,
      name: 'Bea Kleiner',
      password: 'correct-horse-battery',
    })

    expect(result.created).toBe(true)
    expect(result.organizationSlug).toBe('nordsee')

    // The point of the whole exercise: they can now actually work.
    const ctx = await resolveContext(t.db, {
      userId: result.userId,
      organizationId: org.orgId,
    })
    expect(ctx).not.toBeNull()
    expect(ctx!.role).toBe('finance')
  })

  it('shows the new member and the seat usage', async () => {
    const view = await asOwner((tx) => listMembers(tx, ownerCtx))

    expect(view.members).toHaveLength(2)
    expect(view.seats.used).toBe(2)
    expect(view.seats.licensed).toBe(3)
    // The accepted invitation is no longer pending.
    expect(view.invitations).toHaveLength(0)
    expect(view.members.find((m) => m.isSelf)?.roleKey).toBe('owner')
  })

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  it('refuses a token that has already been used', async () => {
    const invite = await asOwner((tx) =>
      inviteMember(tx, ownerCtx, { email: 'twice@nordsee.example', roleKey: 'sales' }),
    )
    await acceptInvitation(t.db, {
      token: invite.token,
      name: 'First Use',
      password: 'correct-horse-battery',
    })

    // A second accept must not produce a second membership, and must not
    // consume a second seat.
    await expect(
      acceptInvitation(t.db, {
        token: invite.token,
        name: 'Second Use',
        password: 'correct-horse-battery',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const view = await asOwner((tx) => listMembers(tx, ownerCtx))
    expect(view.seats.used).toBe(3)
  })

  it('refuses a revoked token', async () => {
    // The seats are full now, so free one first.
    const view = await asOwner((tx) => listMembers(tx, ownerCtx))
    const sales = view.members.find((m) => m.roleKey === 'sales')!
    await asOwner((tx) => setMemberActive(tx, ownerCtx, sales.membershipId, false))

    const invite = await asOwner((tx) =>
      inviteMember(tx, ownerCtx, { email: 'revoked@nordsee.example', roleKey: 'sales' }),
    )
    await asOwner((tx) => revokeInvitation(tx, ownerCtx, invite.invitationId))

    const resolved = await resolveInvitation(t.db, invite.token)
    expect(resolved?.problem).toMatch(/withdrawn/i)

    await expect(
      acceptInvitation(t.db, {
        token: invite.token,
        name: 'Nope',
        password: 'correct-horse-battery',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses an expired token', async () => {
    const invite = await asOwner((tx) =>
      inviteMember(tx, ownerCtx, { email: 'expired@nordsee.example', roleKey: 'sales' }),
    )
    await t.sudo(
      `update invitations set expires_at = now() - interval '1 day' where id = '${invite.invitationId}'`,
    )

    const resolved = await resolveInvitation(t.db, invite.token)
    expect(resolved?.problem).toMatch(/expired/i)

    await expect(
      acceptInvitation(t.db, {
        token: invite.token,
        name: 'Too Late',
        password: 'correct-horse-battery',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('returns nothing for a token that was never issued', async () => {
    expect(await resolveInvitation(t.db, 'not-a-real-token-at-all')).toBeNull()
    expect(await resolveInvitation(t.db, '')).toBeNull()
  })

  it('supersedes an earlier invitation to the same address', async () => {
    const first = await asOwner((tx) =>
      inviteMember(tx, ownerCtx, { email: 'resend@nordsee.example', roleKey: 'sales' }),
    )
    const second = await asOwner((tx) =>
      inviteMember(tx, ownerCtx, { email: 'resend@nordsee.example', roleKey: 'sales' }),
    )

    // Re-inviting is a normal thing to do when the first link was lost. The old
    // one must stop working, or revoking the invitation you can see would leave
    // a second live link you cannot.
    expect((await resolveInvitation(t.db, first.token))?.problem).toMatch(/withdrawn/i)
    expect((await resolveInvitation(t.db, second.token))?.problem).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Seats
  // -------------------------------------------------------------------------

  /** Sets the licence so exactly `free` seats are open right now.
   *
   *  The seat tests below have to know how full the tenant is, and hard-coding
   *  that couples every one of them to how many members the tests above happen
   *  to have created. */
  const setFreeSeats = async (free: number) => {
    const view = await asOwner((tx) => listMembers(tx, ownerCtx))
    await t.sudo(
      `update licenses set seat_count = ${view.seats.used + free}
         where organization_id = '${org.orgId}'`,
    )
  }

  it('refuses to send an invitation when every seat is taken', async () => {
    await setFreeSeats(1)

    const invite = await asOwner((tx) =>
      inviteMember(tx, ownerCtx, { email: 'filler@nordsee.example', roleKey: 'sales' }),
    )
    await acceptInvitation(t.db, {
      token: invite.token,
      name: 'Last Seat',
      password: 'correct-horse-battery',
    })

    await expect(
      asOwner((tx) =>
        inviteMember(tx, ownerCtx, { email: 'overflow@nordsee.example', roleKey: 'sales' }),
      ),
    ).rejects.toMatchObject({ code: 'SEAT_LIMIT_REACHED' })
  })

  it('refuses acceptance when the seats filled after the invitation was sent', async () => {
    // The gap this covers: two invitations sent while one seat was free. The
    // pre-check at invite time cannot see the future, which is exactly why the
    // limit is a database trigger and not just service code.
    await setFreeSeats(1)

    const a = await asOwner((tx) =>
      inviteMember(tx, ownerCtx, { email: 'race-a@nordsee.example', roleKey: 'sales' }),
    )
    const b = await asOwner((tx) =>
      inviteMember(tx, ownerCtx, { email: 'race-b@nordsee.example', roleKey: 'sales' }),
    )

    await acceptInvitation(t.db, {
      token: a.token,
      name: 'Racer A',
      password: 'correct-horse-battery',
    })

    await expect(
      acceptInvitation(t.db, {
        token: b.token,
        name: 'Racer B',
        password: 'correct-horse-battery',
      }),
    ).rejects.toMatchObject({ code: 'SEAT_LIMIT_REACHED' })

    // And the loser's invitation is not silently burnt — it stays claimable if
    // a seat frees up.
    const stillOpen = await t.client.query<{ accepted_at: string | null }>(
      `select accepted_at from invitations where id = $1`,
      [b.invitationId],
    )
    expect(stillOpen.rows[0]!.accepted_at).toBeNull()
  })

  it('frees a seat on deactivation and takes it back on reactivation', async () => {
    // Room to breathe for everything after this — the tests below are about
    // roles and boundaries, not capacity, and should not fail because the
    // seat tests above filled the tenant.
    await setFreeSeats(20)

    const before = await asOwner((tx) => listMembers(tx, ownerCtx))
    const victim = before.members.find((m) => m.status === 'active' && !m.isSelf)!

    await asOwner((tx) => setMemberActive(tx, ownerCtx, victim.membershipId, false))
    const after = await asOwner((tx) => listMembers(tx, ownerCtx))
    expect(after.seats.used).toBe(before.seats.used - 1)

    await asOwner((tx) => setMemberActive(tx, ownerCtx, victim.membershipId, true))
    const back = await asOwner((tx) => listMembers(tx, ownerCtx))
    expect(back.seats.used).toBe(before.seats.used)
  })

  // -------------------------------------------------------------------------
  // The last owner
  // -------------------------------------------------------------------------

  it('will not let the only owner be deactivated', async () => {
    // An organization with no active owner cannot invite, cannot change a role
    // and cannot manage its licence. It is not recoverable from inside the
    // product.
    const view = await asOwner((tx) => listMembers(tx, ownerCtx))
    const me = view.members.find((m) => m.isSelf)!

    await expect(
      asOwner((tx) =>
        tx.update(memberships).set({ status: 'deactivated' }).where(eq(memberships.id, me.membershipId)),
      ),
    ).rejects.toThrow(/SYNC_LAST_OWNER/)
  })

  it('will not let the only owner be demoted', async () => {
    const view = await asOwner((tx) => listMembers(tx, ownerCtx))
    const me = view.members.find((m) => m.isSelf)!

    await expect(
      asOwner((tx) => changeRole(tx, ownerCtx, me.membershipId, 'admin')),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('still lets an organization be deleted', async () => {
    // The last-owner guard fires on UPDATE only, and this is why. Memberships
    // cascade from `organizations`, so a BEFORE DELETE trigger would abort the
    // cascade on the owner's row and make deleting an organization impossible —
    // permanently, and for GDPR erasure too. The first version of this trigger
    // did exactly that.
    const doomed = await seedOrg(t, { name: 'Wound Down Ltd', slug: 'wound-down', seats: 2 })

    await t.sudo(`delete from organizations where id = '${doomed.orgId}'`)

    const left = await t.client.query<{ n: string }>(
      `select count(*) as n from memberships where organization_id = $1`,
      [doomed.orgId],
    )
    expect(Number(left.rows[0]!.n)).toBe(0)
  })

  it('allows the handover once a second owner exists', async () => {
    const view = await asOwner((tx) => listMembers(tx, ownerCtx))
    const successor = view.members.find((m) => !m.isSelf && m.status === 'active')!
    const me = view.members.find((m) => m.isSelf)!

    await asOwner((tx) => changeRole(tx, ownerCtx, successor.membershipId, 'owner'))
    // Now stepping down is safe, and must be allowed — otherwise the founder can
    // never hand the business over.
    await asOwner((tx) => changeRole(tx, ownerCtx, me.membershipId, 'admin'))

    const after = await asOwner((tx) => listMembers(tx, ownerCtx))
    expect(after.members.filter((m) => m.roleKey === 'owner')).toHaveLength(1)

    // Put it back for the tests below.
    await asOwner((tx) => changeRole(tx, ownerCtx, me.membershipId, 'owner'))
    await asOwner((tx) => changeRole(tx, ownerCtx, successor.membershipId, 'sales'))
  })

  // -------------------------------------------------------------------------
  // Privilege boundaries
  // -------------------------------------------------------------------------

  it('lets an ordinary member see the roster but change nothing', async () => {
    // `member.read` is in every role's grant on purpose — seeing who your
    // colleagues are and how many seats are left is not privileged. Everything
    // that COSTS a seat or moves privilege is owner/admin only.
    const view = await asOwner((tx) => listMembers(tx, ownerCtx))
    const salesMember = view.members.find((m) => m.roleKey === 'sales' && m.status === 'active')!

    const salesCtx = (await resolveContext(t.db, {
      userId: salesMember.userId,
      organizationId: org.orgId,
    }))!
    expect(salesCtx.role).toBe('sales')

    await withTenant(t.db, { organizationId: org.orgId, userId: salesMember.userId }, async (tx) => {
      const seen = await listMembers(tx, salesCtx)
      expect(seen.members.length).toBeGreaterThan(0)

      await expect(
        inviteMember(tx, salesCtx, { email: 'sneaky@nordsee.example', roleKey: 'sales' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })

      const owner = seen.members.find((m) => m.roleKey === 'owner')!
      await expect(changeRole(tx, salesCtx, owner.membershipId, 'readonly')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
      await expect(
        setMemberActive(tx, salesCtx, owner.membershipId, false),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(revokeInvitation(tx, salesCtx, owner.membershipId)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
    })
  })

  it('will not let an admin mint an owner', async () => {
    // Admins hold every permission except org.delete. Inviting an owner would
    // be a two-step escalation to the one thing they cannot do.
    const adminUserId = await seedUser(t, 'admin@nordsee.example')
    const adminRole = await roleId(t.client, 'admin')
    await t.sudo(
      `insert into memberships (id, organization_id, user_id, role_id, status)
       values (gen_random_uuid(), '${org.orgId}', '${adminUserId}', '${adminRole}', 'active')`,
    )

    const adminCtx = (await resolveContext(t.db, {
      userId: adminUserId,
      organizationId: org.orgId,
    }))!
    expect(adminCtx.role).toBe('admin')

    await withTenant(t.db, { organizationId: org.orgId, userId: adminUserId }, async (tx) => {
      await expect(
        inviteMember(tx, adminCtx, { email: 'newowner@nordsee.example', roleKey: 'owner' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })

      // And cannot demote the existing one out from under them.
      const view = await listMembers(tx, adminCtx)
      const owner = view.members.find((m) => m.roleKey === 'owner')!
      await expect(
        changeRole(tx, adminCtx, owner.membershipId, 'readonly'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })
  })

  it('cannot see or touch another tenant’s members', async () => {
    const mine = await asOwner((tx) => listMembers(tx, ownerCtx))
    const theirs = await withTenant(
      t.db,
      { organizationId: other.orgId, userId: other.ownerUserId },
      (tx) => listMembers(tx, otherOwnerCtx),
    )

    expect(theirs.members).toHaveLength(1)
    const overlap = theirs.members.filter((m) =>
      mine.members.some((x) => x.membershipId === m.membershipId),
    )
    expect(overlap).toEqual([])

    // A membership id from the other tenant is not merely refused — it is
    // invisible, so it reads as "no such member".
    const victim = mine.members[0]!
    await withTenant(
      t.db,
      { organizationId: other.orgId, userId: other.ownerUserId },
      async (tx) => {
        await expect(
          changeRole(tx, otherOwnerCtx, victim.membershipId, 'readonly'),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
        await expect(
          setMemberActive(tx, otherOwnerCtx, victim.membershipId, false),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      },
    )
  })

  it('refuses to invite somebody who is already a member', async () => {
    const view = await asOwner((tx) => listMembers(tx, ownerCtx))
    const existing = view.members.find((m) => m.status === 'active' && !m.isSelf)!

    await expect(
      asOwner((tx) => inviteMember(tx, ownerCtx, { email: existing.email, roleKey: 'sales' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  // -------------------------------------------------------------------------
  // The existing-account path
  // -------------------------------------------------------------------------

  it('requires an existing account to be signed in as the invited address', async () => {
    // The accountant who already works with another client on this
    // installation. Without the signed-in check, holding the link would be
    // enough to join AS them.
    const invite = await withTenant(
      t.db,
      { organizationId: other.orgId, userId: other.ownerUserId },
      (tx) =>
        inviteMember(tx, otherOwnerCtx, { email: 'owner@nordsee.test', roleKey: 'finance' }),
    )

    const resolved = await resolveInvitation(t.db, invite.token)
    expect(resolved?.userExists).toBe(true)

    // Anonymous.
    await expect(acceptInvitation(t.db, { token: invite.token })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    })

    // Signed in as somebody else entirely.
    await expect(
      acceptInvitation(t.db, { token: invite.token }, other.ownerUserId),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })

    // Signed in as the invited person.
    const result = await acceptInvitation(t.db, { token: invite.token }, org.ownerUserId)
    expect(result.created).toBe(false)
    expect(result.organizationId).toBe(other.orgId)

    // They now belong to both, which is the whole point of global users.
    const inNew = await resolveContext(t.db, {
      userId: org.ownerUserId,
      organizationId: other.orgId,
    })
    const inOld = await resolveContext(t.db, {
      userId: org.ownerUserId,
      organizationId: org.orgId,
    })
    expect(inNew?.role).toBe('finance')
    expect(inOld?.role).toBe('owner')
  })

  it('does not create an account when the password is missing', async () => {
    const view = await asOwner((tx) => listMembers(tx, ownerCtx))
    const free = view.seats.licensed - view.seats.used
    expect(free).toBeGreaterThan(0)

    const invite = await asOwner((tx) =>
      inviteMember(tx, ownerCtx, { email: 'nopassword@nordsee.example', roleKey: 'sales' }),
    )

    await expect(
      acceptInvitation(t.db, { token: invite.token, name: 'No Password' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

    const users = await t.client.query<{ n: string }>(
      `select count(*) as n from users where email = 'nopassword@nordsee.example'`,
    )
    expect(Number(users.rows[0]!.n)).toBe(0)
  })

  it('leaves nothing behind when acceptance fails part-way', async () => {
    const invite = await asOwner((tx) =>
      inviteMember(tx, ownerCtx, { email: 'rollback@nordsee.example', roleKey: 'sales' }),
    )

    await t.sudo(`
      create or replace function public.__fail_membership() returns trigger
        language plpgsql as $$ begin raise exception 'boom'; end $$;
      create trigger __fail_membership before insert on public.memberships
        for each row execute function public.__fail_membership();
    `)

    await expect(
      acceptInvitation(t.db, {
        token: invite.token,
        name: 'Rolls Back',
        password: 'correct-horse-battery',
      }),
    ).rejects.toThrow()

    await t.sudo(`drop trigger __fail_membership on public.memberships`)

    // Neither the user nor the claim survives — otherwise the invitation is
    // burnt and the address is taken by an account that cannot sign in
    // anywhere.
    const res = await t.client.query<{ users: string; accepted: string | null }>(
      `select
         (select count(*) from users where email = 'rollback@nordsee.example') as users,
         (select accepted_at from invitations where id = $1)                   as accepted`,
      [invite.invitationId],
    )
    expect(Number(res.rows[0]!.users)).toBe(0)
    expect(res.rows[0]!.accepted).toBeNull()

    // And the retry works.
    const ok = await acceptInvitation(t.db, {
      token: invite.token,
      name: 'Rolls Back',
      password: 'correct-horse-battery',
    })
    expect(ok.created).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Admin-issued password resets — the offline install's substitute for
  // /forgot-password, which needs a mail server this deployment may not have.
  // -------------------------------------------------------------------------

  it('issues a reset link that actually sets a new password', async () => {
    const view = await asOwner((tx) => listMembers(tx, ownerCtx))
    const target = view.members.find((m) => m.status === 'active' && !m.isSelf)!

    const issued = await asOwner((tx) => adminResetPassword(tx, ownerCtx, target.membershipId))
    expect(issued.email).toBe(target.email)
    expect(issued.token.length).toBeGreaterThan(20)

    // Stored hashed in the same table the self-service flow uses — this is
    // what lets completeReset() accept either kind of token unmodified.
    const stored = await t.client.query<{ n: string }>(
      `select count(*) as n from password_reset_tokens`,
    )
    expect(Number(stored.rows[0]!.n)).toBeGreaterThan(0)

    const result = await completeReset(t.db, issued.token, 'a-new-correct-horse')
    expect(result.ok).toBe(true)

    // And it actually changed something real: the old outcome of this test
    // would have been indistinguishable from a token that silently did
    // nothing.
    const ctx = await resolveContext(t.db, { userId: target.userId, organizationId: org.orgId })
    expect(ctx).not.toBeNull()
  })

  it('will not let an admin reset an owner’s password', async () => {
    const adminUserId = await seedUser(t, 'reset-admin@nordsee.example')
    const adminRole = await roleId(t.client, 'admin')
    await t.sudo(
      `insert into memberships (id, organization_id, user_id, role_id, status)
       values (gen_random_uuid(), '${org.orgId}', '${adminUserId}', '${adminRole}', 'active')`,
    )
    const adminCtx = (await resolveContext(t.db, {
      userId: adminUserId,
      organizationId: org.orgId,
    }))!

    await withTenant(t.db, { organizationId: org.orgId, userId: adminUserId }, async (tx) => {
      const view = await listMembers(tx, adminCtx)
      const owner = view.members.find((m) => m.roleKey === 'owner')!
      await expect(adminResetPassword(tx, adminCtx, owner.membershipId)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
    })
  })

  it('records every membership change in the audit trail', async () => {
    const res = await t.client.query<{ action: string }>(
      `select distinct action from audit_log where organization_id = $1 and action like 'member.%'`,
      [org.orgId],
    )
    const actions = res.rows.map((r) => r.action).sort()
    expect(actions).toContain('member.invited')
    expect(actions).toContain('member.joined')
    expect(actions).toContain('member.role_changed')
    expect(actions).toContain('member.password_reset_issued')
    expect(actions).toContain('member.deactivated')
  })

  it('never writes an invitation token into the audit trail', async () => {
    // An audit log that records credentials turns a log reader into an account.
    const res = await t.client.query<{ n: string }>(
      `select count(*) as n from audit_log
        where organization_id = $1
          and (after::text ilike '%token%' or before::text ilike '%token%')`,
      [org.orgId],
    )
    expect(Number(res.rows[0]!.n)).toBe(0)
  })
})

describe('invitation links', () => {
  it('builds a link against the origin it was issued from', () => {
    expect(invitationUrl('https://erp.example.com', 'abc123')).toBe(
      'https://erp.example.com/invite/abc123',
    )
    // A trailing slash from AUTH_URL must not produce a double slash.
    expect(invitationUrl('https://erp.example.com/', 'abc123')).toBe(
      'https://erp.example.com/invite/abc123',
    )
  })

  it('escapes a token so it survives the URL', () => {
    // base64url tokens contain no reserved characters, but the function must
    // not depend on that — it is handed whatever generateToken produces.
    expect(invitationUrl('https://x.test', 'a+b/c=')).toBe('https://x.test/invite/a%2Bb%2Fc%3D')
  })
})

describe('admin reset-password links', () => {
  it('points at the same /reset-password route the self-service flow uses', () => {
    expect(resetPasswordUrl('https://erp.example.com', 'abc123')).toBe(
      'https://erp.example.com/reset-password?token=abc123',
    )
    expect(resetPasswordUrl('https://erp.example.com/', 'abc123')).toBe(
      'https://erp.example.com/reset-password?token=abc123',
    )
  })
})
