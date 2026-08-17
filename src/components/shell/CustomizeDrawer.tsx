'use client'

import { ACCENTS, FONT_SCALE, type AccentKey, type Density } from '@/lib/theme'
import { iconButtonStyle, Segmented } from '@/components/ui/primitives'
import { useTheme } from './ThemeRoot'

/**
 * Right-anchored 360px customizer. Every change applies live — nothing sits
 * behind a Save button, per the handoff.
 *
 * The Settings page renders this exact control set, so there is one
 * implementation rather than two that drift.
 */
export function CustomizeControls() {
  const { theme, accent, density, fontScale, sidebarCollapsed, update } = useTheme()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Group
        label="ACCENT COLOR"
        hint="Syncrèse teal is this workspace’s default. The other six are the standard enterprise accents."
      >
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
          {(Object.keys(ACCENTS) as AccentKey[]).map((key) => {
            const on = accent === key
            return (
              <button
                key={key}
                type="button"
                title={`${ACCENTS[key].label} · ${ACCENTS[key].hex}`}
                aria-label={ACCENTS[key].label}
                aria-pressed={on}
                onClick={() => update({ accent: key })}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  cursor: 'pointer',
                  border: 'none',
                  background: ACCENTS[key].hex,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  fontSize: 12,
                  boxShadow: on
                    ? `0 0 0 2px var(--pnl), 0 0 0 4px ${ACCENTS[key].hex}`
                    : 'none',
                }}
              >
                {on ? '✓' : ''}
              </button>
            )
          })}
        </div>
      </Group>

      <Group label="APPEARANCE" hint="Dark mode recolors panels, tables and charts.">
        <Segmented
          value={theme}
          onChange={(v) => update({ theme: v })}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </Group>

      <Group label="ROW DENSITY" hint="Compact fits ~40% more rows per screen.">
        <Segmented
          value={density as Density}
          onChange={(v) => update({ density: v })}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'relaxed', label: 'Relaxed' },
          ]}
        />
      </Group>

      <Group label="SIDEBAR" hint="Collapsed shows module codes only.">
        <Segmented
          value={sidebarCollapsed ? 'collapsed' : 'expanded'}
          onChange={(v) => update({ sidebarCollapsed: v === 'collapsed' })}
          options={[
            { value: 'expanded', label: 'Expanded' },
            { value: 'collapsed', label: 'Collapsed' },
          ]}
        />
      </Group>

      <Group label="FONT SIZE" hint="Scales all body and table type.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <input
            type="range"
            min={FONT_SCALE.min}
            max={FONT_SCALE.max}
            step={FONT_SCALE.step}
            value={fontScale}
            aria-label="Font size"
            onChange={(e) => update({ fontScale: Number(e.target.value) })}
            style={{ flex: 1, accentColor: 'var(--ac)', height: 4 }}
          />
          <span
            style={{
              font: '500 11px var(--font-mono), monospace',
              color: 'var(--mut)',
              minWidth: 44,
            }}
          >
            {Math.round(fontScale * 100)}%
          </span>
        </div>
      </Group>
    </div>
  )
}

function Group({
  label,
  hint,
  children,
}: {
  label: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div
        style={{
          font: '500 9.5px var(--font-mono), monospace',
          letterSpacing: '.08em',
          color: 'var(--mut)',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      {children}
      <div style={{ fontSize: 11, color: 'var(--mut)', marginTop: 7 }}>{hint}</div>
    </div>
  )
}

export function CustomizeDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(8,11,17,.3)', zIndex: 80 }}
      />
      <div
        role="dialog"
        aria-label="Customize workspace"
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          bottom: 0,
          width: 360,
          maxWidth: '92vw',
          background: 'var(--pnl)',
          borderLeft: '1px solid var(--bd)',
          zIndex: 90,
          display: 'flex',
          flexDirection: 'column',
          animation: 'slide-in .16s ease',
        }}
      >
        <div
          style={{
            flex: 'none',
            padding: '15px 18px',
            borderBottom: '1px solid var(--bd)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 14, letterSpacing: '-.02em' }}>
            Customize workspace
          </div>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ ...iconButtonStyle, fontFamily: 'inherit' }}
          >
            ✕
          </button>
        </div>
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 18px 28px',
          }}
        >
          <CustomizeControls />
        </div>
      </div>
    </>
  )
}
