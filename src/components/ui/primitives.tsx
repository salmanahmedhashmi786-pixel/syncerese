'use client'

import type { CSSProperties, ReactNode } from 'react'

/**
 * Shared control primitives, at the exact dimensions the handoff specifies.
 *
 * These are inline-styled rather than Tailwind classes because every one of
 * them reads runtime CSS variables that change from the Customize drawer
 * (accent, borders, density). Keeping the token lookup in one place per
 * primitive is what stops the accent from being right in eight components and
 * subtly wrong in the ninth.
 */

export const iconButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  flex: 'none',
  borderRadius: 6,
  border: '1px solid var(--bd)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  fontSize: 12,
  color: 'var(--mut)',
  background: 'transparent',
}

export const chipButtonStyle: CSSProperties = {
  height: 26,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid var(--bd)',
  display: 'inline-flex',
  alignItems: 'center',
  cursor: 'pointer',
  fontSize: 11.5,
  color: 'var(--fg)',
  background: 'transparent',
  whiteSpace: 'nowrap',
}

export const primaryButtonStyle: CSSProperties = {
  height: 28,
  padding: '0 12px',
  borderRadius: 6,
  background: 'var(--ac)',
  color: '#fff',
  border: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

export const accentChipStyle: CSSProperties = {
  height: 28,
  padding: '0 11px',
  borderRadius: 6,
  border: '1px solid var(--ac)',
  color: 'var(--ac)',
  background: 'var(--acs)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 500,
  whiteSpace: 'nowrap',
}

export const inputStyle: CSSProperties = {
  width: '100%',
  height: 30,
  borderRadius: 6,
  border: '1px solid var(--bd)',
  background: 'var(--pnl)',
  color: 'var(--fg)',
  padding: '0 9px',
  fontSize: 12,
  fontFamily: 'inherit',
  outline: 'none',
}

export const panelStyle: CSSProperties = {
  background: 'var(--pnl)',
  border: '1px solid var(--bd)',
  borderRadius: 8,
  overflow: 'hidden',
}

/** 14×14, radius 3. Checked = accent fill + white tick. */
export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label?: string
}) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation()
        onChange()
      }}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          onChange()
        }
      }}
      style={{
        width: 14,
        height: 14,
        borderRadius: 3,
        border: `1px solid ${checked ? 'var(--ac)' : 'var(--bd)'}`,
        background: checked ? 'var(--ac)' : 'transparent',
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 9,
        cursor: 'pointer',
        flex: 'none',
      }}
    >
      {checked ? '✓' : ''}
    </span>
  )
}

/**
 * Status badge. Colour at 11% alpha (20% in dark) behind the same colour as
 * text — and ALWAYS with the label, never colour alone. The handoff calls out
 * teal-vs-blue as the colour-blindness risk in this palette.
 */
export function Badge({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 7px',
        borderRadius: 4,
        fontSize: '.86em',
        fontWeight: 600,
        color,
        background: hexAlpha(color, 0.13),
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

export function hexAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/** Inline-flex, 1px border, radius 7, overflow hidden; active segment is a
 *  solid accent fill with white 600 text. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        border: '1px solid var(--bd)',
        borderRadius: 7,
        overflow: 'hidden',
        background: 'var(--pnl)',
      }}
    >
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              padding: '6px 13px',
              fontSize: 11.5,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              fontWeight: on ? 600 : 400,
              background: on ? 'var(--ac)' : 'transparent',
              color: on ? '#fff' : 'var(--fg)',
              border: 'none',
              borderRight: i < options.length - 1 ? '1px solid var(--bd)' : 'none',
              fontFamily: 'inherit',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function PanelHeader({ title, note }: { title: string; note?: string }) {
  return (
    <div style={{ padding: '11px 13px 0', minWidth: 0 }}>
      <div
        style={{
          fontWeight: 600,
          fontSize: 12.5,
          letterSpacing: '-.01em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </div>
      {note ? (
        <div
          style={{
            font: '400 10px var(--font-mono), monospace',
            color: 'var(--mut)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            marginTop: 2,
          }}
        >
          {note}
        </div>
      ) : null}
    </div>
  )
}
