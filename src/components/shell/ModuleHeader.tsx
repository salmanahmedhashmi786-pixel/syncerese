'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  accentChipStyle,
  chipButtonStyle,
  iconButtonStyle,
  primaryButtonStyle,
} from '@/components/ui/primitives'
import { useTheme } from './ThemeRoot'

/**
 * Sticky module header. 52px, z-index 20, bottom border.
 *
 * Search is a URL parameter rather than component state — that is what makes
 * filtering happen on the SERVER, keeps a filtered view shareable and
 * back-button-able, and stops the table from needing the whole dataset in
 * memory to filter it.
 */
export function ModuleHeader({
  title,
  subtitle,
  showSearch,
  showNew,
  onNew,
  onCustomize,
  onAssistant,
  assistantOpen,
  userInitials,
}: {
  title: string
  subtitle: string
  showSearch: boolean
  showNew: boolean
  onNew?: () => void
  onCustomize: () => void
  onAssistant: () => void
  assistantOpen: boolean
  userInitials: string
}) {
  const router = useRouter()
  const params = useSearchParams()
  const { theme, update } = useTheme()

  const [q, setQ] = useState(params.get('q') ?? '')

  // Keep the box in step when navigation changes the URL (module switch, back
  // button) without fighting the user mid-keystroke.
  useEffect(() => {
    setQ(params.get('q') ?? '')
  }, [params])

  // Debounced so a five-character query is one request, not five.
  useEffect(() => {
    const current = params.get('q') ?? ''
    if (q === current) return
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString())
      if (q) next.set('q', q)
      else next.delete('q')
      next.delete('page')
      router.replace(`?${next.toString()}`, { scroll: false })
    }, 250)
    return () => clearTimeout(timer)
  }, [q, params, router])

  return (
    <header
      style={{
        flex: 'none',
        height: 52,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 18px',
        background: 'var(--pnl)',
        borderBottom: '1px solid var(--bd)',
        position: 'sticky',
        top: 0,
        zIndex: 20,
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden' }}>
        <h1
          style={{
            fontWeight: 600,
            fontSize: 14.5,
            letterSpacing: '-.015em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            margin: 0,
          }}
        >
          {title}
        </h1>
        <div
          style={{
            font: '400 10.5px var(--font-mono), monospace',
            color: 'var(--mut)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {subtitle}
        </div>
      </div>

      {showSearch && (
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: 9,
              font: '400 11px var(--font-mono), monospace',
              color: 'var(--mut)',
              pointerEvents: 'none',
            }}
          >
            /
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search records…"
            aria-label="Search records"
            style={{
              height: 28,
              width: 216,
              flex: '0 1 216px',
              minWidth: 0,
              borderRadius: 6,
              border: '1px solid var(--bd)',
              background: 'var(--pnl)',
              color: 'var(--fg)',
              padding: '0 10px 0 22px',
              fontSize: 12,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => update({ theme: theme === 'dark' ? 'light' : 'dark' })}
        title="Light / dark"
        aria-label="Toggle light or dark theme"
        style={{ ...iconButtonStyle, fontFamily: 'inherit' }}
      >
        {theme === 'dark' ? '☾' : '☀'}
      </button>

      <button
        type="button"
        onClick={onAssistant}
        style={{
          ...chipButtonStyle,
          height: 28,
          padding: '0 11px',
          gap: 6,
          fontWeight: 500,
          fontSize: 12,
          fontFamily: 'inherit',
          background: assistantOpen ? 'var(--acs)' : 'transparent',
          color: assistantOpen ? 'var(--ac)' : 'var(--fg)',
        }}
      >
        <span style={{ fontSize: 11 }}>✦</span>
        Ask ERP
      </button>

      <button
        type="button"
        onClick={onCustomize}
        style={{ ...accentChipStyle, fontFamily: 'inherit' }}
      >
        Customize
      </button>

      {showNew && (
        <button
          type="button"
          onClick={onNew}
          style={{ ...primaryButtonStyle, fontFamily: 'inherit' }}
        >
          + New
        </button>
      )}

      <div
        title={userInitials}
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: 'var(--acs)',
          color: 'var(--ac)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          font: '600 10.5px var(--font-mono), monospace',
          flex: 'none',
        }}
      >
        {userInitials}
      </div>
    </header>
  )
}
