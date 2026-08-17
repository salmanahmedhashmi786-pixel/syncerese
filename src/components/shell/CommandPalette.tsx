'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, inputStyle } from '@/components/ui/primitives'
import { STATUS_COLOR, statusLabel, moduleById } from '@/modules/registry'
import { formatMoneyClient } from '@/components/table/format'
import { search } from '@/app/actions/admin'
import type { SearchResult } from '@/modules/search'

/**
 * Global search (MUST DO #11).
 *
 * Opens on ⌘K / Ctrl-K, or `/` when focus is not already in a field. Results
 * are permission-filtered on the server — a module the caller cannot read is
 * never queried, so nothing leaks through a title or an amount.
 *
 * Selecting a result deep-links to its module with the record drawer already
 * open, which is the whole point: search is a way to get to a record, not a
 * place to read about one.
 */
export function CommandPalette({ locale, currency }: { locale: string; currency: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)

      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen(true)
      } else if (e.key === '/' && !typing && !open) {
        e.preventDefault()
        setOpen(true)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 20)
    else {
      setQuery('')
      setResult(null)
      setCursor(0)
    }
  }, [open])

  // Debounced so a five-character query is one round trip, not five.
  useEffect(() => {
    if (!open) return
    if (query.trim().length < 2) {
      setResult(null)
      return
    }
    setBusy(true)
    const timer = setTimeout(async () => {
      const r = await search(query)
      setResult(r)
      setCursor(0)
      setBusy(false)
    }, 180)
    return () => clearTimeout(timer)
  }, [query, open])

  if (!open) return null

  const hits = result?.hits ?? []

  const go = (index: number) => {
    const hit = hits[index]
    if (!hit) return
    setOpen(false)
    router.push(`/${hit.module}?record=${hit.id}`)
  }

  return (
    <>
      <div
        onClick={() => setOpen(false)}
        style={{ position: 'fixed', inset: 0, background: 'rgba(8,11,17,.42)', zIndex: 110 }}
      />
      <div
        role="dialog"
        aria-label="Search everything"
        style={{
          position: 'fixed',
          left: '50%',
          top: '12vh',
          transform: 'translateX(-50%)',
          width: 620,
          maxWidth: '92vw',
          background: 'var(--pnl)',
          border: '1px solid var(--bd)',
          borderRadius: 10,
          zIndex: 115,
          boxShadow: '0 24px 60px rgba(0,0,0,.32)',
          animation: 'fade-rise .15s ease',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: 12, borderBottom: '1px solid var(--bd)' }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(c + 1, hits.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                go(cursor)
              }
            }}
            placeholder="Search invoices, orders, customers, products…"
            aria-label="Search everything"
            style={{ ...inputStyle, height: 38, fontSize: 13.5 }}
          />
        </div>

        <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
          {query.trim().length < 2 && (
            <Hint>Type at least two characters. ↑↓ to move, ↵ to open, esc to close.</Hint>
          )}
          {query.trim().length >= 2 && busy && <Hint>Searching…</Hint>}
          {query.trim().length >= 2 && !busy && hits.length === 0 && (
            <Hint>Nothing matched &ldquo;{query.trim()}&rdquo;.</Hint>
          )}

          {hits.map((hit, i) => {
            const module = moduleById(hit.module)
            return (
              <button
                key={`${hit.module}-${hit.id}`}
                type="button"
                onClick={() => go(i)}
                onMouseEnter={() => setCursor(i)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '9px 13px',
                  border: 'none',
                  borderBottom: '1px solid var(--bd)',
                  background: i === cursor ? 'var(--acs)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                  color: 'var(--fg)',
                }}
              >
                <span
                  style={{
                    font: '500 9.5px var(--font-mono), monospace',
                    width: 22,
                    height: 18,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 4,
                    background: 'var(--acs)',
                    color: 'var(--ac)',
                    flex: 'none',
                  }}
                >
                  {module?.code ?? '··'}
                </span>
                <span
                  style={{
                    font: '500 11px var(--font-mono), monospace',
                    color: 'var(--ac)',
                    flex: 'none',
                  }}
                >
                  {hit.reference}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {hit.title}
                </span>
                {hit.status && (
                  <Badge color={STATUS_COLOR[hit.status] ?? '#64748b'}>
                    {statusLabel(hit.status)}
                  </Badge>
                )}
                {hit.amountMinor !== null && (
                  <span
                    style={{
                      font: '500 11px var(--font-mono), monospace',
                      color: 'var(--mut)',
                      flex: 'none',
                    }}
                  >
                    {formatMoneyClient(hit.amountMinor, hit.currencyCode ?? currency, locale)}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {result && result.truncated && (
          <div
            style={{
              padding: '8px 13px',
              font: '400 10.5px var(--font-mono), monospace',
              color: 'var(--mut)',
              borderTop: '1px solid var(--bd)',
            }}
          >
            Showing the closest matches only — refine the search to narrow it.
          </div>
        )}
      </div>
    </>
  )
}

const Hint = ({ children }: { children: React.ReactNode }) => (
  <div style={{ padding: '18px 13px', fontSize: 12, color: 'var(--mut)' }}>{children}</div>
)
