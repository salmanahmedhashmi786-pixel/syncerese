'use client'

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { useTheme } from './ThemeRoot'

export type ToastKind = 'ok' | 'warn' | 'err'
type Toast = { id: number; text: string; kind: ToastKind }

const ToastContext = createContext<((text: string, kind?: ToastKind) => void) | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside Toaster')
  return ctx
}

const DOT: Record<ToastKind, string> = {
  ok: '#34d399',
  warn: '#fbbf24',
  err: '#f87171',
}

/** Auto-dismiss after 3200ms, per the handoff. */
const DISMISS_MS = 3200

export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback((text: string, kind: ToastKind = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), DISMISS_MS)
  }, [])

  return (
    <ToastContext.Provider value={push}>
      {children}
      <ToastStack toasts={toasts} />
    </ToastContext.Provider>
  )
}

function ToastStack({ toasts }: { toasts: Toast[] }) {
  const { theme } = useTheme()
  return (
    <div
      // Screen readers should hear these; they are the only confirmation that
      // an inline edit or a bulk action actually landed.
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 18,
        bottom: 18,
        zIndex: 120,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        alignItems: 'flex-end',
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            background: theme === 'dark' ? '#1b2330' : '#111725',
            color: '#fff',
            padding: '9px 14px',
            borderRadius: 8,
            fontSize: 12,
            boxShadow: '0 8px 26px rgba(0,0,0,.28)',
            animation: 'fade-rise .16s ease',
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: DOT[t.kind],
              flex: 'none',
            }}
          />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}
