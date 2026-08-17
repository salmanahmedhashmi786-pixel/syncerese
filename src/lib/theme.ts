/**
 * Design tokens — single source of truth, mirrored into CSS custom properties
 * at runtime (see globals.css and the theme provider in step 4).
 */

export type AccentKey =
  | 'syncrese'
  | 'blue'
  | 'indigo'
  | 'teal'
  | 'violet'
  | 'amber'
  | 'graphite'

/**
 * Seven accents: the handoff's six, plus Syncrèse teal.
 *
 * `syncrese` is drawn from the logo's teal-to-navy gradient and is the DEFAULT
 * FOR NEW TENANTS (confirmed decision); the other six remain user choices, with
 * Blue still the handoff's neutral reference.
 *
 * The value is #2A7B94 rather than a brighter sample from the mark. The accent
 * is used as a solid fill behind white text (primary buttons, active nav), and
 * the logo's lighter teals fail WCAG AA there — #3080A0 lands near 4.46:1,
 * under the 4.5:1 floor. #2A7B94 clears it while staying on-brand. Any future
 * accent must be checked the same way before it ships.
 */
export const ACCENTS: Record<AccentKey, { label: string; hex: string }> = {
  syncrese: { label: 'Syncrèse', hex: '#2a7b94' },
  blue: { label: 'Blue', hex: '#2563eb' },
  indigo: { label: 'Indigo', hex: '#4f46e5' },
  teal: { label: 'Teal', hex: '#0d9488' },
  violet: { label: 'Violet', hex: '#7c3aed' },
  amber: { label: 'Amber', hex: '#b45309' },
  graphite: { label: 'Graphite', hex: '#334155' },
}

export const DEFAULT_ACCENT: AccentKey = 'syncrese'

export type Density = 'compact' | 'comfortable' | 'relaxed'

/** Vertical cell padding in px. Header cells add 2. */
export const DENSITY_PADDING: Record<Density, number> = {
  compact: 6,
  comfortable: 10,
  relaxed: 14,
}

/** Base body size in px before the font scale multiplier. */
export const DENSITY_BASE_FONT: Record<Density, number> = {
  compact: 12.5,
  comfortable: 13.5,
  relaxed: 13.5,
}

export const FONT_SCALE = { min: 0.85, max: 1.3, step: 0.05, default: 1 } as const

/** Status colours. Badges always carry text as well as colour — the handoff
 *  flags teal-vs-blue as the colour-blindness risk, so colour alone never
 *  signals state. */
export const STATUS_COLORS = {
  success: '#0d9488',
  info: '#2563eb',
  neutral: '#64748b',
  cyan: '#0891b2',
  warn: '#b45309',
  danger: '#dc2626',
  violet: '#7c3aed',
} as const

export function hexAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/** The CSS custom properties the whole UI reads from. */
export function themeVars(opts: {
  accent: AccentKey
  dark: boolean
  density: Density
  fontScale: number
}): Record<string, string> {
  const ac = ACCENTS[opts.accent]?.hex ?? ACCENTS[DEFAULT_ACCENT].hex
  const d = opts.dark
  return {
    '--ac': ac,
    '--acs': hexAlpha(ac, d ? 0.22 : 0.12),
    '--bg': d ? '#0d1117' : '#f6f7f9',
    '--pnl': d ? '#151b24' : '#ffffff',
    '--fg': d ? '#e7eaf0' : '#14181f',
    '--mut': d ? '#8b93a3' : '#6b7382',
    '--bd': d ? '#242c38' : '#e3e6eb',
    '--hov': d ? 'rgba(255,255,255,.045)' : 'rgba(0,0,0,.028)',
    '--track': d ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)',
    // The sidebar is dark in BOTH themes — this is intentional in the handoff.
    '--nav': d ? '#080b11' : '#111725',
    '--cy': `${DENSITY_PADDING[opts.density]}px`,
    '--fs': `${(DENSITY_BASE_FONT[opts.density] * opts.fontScale).toFixed(2)}px`,
  }
}
