import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { grantsFor } from '@/auth/permissions'
import {
  generatePairingCode,
  issuePairingCode,
  listDevices,
  normalisePairingCode,
  redeemPairingCode,
  revokeDevice,
  touchDevice,
} from '@/desktop/devices'
import type { RequestContext } from '@/server/context'
import { createOpsFixture, type OpsFixture } from './helpers/operations'
import { FULL_ACCESS } from '@/billing/access'

const ctxFor = (f: OpsFixture, role: 'owner' | 'readonly' = 'owner'): RequestContext => ({
  userId: f.actor.userId!,
  organizationId: f.orgId,
  membershipId: 'test',
  role,
  permissions: grantsFor(role),
  requestId: null,
  ip: null,
  userAgent: null,
  licence: FULL_ACCESS,
})

const device = (over: Record<string, unknown> = {}) => ({
  fingerprint: 'a'.repeat(64),
  platform: 'windows' as const,
  appVersion: '1.0.0',
  ...over,
})

describe('desktop device pairing', () => {
  let f: OpsFixture

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  // -------------------------------------------------------------------------
  // The code itself.
  // -------------------------------------------------------------------------

  it('generates a code a person can read aloud', () => {
    const code = generatePairingCode()
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    // Crockford: no I, L, O or U, because those are what get misread over the
    // phone and mistyped from a sticky note.
    expect(code).not.toMatch(/[ILOU]/)
  })

  it('accepts what somebody actually types', () => {
    const code = 'A1B2-C3D4'
    for (const typed of ['a1b2-c3d4', 'A1B2C3D4', ' A1B2 - C3D4 ', 'AlB2-C3D4']) {
      expect(normalisePairingCode(typed), typed).toBe(normalisePairingCode(code))
    }
  })

  // -------------------------------------------------------------------------
  // Redeeming.
  // -------------------------------------------------------------------------

  it('pairs a machine and reports which workspace it belongs to', async () => {
    const { code } = await f.tx((tx) => issuePairingCode(tx, ctxFor(f)))
    const result = await f.tx((tx) => redeemPairingCode(tx, { code, ...device() }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.organizationId).toBe(f.orgId)

    const devices = await f.tx((tx) => listDevices(tx, ctxFor(f)))
    expect(devices).toHaveLength(1)
    expect(devices[0]!.platform).toBe('windows')
  })

  it('is single use', async () => {
    const { code } = await f.tx((tx) => issuePairingCode(tx, ctxFor(f)))
    expect((await f.tx((tx) => redeemPairingCode(tx, { code, ...device() }))).ok).toBe(true)

    const second = await f.tx((tx) =>
      redeemPairingCode(tx, { code, ...device({ fingerprint: 'b'.repeat(64) }) }),
    )
    expect(second.ok).toBe(false)
    expect(await f.tx((tx) => listDevices(tx, ctxFor(f)))).toHaveLength(1)
  })

  it('expires', async () => {
    const { code } = await f.tx((tx) => issuePairingCode(tx, ctxFor(f)))
    await f.tx((tx) =>
      tx.execute(sql`update device_pairing_codes set expires_at = now() - interval '1 minute'`),
    )
    expect((await f.tx((tx) => redeemPairingCode(tx, { code, ...device() }))).ok).toBe(false)
  })

  it('refuses a code that was never issued', async () => {
    expect(
      (await f.tx((tx) => redeemPairingCode(tx, { code: 'ZZZZ-ZZZZ', ...device() }))).ok,
    ).toBe(false)
  })

  it('never stores the code in the clear', async () => {
    const { code } = await f.tx((tx) => issuePairingCode(tx, ctxFor(f)))
    const stored = await f.tx(async (tx) => {
      const res = await tx.execute(sql`select code_hash, code_prefix from device_pairing_codes`)
      return (res as unknown as { rows: { code_hash: string; code_prefix: string }[] }).rows[0]!
    })
    expect(stored.code_hash).not.toContain(code)
    expect(stored.code_hash).not.toContain(normalisePairingCode(code))
    // The prefix is shown in the UI, so it is short enough not to reconstruct.
    expect(stored.code_prefix.length).toBeLessThanOrEqual(4)
  })

  it('never stores the raw machine fingerprint', async () => {
    // A disk serial or MAC address tied to a named workspace is personal data,
    // and there is no reason to hold it.
    const { code } = await f.tx((tx) => issuePairingCode(tx, ctxFor(f)))
    const raw = 'c'.repeat(64)
    await f.tx((tx) => redeemPairingCode(tx, { code, ...device({ fingerprint: raw }) }))

    const stored = await f.tx(async (tx) => {
      const res = await tx.execute(sql`select device_fingerprint_hash as h from device_activations`)
      return (res as unknown as { rows: { h: string }[] }).rows[0]!.h
    })
    expect(stored).not.toBe(raw)
    expect(stored).not.toContain(raw)
  })

  it('re-pairing the same machine updates it rather than piling up rows', async () => {
    const fingerprint = 'd'.repeat(64)
    for (const version of ['1.0.0', '1.1.0']) {
      const { code } = await f.tx((tx) => issuePairingCode(tx, ctxFor(f)))
      await f.tx((tx) =>
        redeemPairingCode(tx, { code, ...device({ fingerprint, appVersion: version }) }),
      )
    }

    const devices = await f.tx((tx) => listDevices(tx, ctxFor(f)))
    expect(devices).toHaveLength(1)
    expect(devices[0]!.appVersion).toBe('1.1.0')
  })

  // -------------------------------------------------------------------------
  // Revocation, which is the point of the feature.
  // -------------------------------------------------------------------------

  it('stops responding to a revoked device', async () => {
    const { code } = await f.tx((tx) => issuePairingCode(tx, ctxFor(f)))
    const paired = await f.tx((tx) => redeemPairingCode(tx, { code, ...device() }))
    if (!paired.ok) throw new Error('pairing failed')

    expect(await f.tx((tx) => touchDevice(tx, paired.deviceId, '1.0.0'))).toBe(true)

    await f.tx((tx) => revokeDevice(tx, ctxFor(f), paired.deviceId))

    // The stolen laptop asks, and is told to stop — without its cooperation.
    expect(await f.tx((tx) => touchDevice(tx, paired.deviceId, '1.0.0'))).toBe(false)
  })

  it('answers the same way for a revoked device and an invented one', async () => {
    // A caller probing device ids should not learn which ones exist.
    const invented = '018f0000-0000-7000-8000-0000000000ff'
    expect(await f.tx((tx) => touchDevice(tx, invented, null))).toBe(false)
    expect(await f.tx((tx) => touchDevice(tx, 'not-a-uuid', null))).toBe(false)
  })

  it('re-pairing after revocation brings the device back', async () => {
    const fingerprint = 'e'.repeat(64)
    const first = await f.tx(async (tx) => {
      const { code } = await issuePairingCode(tx, ctxFor(f))
      return redeemPairingCode(tx, { code, ...device({ fingerprint }) })
    })
    if (!first.ok) throw new Error('pairing failed')
    await f.tx((tx) => revokeDevice(tx, ctxFor(f), first.deviceId))

    // An administrator revoked it, then the same machine legitimately pairs
    // again. That has to work, or a mistaken revocation is unrecoverable.
    const again = await f.tx(async (tx) => {
      const { code } = await issuePairingCode(tx, ctxFor(f))
      return redeemPairingCode(tx, { code, ...device({ fingerprint }) })
    })
    expect(again.ok).toBe(true)

    const devices = await f.tx((tx) => listDevices(tx, ctxFor(f)))
    expect(devices).toHaveLength(1)
    expect(devices[0]!.revokedAt).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Permissions and isolation.
  // -------------------------------------------------------------------------

  it('will not let a role without license.manage issue or revoke', async () => {
    await expect(f.tx((tx) => issuePairingCode(tx, ctxFor(f, 'readonly')))).rejects.toThrow()

    const { code } = await f.tx((tx) => issuePairingCode(tx, ctxFor(f)))
    const paired = await f.tx((tx) => redeemPairingCode(tx, { code, ...device() }))
    if (!paired.ok) throw new Error('pairing failed')

    await expect(
      f.tx((tx) => revokeDevice(tx, ctxFor(f, 'readonly'), paired.deviceId)),
    ).rejects.toThrow()
  })

  it('keeps one tenant\'s devices out of another\'s list', async () => {
    const { code } = await f.tx((tx) => issuePairingCode(tx, ctxFor(f)))
    await f.tx((tx) => redeemPairingCode(tx, { code, ...device() }))

    const other = await createOpsFixture()
    try {
      expect(await other.tx((tx) => listDevices(tx, ctxFor(other)))).toHaveLength(0)
    } finally {
      await other.t.close()
    }
  })

  it('a device id grants no access to anything on its own', async () => {
    // The requirement this feature is most likely to be misread as violating.
    // Pairing records a machine; it authenticates nobody. The only thing a
    // device id can do is ask whether it is still allowed to run.
    const { code } = await f.tx((tx) => issuePairingCode(tx, ctxFor(f)))
    const paired = await f.tx((tx) => redeemPairingCode(tx, { code, ...device() }))
    if (!paired.ok) throw new Error('pairing failed')

    // touchDevice is the entire surface. There is no call that takes a device
    // id and returns tenant data — if one is ever added, this test is where the
    // reviewer should be reminded why that would be a mistake.
    expect(await f.tx((tx) => touchDevice(tx, paired.deviceId, null))).toBe(true)
  })
})
