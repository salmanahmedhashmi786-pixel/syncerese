'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { MODULES, NAV_GROUPS } from '@/modules/registry'
import { useTheme } from './ThemeRoot'

/**
 * Persistent left navigation.
 *
 * Exact values from the handoff: 234px expanded / 60px collapsed, width
 * transition .16s ease, sticky full-height. The sidebar is dark in BOTH themes
 * — #111725 light, #080b11 dark — which is intentional in the spec, not an
 * oversight.
 */
export function Sidebar({
  organizationName,
  badges,
}: {
  organizationName: string
  badges: Record<string, number>
}) {
  const pathname = usePathname()
  const { sidebarCollapsed, update } = useTheme()
  const showLabels = !sidebarCollapsed

  const activeId = MODULES.find((m) => pathname.startsWith(`/${m.id}`))?.id ?? 'dashboard'

  return (
    <aside
      style={{
        width: sidebarCollapsed ? 60 : 234,
        flex: 'none',
        background: 'var(--nav)',
        display: 'flex',
        flexDirection: 'column',
        position: 'sticky',
        top: 0,
        height: '100vh',
        transition: 'width .16s ease',
      }}
    >
      {/* Brand row — 52px, matching the header height so the two align. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 14px',
          height: 52,
          flex: 'none',
          borderBottom: '1px solid rgba(255,255,255,.07)',
        }}
      >
        <Image
          src="/syncrese-mark.png"
          alt=""
          width={26}
          height={26}
          style={{ flex: 'none', display: 'block' }}
          priority
        />
        {showLabels && (
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontWeight: 600,
                fontSize: 13,
                color: '#fff',
                letterSpacing: '-.01em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              Syncrèse
            </div>
            <div
              style={{
                font: "400 10px var(--font-mono), monospace",
                color: 'rgba(255,255,255,.4)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={organizationName}
            >
              {organizationName}
            </div>
          </div>
        )}
      </div>

      <nav style={{ flex: 1, overflowX: 'hidden', overflowY: 'auto', padding: '10px 8px' }}>
        {NAV_GROUPS.map((group) => {
          const items = MODULES.filter((m) => m.group === group)
          if (items.length === 0) return null
          return (
            <div key={group} style={{ marginBottom: 12 }}>
              {showLabels && (
                <div
                  style={{
                    font: "500 9.5px var(--font-mono), monospace",
                    letterSpacing: '.09em',
                    color: 'rgba(255,255,255,.32)',
                    padding: '6px 8px 5px',
                  }}
                >
                  {group}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {items.map((m) => {
                  const on = m.id === activeId
                  const badge = badges[m.id]
                  return (
                    <Link
                      key={m.id}
                      href={`/${m.id}`}
                      title={m.label}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: showLabels ? '0 9px' : 0,
                        justifyContent: showLabels ? 'flex-start' : 'center',
                        height: 30,
                        borderRadius: 6,
                        fontSize: 12.4,
                        textDecoration: 'none',
                        color: on ? '#fff' : 'rgba(255,255,255,.66)',
                        background: on ? 'var(--ac)' : 'transparent',
                        fontWeight: on ? 600 : 400,
                        transition: 'background .12s',
                      }}
                    >
                      <span
                        style={{
                          font: "500 9.5px var(--font-mono), monospace",
                          letterSpacing: '.04em',
                          flex: 'none',
                          width: 22,
                          height: 18,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 4,
                          background: on ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.08)',
                          color: on ? '#fff' : 'rgba(255,255,255,.6)',
                        }}
                      >
                        {m.code}
                      </span>
                      {showLabels && (
                        <span
                          style={{
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {m.label}
                        </span>
                      )}
                      {showLabels && badge ? (
                        <span
                          style={{
                            marginLeft: 'auto',
                            font: "500 9.5px var(--font-mono), monospace",
                            background: 'rgba(255,255,255,.12)',
                            color: 'rgba(255,255,255,.75)',
                            padding: '1px 5px',
                            borderRadius: 9,
                          }}
                        >
                          {badge}
                        </span>
                      ) : null}
                    </Link>
                  )
                })}
              </div>
            </div>
          )
        })}
      </nav>

      <div
        style={{
          flex: 'none',
          padding: 8,
          borderTop: '1px solid rgba(255,255,255,.07)',
          display: 'flex',
          gap: 6,
        }}
      >
        <button
          type="button"
          onClick={() => update({ sidebarCollapsed: !sidebarCollapsed })}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            height: 30,
            borderRadius: 6,
            cursor: 'pointer',
            color: 'rgba(255,255,255,.55)',
            font: "500 11px var(--font-mono), monospace",
            background: 'rgba(255,255,255,.05)',
            border: 'none',
          }}
        >
          {sidebarCollapsed ? '»' : '« Collapse'}
        </button>
      </div>
    </aside>
  )
}
