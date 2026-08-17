import type { Config } from 'tailwindcss'

/**
 * Design tokens from the handoff spec (docs README.md).
 *
 * Surfaces, accent and density are driven by CSS custom properties set on the
 * app root, because they change at runtime from the Customize drawer (accent,
 * light/dark, density, font scale) and are persisted per user account. Values
 * that never change at runtime — the type scale, radii, shadows — are static
 * here.
 *
 * Nothing in this file approximates the spec. Where the handoff gives an exact
 * value, that exact value is below.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // runtime-themed surfaces
        accent: 'var(--ac)',
        'accent-soft': 'var(--acs)',
        bg: 'var(--bg)',
        panel: 'var(--pnl)',
        fg: 'var(--fg)',
        muted: 'var(--mut)',
        border: 'var(--bd)',
        hover: 'var(--hov)',
        track: 'var(--track)',
        nav: 'var(--nav)',

        // status colours — fixed, never themed. Badges always carry text as
        // well as colour (the handoff calls out teal-vs-blue as the
        // colour-blindness risk); never signal status with colour alone.
        status: {
          success: '#0d9488', // Confirmed, OK, Approved, Paid, Active
          info: '#2563eb', // Open, Released, Key
          neutral: '#64748b', // Draft, Cancelled, Closed, Standard
          cyan: '#0891b2', // Shipped, Received, Posted
          warn: '#b45309', // In production, Low, Awaiting approval, Watchlist
          danger: '#dc2626', // Blocked, Critical, Overdue, Notice
          violet: '#7c3aed', // Partially received, Strategic
        },
      },

      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },

      // The exact scale in use across the handoff.
      fontSize: {
        '9': ['9px', '1.45'],
        '9.5': ['9.5px', '1.45'],
        '10': ['10px', '1.45'],
        '10.5': ['10.5px', '1.45'],
        '11': ['11px', '1.45'],
        '11.5': ['11.5px', '1.45'],
        '12': ['12px', '1.45'],
        '12.4': ['12.4px', '1.45'],
        '12.5': ['12.5px', '1.45'],
        '13': ['13px', '1.45'],
        '14': ['14px', '1.45'],
        '14.5': ['14.5px', '1.45'],
        '15': ['15px', '1.45'],
        '16': ['16px', '1.4'],
        '22': ['22px', '1.2'],
        '26': ['26px', '1.15'],
      },

      letterSpacing: {
        tightest: '-.03em',
        tighter: '-.025em',
        tight: '-.02em',
        snug: '-.015em',
        nudge: '-.01em',
        mono: '.07em',
        monowide: '.08em',
        monowidest: '.09em',
      },

      spacing: {
        '1': '1px',
        '4': '4px',
        '6': '6px',
        '8': '8px',
        '9': '9px',
        '10': '10px',
        '12': '12px',
        '13': '13px',
        '14': '14px',
        '16': '16px',
        '18': '18px',
        '20': '20px',
        // density-driven table cell padding: 6 / 10 / 14
        cell: 'var(--cy)',
        'cell-head': 'calc(var(--cy) + 2px)',
        sidebar: '234px',
        'sidebar-collapsed': '60px',
        drawer: '460px',
        customizer: '360px',
        assistant: '384px',
      },

      borderRadius: {
        checkbox: '3px',
        badge: '4px',
        chip: '5px',
        control: '6px',
        segmented: '7px',
        panel: '8px',
        modal: '10px',
        pill: '9999px',
      },

      boxShadow: {
        dropdown: '0 12px 30px rgba(0,0,0,.16)',
        modal: '0 24px 60px rgba(0,0,0,.32)',
        toast: '0 8px 26px rgba(0,0,0,.28)',
        assistant: '-14px 0 40px rgba(0,0,0,.14)',
        drawer: '-8px 0 20px rgba(0,0,0,.07)',
      },

      transitionDuration: {
        bar: '120ms', // bar + nav colour changes
        panel: '160ms', // sidebar width, drawer slide
        rise: '150ms', // modal / menu / toast fade+rise
      },

      keyframes: {
        'fade-rise': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(18px)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'fade-rise': 'fade-rise .15s ease',
        'slide-in': 'slide-in .16s ease',
      },
    },
  },
  plugins: [],
}

export default config
