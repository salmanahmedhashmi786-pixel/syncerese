'use client'

import { CustomizeControls } from '@/components/shell/CustomizeDrawer'
import { panelStyle } from '@/components/ui/primitives'

/**
 * The Settings page renders the SAME control set as the Customize drawer —
 * one implementation, two entry points, so the two can never diverge.
 */
export function SettingsView({
  organizationName,
  organizationSlug,
  role,
  permissionCount,
}: {
  organizationName: string
  organizationSlug: string
  role: string
  permissionCount: number
}) {
  return (
    <>
      <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>
          Appearance &amp; workspace
        </div>
        <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 18 }}>
          Every setting below applies live and is saved to your account, so it follows you to any
          device or the desktop app.
        </div>
        <CustomizeControls />
      </section>

      <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Organization</div>
        <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 14 }}>
          Licensing, API keys and GDPR tooling are built in later phases.
        </div>
        <Field label="NAME" value={organizationName} />
        <Field label="SLUG" value={organizationSlug} />
        <Field label="YOUR ROLE" value={role} />
        <Field label="PERMISSIONS GRANTED" value={String(permissionCount)} />
      </section>
    </>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        padding: '7px 0',
        borderBottom: '1px solid var(--bd)',
        fontSize: 12.5,
      }}
    >
      <span
        style={{
          font: '500 9.5px var(--font-mono), monospace',
          letterSpacing: '.07em',
          color: 'var(--mut)',
          alignSelf: 'center',
        }}
      >
        {label}
      </span>
      <span>{value}</span>
    </div>
  )
}
