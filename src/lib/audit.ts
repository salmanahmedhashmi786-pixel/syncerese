import { auditLog, accessLog } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { newId } from './ids'

export type AuditActorType = 'user' | 'system' | 'api_key' | 'integration'

export type AuditEntry = {
  organizationId: string
  actorUserId?: string | null
  actorType?: AuditActorType
  action: string
  entityType: string
  entityId?: string | null
  before?: unknown
  after?: unknown
  requestId?: string | null
  ip?: string | null
  userAgent?: string | null
}

/**
 * Field names that must never reach the audit trail (MUST DO #18: no sensitive
 * data in logs). The audit log is widely readable inside a tenant — anyone with
 * `audit.read` sees it — so a password hash or MFA seed captured in a `before`
 * snapshot would be a real disclosure, not a theoretical one.
 */
const REDACTED = new Set([
  'passwordHash',
  'password_hash',
  'password',
  'mfaSecretEncrypted',
  'mfa_secret_encrypted',
  'mfaRecoveryCodesHashed',
  'mfa_recovery_codes_hashed',
  'tokenHash',
  'token_hash',
  'keyHash',
  'key_hash',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'accessTokenEncrypted',
  'refreshTokenEncrypted',
  'secretEncrypted',
  'secret_encrypted',
  'idToken',
  'id_token',
  'sessionToken',
  'session_token',
])

export function redact(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redact)
  if (value instanceof Date) return value.toISOString()

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED.has(k) ? '[redacted]' : redact(v)
  }
  return out
}

/**
 * Writes an audit entry INSIDE the caller's transaction.
 *
 * Taking `tx` rather than a fresh connection is the point: the audit row
 * commits atomically with the change it describes. A separate connection would
 * let the business write succeed while the audit write failed, producing
 * exactly the silent gap an audit trail exists to prevent.
 */
export async function writeAudit(tx: TenantTx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    id: newId(),
    organizationId: entry.organizationId,
    actorUserId: entry.actorUserId ?? null,
    actorType: entry.actorType ?? 'user',
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before === undefined ? null : (redact(entry.before) as object),
    after: entry.after === undefined ? null : (redact(entry.after) as object),
    requestId: entry.requestId ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
  })
}

export type AccessEntry = {
  organizationId: string
  userId?: string | null
  resource: string
  resourceId?: string | null
  action: 'read' | 'list' | 'export' | 'download'
  rowCount?: number | null
  ip?: string | null
  requestId?: string | null
}

/**
 * Records a READ of tenant data. Distinct from `writeAudit`, which records
 * changes.
 *
 * Reserved for sensitive reads and bulk operations — exports, downloads, list
 * views over personal data. Logging every single read would swamp the table and
 * make the anomaly signal useless, which defeats the purpose: `rowCount` is
 * what surfaces "one user just exported 40,000 contacts".
 */
export async function writeAccess(tx: TenantTx, entry: AccessEntry): Promise<void> {
  await tx.insert(accessLog).values({
    id: newId(),
    organizationId: entry.organizationId,
    userId: entry.userId ?? null,
    resource: entry.resource,
    resourceId: entry.resourceId ?? null,
    action: entry.action,
    rowCount: entry.rowCount ?? null,
    ip: entry.ip ?? null,
    requestId: entry.requestId ?? null,
  })
}
