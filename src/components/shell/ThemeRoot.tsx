'use client'

import { createContext, useContext, useState, useTransition, type ReactNode } from 'react'
import { themeVars, type AccentKey, type Density } from '@/lib/theme'
import type { Preferences } from '@/server/session'
import { savePreferences } from '@/app/actions/preferences'

type ThemeState = Pick<
  Preferences,
  'theme' | 'accent' | 'density' | 'fontScale' | 'sidebarCollapsed'
>

type ThemeContextValue = ThemeState & {
  update: (patch: Partial<ThemeState>) => void
  pending: boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeRoot')
  return ctx
}

/**
 * Applies the design token system as CSS custom properties, and owns
 * appearance state.
 *
 * Initial values are rendered on the SERVER from the user's saved preferences,
 * so the first paint is already correct. A client-side theme read would flash
 * the default palette on every navigation, which on a dark theme is genuinely
 * unpleasant.
 *
 * Changes apply optimistically and persist server-side per user account (MUST
 * DO #17), so they follow the person to the desktop app rather than living in
 * one browser's localStorage.
 */
export function ThemeRoot({
  initial,
  children,
}: {
  initial: ThemeState
  children: ReactNode
}) {
  const [pending, startTransition] = useTransition()

  // Local state, seeded from the server-rendered preference.
  //
  // NOT useOptimistic: every value here is a client-side CSS variable, so
  // nothing on the server needs to re-render for the change to take effect.
  // useOptimistic would show the new theme for the duration of the action and
  // then snap back to the stale server prop, because no re-render supplies an
  // updated one.
  //
  // The write is fire-and-forget by design — the UI must not wait on a round
  // trip to recolour. A failed save costs the user their preference on next
  // load, which is a far better failure than a laggy toggle.
  const [state, setState] = useState<ThemeState>(initial)

  const update = (patch: Partial<ThemeState>) => {
    setState((current) => ({ ...current, ...patch }))
    startTransition(async () => {
      await savePreferences(patch)
    })
  }

  const vars = themeVars({
    accent: state.accent as AccentKey,
    dark: state.theme === 'dark',
    density: state.density as Density,
    fontScale: state.fontScale,
  })

  return (
    <ThemeContext.Provider value={{ ...state, update, pending }}>
      <div
        data-theme={state.theme}
        style={{
          ...(vars as React.CSSProperties),
          background: 'var(--bg)',
          color: 'var(--fg)',
          fontSize: 'var(--fs)',
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'stretch',
        }}
      >
        {children}
      </div>
    </ThemeContext.Provider>
  )
}
