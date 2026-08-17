import type { Permission } from '@/auth/permissions'

/**
 * What a licence in a given state permits.
 *
 * Deliberately a PURE function in its own module with no database and no
 * imports from the request layer — `server/context.ts` needs it to build every
 * request context, and `billing/service.ts` needs it too, so putting it in
 * either would be a cycle.
 */

/** Days after the paid period ends before access is restricted. */
export const GRACE_DAYS = 14

export type LicenceAccess = {
  /** Can this tenant change data right now? */
  canWrite: boolean
  /** Why not, phrased for the person who has to fix it. */
  reason: string | null
  /** Shown while still writable — the last days of a trial, or a failed card
   *  still inside its grace window. */
  warning: string | null
}

export const FULL_ACCESS: LicenceAccess = { canWrite: true, reason: null, warning: null }

/**
 * Permissions that keep working when a tenant is read-only.
 *
 * Without this list, read-only mode is a trap: the customer cannot pay, because
 * paying is a write. `license.manage` is the way OUT of read-only and must
 * never be the thing read-only blocks.
 *
 * GDPR tooling stays open for a stronger reason than convenience. A data
 * subject's right of access does not lapse because their controller's card
 * failed, and this product is not entitled to obstruct that.
 */
const ALWAYS_ALLOWED: ReadonlySet<Permission> = new Set<Permission>([
  'license.manage',
  'gdpr.manage',
  // Freeing a seat and closing the account must both remain possible. Trapping
  // somebody in a subscription they cannot leave is not leverage, it is a
  // complaint to a regulator.
  'member.deactivate',
  'org.delete',
])

/**
 * Is this permission a WRITE?
 *
 * Derived from the catalogue's own naming rather than a hand-kept list: every
 * read permission ends in `.read`, so a permission added later is treated as a
 * write by default. That is the safe direction to be wrong in — a new write
 * that should have been gated is a licensing hole, a new read that gets gated
 * is a visible bug someone reports on day one.
 */
export function isWritePermission(permission: Permission): boolean {
  return !permission.endsWith('.read')
}

export function permittedWhileReadOnly(permission: Permission): boolean {
  return !isWritePermission(permission) || ALWAYS_ALLOWED.has(permission)
}

/**
 * READ-ONLY, NOT LOCKED OUT.
 *
 * When a subscription lapses the tenant keeps every read: their ledger, their
 * invoices, their exports. Only writes stop, and nothing is ever deleted for
 * non-payment.
 *
 * That is a deliberate product decision. This system holds a business's
 * statutory accounting records. Denying access to them over an expired card
 * would be disproportionate, would obstruct the customer's own legal
 * obligations, and in several jurisdictions would create a problem of its own.
 * Withholding the ability to add MORE data is enough leverage to get a card
 * updated; withholding the books is not leverage, it is a hostage.
 */
export function licenceAccess(
  license: {
    status: string
    validUntil: Date | string | null
    graceUntil: Date | string | null
  } | null,
  now = new Date(),
): LicenceAccess {
  // No licence row at all. Not a paying-customer problem — it means the tenant
  // was provisioned wrong — so it is surfaced rather than silently permitted.
  if (!license) {
    return {
      canWrite: false,
      reason: 'This organization has no licence record. Contact support — nothing has been lost.',
      warning: null,
    }
  }

  const validUntil = license.validUntil ? new Date(license.validUntil) : null
  const graceUntil = license.graceUntil ? new Date(license.graceUntil) : null

  if (license.status === 'suspended') {
    return {
      canWrite: false,
      reason:
        'This workspace is read-only because the subscription has lapsed. Your records are ' +
        'intact and can still be viewed and exported. Update the payment method to resume.',
      warning: null,
    }
  }

  if (license.status === 'cancelled') {
    // Cancelled but still inside the paid period: they get what they paid for.
    if (validUntil && now <= validUntil) {
      return {
        canWrite: true,
        reason: null,
        warning: `This subscription is cancelled and ends on ${validUntil.toISOString().slice(0, 10)}.`,
      }
    }
    return {
      canWrite: false,
      reason:
        'This subscription has been cancelled. The workspace is read-only — your records are ' +
        'intact and can still be viewed and exported.',
      warning: null,
    }
  }

  if (license.status === 'past_due') {
    const deadline = graceUntil ?? validUntil
    if (deadline && now > deadline) {
      return {
        canWrite: false,
        reason:
          'Payment has not gone through and the grace period has ended, so the workspace is ' +
          'read-only. Your records are intact. Update the payment method to resume.',
        warning: null,
      }
    }
    return {
      canWrite: true,
      reason: null,
      warning: deadline
        ? `A payment has failed. Update the payment method before ${deadline
            .toISOString()
            .slice(0, 10)} to avoid interruption.`
        : 'A payment has failed. Update the payment method to avoid interruption.',
    }
  }

  // Trial or active, but the date has passed with no webhook moving it on — a
  // renewal that failed silently, or a trial nobody converted.
  if (validUntil && now > validUntil) {
    if (!graceUntil || now > graceUntil) {
      return {
        canWrite: false,
        reason:
          license.status === 'trial'
            ? 'The trial has ended, so the workspace is read-only. Everything you entered is ' +
              'still here — choose a plan to carry on.'
            : 'The subscription has expired, so the workspace is read-only. Your records are intact.',
        warning: null,
      }
    }
    return {
      canWrite: true,
      reason: null,
      warning: 'This licence has expired and is in its grace period.',
    }
  }

  // The one deadline with no billing email behind it.
  if (license.status === 'trial' && validUntil) {
    const daysLeft = Math.ceil((validUntil.getTime() - now.getTime()) / 86_400_000)
    if (daysLeft <= 7) {
      return {
        canWrite: true,
        reason: null,
        warning: `Your trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Choose a plan to keep writing to this workspace.`,
      }
    }
  }

  return FULL_ACCESS
}
