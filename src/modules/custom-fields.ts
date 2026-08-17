import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { customFieldDefs, savedViews } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { filterSchema } from './filters'
import type { PostingActor } from '@/finance/ledger'

export const ENTITY_TYPES = [
  'business_partner',
  'product',
  'deal',
  'invoice',
  'sales_order',
  'purchase_order',
  'partner_contact',
] as const

export const FIELD_TYPES = [
  'text',
  'number',
  'date',
  'select',
  'boolean',
  'currency',
  'url',
  'email',
] as const

export const customFieldSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,48}$/, 'Key must be lowercase letters, digits and underscores'),
  label: z.string().min(1).max(80),
  fieldType: z.enum(FIELD_TYPES).default('text'),
  options: z.array(z.string().max(80)).max(50).default([]),
  isRequired: z.boolean().default(false),
  helpText: z.string().max(200).optional(),
  position: z.number().int().min(0).max(999).default(0),
})

export async function createCustomField(
  tx: TenantTx,
  actor: PostingActor,
  input: unknown,
): Promise<{ id: string; key: string }> {
  const parsed = customFieldSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid custom field', parsed.error.issues)
  }
  const field = parsed.data

  if (field.fieldType === 'select' && field.options.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'A select field needs at least one option')
  }

  const id = newId()
  await tx.insert(customFieldDefs).values({
    id,
    organizationId: actor.organizationId,
    entityType: field.entityType,
    key: field.key,
    label: field.label,
    fieldType: field.fieldType,
    options: field.options,
    isRequired: field.isRequired,
    helpText: field.helpText ?? null,
    position: field.position,
    createdBy: actor.userId ?? null,
  })

  await writeAudit(tx, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: 'custom_field.created',
    entityType: 'custom_field_def',
    entityId: id,
    after: { entityType: field.entityType, key: field.key, fieldType: field.fieldType },
    requestId: actor.requestId,
  })

  return { id, key: field.key }
}

export async function listCustomFields(
  tx: TenantTx,
  organizationId: string,
  entityType: string,
) {
  return tx
    .select()
    .from(customFieldDefs)
    .where(
      and(
        eq(customFieldDefs.organizationId, organizationId),
        eq(customFieldDefs.entityType, entityType),
        isNull(customFieldDefs.archivedAt),
      ),
    )
    .orderBy(customFieldDefs.position, customFieldDefs.label)
}

/**
 * Validates and normalises a record's custom-field values against the tenant's
 * definitions.
 *
 * Unknown keys are REJECTED rather than silently stored. A typo'd key would
 * otherwise write a value that no form ever shows and no filter ever finds —
 * data that exists but is invisible is worse than data that was refused.
 */
export async function validateCustomFields(
  tx: TenantTx,
  organizationId: string,
  entityType: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const defs = await listCustomFields(tx, organizationId, entityType)
  const byKey = new Map(defs.map((d) => [d.key, d]))
  const out: Record<string, unknown> = {}
  const errors: string[] = []

  for (const [key, value] of Object.entries(values ?? {})) {
    const def = byKey.get(key)
    if (!def) {
      errors.push(`Unknown field "${key}"`)
      continue
    }
    if (value === null || value === undefined || value === '') {
      if (def.isRequired) errors.push(`${def.label} is required`)
      continue
    }

    switch (def.fieldType) {
      case 'number':
      case 'currency': {
        const n = Number(value)
        if (!Number.isFinite(n)) errors.push(`${def.label} must be a number`)
        else out[key] = n
        break
      }
      case 'boolean':
        out[key] = value === true || value === 'true'
        break
      case 'date': {
        const s = String(value)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) errors.push(`${def.label} must be a date`)
        else out[key] = s
        break
      }
      case 'select': {
        const options = (def.options as string[]) ?? []
        if (!options.includes(String(value))) {
          errors.push(`${def.label} must be one of: ${options.join(', ')}`)
        } else out[key] = String(value)
        break
      }
      case 'email': {
        const s = String(value)
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) errors.push(`${def.label} must be an email`)
        else out[key] = s.toLowerCase()
        break
      }
      case 'url': {
        const s = String(value)
        if (!/^https?:\/\//.test(s)) errors.push(`${def.label} must be a URL`)
        else out[key] = s
        break
      }
      default:
        out[key] = String(value)
    }
  }

  for (const def of defs) {
    if (def.isRequired && !(def.key in out)) errors.push(`${def.label} is required`)
  }

  if (errors.length > 0) {
    throw new AppError('VALIDATION_FAILED', errors.join('; '), { errors })
  }
  return out
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

export const savedViewSchema = z.object({
  module: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  filters: filterSchema.default({ conditions: [] }),
  sort: z.object({ key: z.string().max(64), dir: z.enum(['asc', 'desc']) }).partial().default({}),
  columns: z.record(z.string(), z.boolean()).default({}),
  /** Null keeps it private; 'organization' shares it with the whole tenant. */
  scope: z.enum(['private', 'organization']).default('private'),
  isDefault: z.boolean().default(false),
})

export async function createSavedView(
  tx: TenantTx,
  actor: PostingActor,
  input: unknown,
): Promise<{ id: string }> {
  const parsed = savedViewSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid saved view', parsed.error.issues)
  }
  const view = parsed.data
  const id = newId()

  // Only one default per (user, module) — enforced by a partial unique index,
  // so clear any existing one first rather than letting the insert fail.
  if (view.isDefault) {
    await tx.execute(sql`
      update saved_views set is_default = false
       where organization_id = ${actor.organizationId}
         and module = ${view.module}
         and user_id is not distinct from ${
           view.scope === 'organization' ? null : (actor.userId ?? null)
         }
    `)
  }

  await tx.insert(savedViews).values({
    id,
    organizationId: actor.organizationId,
    userId: view.scope === 'organization' ? null : (actor.userId ?? null),
    module: view.module,
    name: view.name,
    filters: view.filters,
    sort: view.sort,
    columns: view.columns,
    isDefault: view.isDefault,
  })

  return { id }
}

/** A user's own views plus the organization-wide ones. */
export async function listSavedViews(
  tx: TenantTx,
  organizationId: string,
  module: string,
  userId: string,
) {
  const res = await tx.execute(sql`
    select id, name, filters, sort, columns, is_default as "isDefault",
           (user_id is null) as shared
      from saved_views
     where organization_id = ${organizationId}
       and module = ${module}
       and (user_id = ${userId} or user_id is null)
     order by position, name
  `)
  return (
    res as unknown as {
      rows: {
        id: string
        name: string
        filters: unknown
        sort: unknown
        columns: unknown
        isDefault: boolean
        shared: boolean
      }[]
    }
  ).rows
}

export async function deleteSavedView(
  tx: TenantTx,
  actor: PostingActor,
  viewId: string,
): Promise<void> {
  // A shared view can be removed by anyone who can see it; a private one only
  // by its owner. RLS already scopes to the tenant.
  const res = await tx.execute(sql`
    delete from saved_views
     where id = ${viewId}
       and organization_id = ${actor.organizationId}
       and (user_id = ${actor.userId ?? null} or user_id is null)
    returning id
  `)
  const deleted = (res as unknown as { rows: { id: string }[] }).rows
  if (deleted.length === 0) throw new AppError('NOT_FOUND', 'Saved view not found')
}
