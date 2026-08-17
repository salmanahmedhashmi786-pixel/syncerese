'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { MODULES, moduleById } from '@/modules/registry'
import { ModuleHeader } from './ModuleHeader'
import { CustomizeDrawer } from './CustomizeDrawer'
import { AssistantPanel } from './AssistantPanel'
import { CommandPalette } from './CommandPalette'

/**
 * The main column: sticky header plus the routed content.
 *
 * Overlays that belong to a record — the detail drawer and the create modal —
 * are driven by URL parameters rather than component state, so the back button
 * closes them, a drawer is linkable, and the shell does not need to know
 * anything about the page's data. Only the two shell-level panels (customizer,
 * assistant) are local state, because neither is addressable content.
 */
export function AppFrame({
  userInitials,
  organizationName,
  locale,
  currency,
  children,
}: {
  userInitials: string
  organizationName: string
  locale: string
  currency: string
  children: ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const params = useSearchParams()

  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)

  const active =
    MODULES.find((m) => pathname.startsWith(`/${m.id}`)) ?? moduleById('dashboard')!
  const isTable = active.kind === 'table'

  const openNew = () => {
    const next = new URLSearchParams(params.toString())
    next.set('new', '1')
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <ModuleHeader
        title={active.title}
        subtitle={active.subtitle || organizationName}
        showSearch={isTable}
        showNew={isTable}
        onNew={openNew}
        onCustomize={() => setCustomizeOpen(true)}
        onAssistant={() => setAssistantOpen((v) => !v)}
        assistantOpen={assistantOpen}
        userInitials={userInitials}
      />

      {/* Content padding 16px 18px 40px, per the handoff. */}
      <div style={{ flex: 1, minWidth: 0, padding: '16px 18px 40px' }}>{children}</div>

      <CustomizeDrawer open={customizeOpen} onClose={() => setCustomizeOpen(false)} />
      <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} />
      <CommandPalette locale={locale} currency={currency} />
    </main>
  )
}
