import { and, eq, isNull } from 'drizzle-orm'
// Aliased: the page already has an `organizations` binding from getSession(),
// which is the caller's list of tenants, not the table.
import { customFieldDefs, organizations as organizationsTable, workflowRules } from '@/db/schema'
import { db } from '@/db'
import { adminsWithoutMfa, mfaStateFor } from '@/auth/mfa'
import { encryptionConfigured } from '@/lib/crypto'
import { getSession, tenantQuery } from '@/server/session'
import { can } from '@/server/context'
import { listMembers, type MembersView } from '@/server/members'
import { billingState, type BillingState } from '@/billing/service'
import { pricedPlans } from '@/billing/catalogue'
import { BillingPanel } from './BillingPanel'
import { PrivacyPanel } from './PrivacyPanel'
import { SecurityPanel, type SecurityState } from './SecurityPanel'
import { SettingsView } from './SettingsView'
import { CustomFieldsPanel, type CustomFieldRow } from './CustomFieldsPanel'
import { MembersPanel } from './MembersPanel'
import { WorkflowPanel, type WorkflowRuleRow } from './WorkflowPanel'
import { IntegrationsPanel } from './IntegrationsPanel'
import { RetentionPanel } from './RetentionPanel'
import { DevicesPanel } from './DevicesPanel'
import { listIntegrations, type ChatIntegrationSummary } from '@/integrations/chat'

export const metadata = { title: 'Settings' }
export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const { ctx, organizations } = await getSession()
  if (!ctx) return null
  const org = organizations.find((o) => o.organizationId === ctx.organizationId)

  const { fields, rules, membersView, billing, orgRow, pendingAdmins, integrations } = await tenantQuery(
    async (tx) => {
    const fields = await tx
      .select()
      .from(customFieldDefs)
      .where(
        and(
          eq(customFieldDefs.organizationId, ctx.organizationId),
          isNull(customFieldDefs.archivedAt),
        ),
      )
      .orderBy(customFieldDefs.entityType, customFieldDefs.position, customFieldDefs.label)

    const rules = await tx
      .select()
      .from(workflowRules)
      .where(eq(workflowRules.organizationId, ctx.organizationId))
      .orderBy(workflowRules.name)

    // Null rather than an empty view when the caller lacks member.read: the
    // panel is then not rendered at all, instead of rendering an empty member
    // list that reads as "this organization has nobody in it".
    const membersView: MembersView | null = can(ctx, 'member.read')
      ? await listMembers(tx, ctx)
      : null

    const billing: BillingState | null = can(ctx, 'license.read')
      ? await billingState(tx, ctx)
      : null

    const orgRow = (
      await tx
        .select({ requireMfa: organizationsTable.requireMfaForAdmins })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, ctx.organizationId))
        .limit(1)
    )[0]

    const pendingAdmins = await adminsWithoutMfa(tx, ctx.organizationId)

    // Same reasoning as membersView: null when the caller cannot manage
    // webhooks, so the panel is not rendered at all rather than rendering an
    // empty list that reads as "nothing is connected".
    const integrations: ChatIntegrationSummary[] | null = can(ctx, 'integration.manage')
      ? await listIntegrations(tx, ctx)
      : null

      return { fields, rules, membersView, billing, orgRow, pendingAdmins, integrations }
    },
  )

  // Outside the tenant transaction: this talks to Stripe, and holding a
  // database transaction open across a network call to a third party is how a
  // slow provider turns into database connection exhaustion.
  const plans = billing?.configured ? await pricedPlans() : []

  // MFA belongs to the PERSON, not the tenant, so it is read outside the
  // tenant-scoped query — the same enrolment follows them into every
  // organization they belong to.
  const mfa = await mfaStateFor(await db(), ctx.userId)
  const security: SecurityState = {
    mfaEnabled: mfa.enabled,
    recoveryCodesRemaining: mfa.recoveryCodesRemaining,
    encryptionReady: encryptionConfigured(),
    policyRequired: orgRow?.requireMfa ?? false,
    canManagePolicy: can(ctx, 'org.update'),
    adminsWithoutMfa: pendingAdmins.length,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 860 }}>
      <SettingsView
        organizationName={org?.organizationName ?? ''}
        organizationSlug={org?.organizationSlug ?? ''}
        role={ctx.role}
        permissionCount={ctx.permissions.size}
      />

      {billing && (
        <BillingPanel
          state={billing}
          plans={plans}
          canManage={can(ctx, 'license.manage')}
        />
      )}

      {membersView && (
        <MembersPanel
          members={membersView.members}
          invitations={membersView.invitations}
          seats={membersView.seats}
          assignableRoles={membersView.assignableRoles}
          canInvite={can(ctx, 'member.invite')}
          canUpdate={can(ctx, 'member.update')}
          canDeactivate={can(ctx, 'member.deactivate')}
          isOwner={ctx.role === 'owner'}
        />
      )}

      <CustomFieldsPanel
        canManage={can(ctx, 'customfield.manage')}
        fields={fields.map(
          (f): CustomFieldRow => ({
            id: f.id,
            entityType: f.entityType,
            key: f.key,
            label: f.label,
            fieldType: f.fieldType,
            isRequired: f.isRequired,
            options: (f.options as string[]) ?? [],
          }),
        )}
      />

      <SecurityPanel state={security} />

      {integrations && (
        <IntegrationsPanel canManage integrations={integrations} />
      )}

      {can(ctx, 'license.read') && (
        <DevicesPanel canManage={can(ctx, 'license.manage')} />
      )}

      <PrivacyPanel canManage={can(ctx, 'gdpr.manage')} />

      <RetentionPanel canManage={can(ctx, 'gdpr.manage')} />

      <WorkflowPanel
        canManage={can(ctx, 'workflow.manage')}
        rules={rules.map(
          (r): WorkflowRuleRow => ({
            id: r.id,
            name: r.name,
            isActive: r.isActive,
            triggerType: r.triggerType,
            triggerConfig: (r.triggerConfig as Record<string, unknown>) ?? {},
            conditions: (r.conditions as unknown[]) ?? [],
            actions: (r.actions as { type: string }[]) ?? [],
            runCount: r.runCount,
            lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
          }),
        )}
      />
    </div>
  )
}
