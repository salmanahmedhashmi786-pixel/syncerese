/**
 * Application errors carry a stable machine code so API responses, the UI and
 * the desktop shell can react without string-matching a message.
 *
 * Messages here are user-facing. They must never contain SQL, stack frames,
 * connection strings or another tenant's data — leaking those through an error
 * body is a real disclosure path (MUST DO #18: no sensitive data in logs or
 * responses).
 */
export type AppErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'SEAT_LIMIT_REACHED'
  | 'NO_LICENSE'
  | 'LICENSE_INVALID'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'PERIOD_CLOSED'
  | 'UNBALANCED_ENTRY'
  | 'IMMUTABLE_RECORD'
  | 'INTERNAL'

const STATUS: Record<AppErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  SEAT_LIMIT_REACHED: 409,
  NO_LICENSE: 402,
  LICENSE_INVALID: 402,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  PERIOD_CLOSED: 409,
  UNBALANCED_ENTRY: 422,
  IMMUTABLE_RECORD: 409,
  INTERNAL: 500,
}

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly status: number
  readonly details?: unknown

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = STATUS[code]
    this.details = details
  }
}

export const unauthenticated = (m = 'Sign in to continue.') => new AppError('UNAUTHENTICATED', m)

export const forbidden = (m = 'You do not have permission to do that.') =>
  new AppError('FORBIDDEN', m)

export const notFound = (m = 'Not found.') => new AppError('NOT_FOUND', m)

export const seatLimitReached = (used: number, licensed: number) =>
  new AppError(
    'SEAT_LIMIT_REACHED',
    `Seat limit reached — ${used} of ${licensed} seats are in use. Purchase additional seats or upgrade your plan.`,
    { used, licensed },
  )

/**
 * Translates the database's own guards into application errors.
 *
 * The seat limit and ledger balance are enforced by triggers rather than
 * service code (so no code path can skip them), which means their failures
 * arrive as Postgres exceptions. This is where they become typed.
 */
export function fromDatabaseError(err: unknown): AppError | null {
  const message = err instanceof Error ? err.message : String(err)

  const seat = /SYNC_SEAT_LIMIT_REACHED \((\d+) of (\d+) seats used\)/.exec(message)
  if (seat) return seatLimitReached(Number(seat[1]), Number(seat[2]))

  if (message.includes('SYNC_NO_LICENSE')) {
    return new AppError(
      'NO_LICENSE',
      'This organization has no active licence. Activate a product key to continue.',
    )
  }

  if (message.includes('SYNC_LAST_OWNER')) {
    return new AppError(
      'CONFLICT',
      'This is the only owner. Make someone else an owner first — an organization with no ' +
        'owner cannot be administered from inside the product.',
    )
  }

  if (message.includes('SYNC_UNBALANCED_ENTRY')) {
    return new AppError(
      'UNBALANCED_ENTRY',
      'This journal entry does not balance — total debits must equal total credits.',
    )
  }

  if (message.includes('SYNC_POSTED_IMMUTABLE')) {
    return new AppError(
      'IMMUTABLE_RECORD',
      'A posted journal entry cannot be changed. Post a reversing entry instead.',
    )
  }

  if (/duplicate key value violates unique constraint/.test(message)) {
    return new AppError('CONFLICT', 'That record already exists.')
  }

  return null
}
