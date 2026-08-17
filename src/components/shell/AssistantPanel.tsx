'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { iconButtonStyle } from '@/components/ui/primitives'
import {
  askAssistantAction,
  assistantCapabilityAction,
  type AssistantCapability,
} from '@/app/actions/assistant'

/**
 * "✦ Ask ERP" — 384px right-docked panel, z-index 95, no scrim.
 *
 * Deliberately no scrim: the module stays usable underneath, because this is a
 * work surface used alongside the table rather than a modal. That is the point
 * of the docked design over a floating bubble.
 *
 * WHAT THE PANEL PROMISES, AND HOW IT KEEPS IT
 *
 * Every answer carries a line saying which lookup ran and how many rows came
 * back. That is not decoration: it is the visible end of the audit trail, and
 * it is what lets somebody decide whether to trust a figure without opening the
 * records. An answer with no citation ran no query, and the panel says so.
 *
 * When the grounding check rejects a draft — a figure in it could not be traced
 * to retrieved data — the user sees the refusal and a plain explanation, not a
 * silent retry. Being told "I could not verify this" is recoverable; being
 * given a confident wrong number is not.
 */

type Msg = {
  role: 'user' | 'assistant'
  content: string
  retrievals?: { query: string; rows: number }[]
  grounded?: boolean
}

export function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [capability, setCapability] = useState<AssistantCapability | null>(null)
  const [pending, startTransition] = useTransition()
  const scroller = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open || capability) return
    void assistantCapabilityAction().then((r) => {
      if (r.ok) setCapability(r.data)
    })
  }, [open, capability])

  useEffect(() => {
    if (open) field.current?.focus()
  }, [open])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [messages, pending])

  if (!open) return null

  const send = (text: string) => {
    const question = text.trim()
    if (question === '' || pending) return
    setMessages((prev) => [...prev, { role: 'user', content: question }])
    setInput('')

    startTransition(async () => {
      const result = await askAssistantAction(question, conversationId)
      if (result.ok) {
        setConversationId(result.data.conversationId)
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: result.data.answer,
            retrievals: result.data.retrievals,
            grounded: result.data.grounded,
          },
        ])
      } else {
        setMessages((prev) => [...prev, { role: 'assistant', content: result.error }])
      }
    })
  }

  const noAccess = capability?.lookups === 0

  return (
    <div
      role="complementary"
      aria-label="ERP assistant"
      style={{
        position: 'fixed',
        right: 0,
        top: 0,
        bottom: 0,
        width: 384,
        maxWidth: '92vw',
        background: 'var(--pnl)',
        borderLeft: '1px solid var(--bd)',
        zIndex: 95,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '-14px 0 40px rgba(0,0,0,.14)',
        animation: 'slide-in .16s ease',
      }}
    >
      <div
        style={{
          flex: 'none',
          padding: '13px 16px',
          borderBottom: '1px solid var(--bd)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: 'var(--ac)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            flex: 'none',
          }}
        >
          ✦
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 12.5, letterSpacing: '-.01em' }}>
            ERP Assistant
          </div>
          <div style={{ font: '400 9.5px var(--font-mono), monospace', color: 'var(--mut)' }}>
            Answers only from your own records
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close assistant"
          style={{ ...iconButtonStyle, fontFamily: 'inherit' }}
        >
          ✕
        </button>
      </div>

      <div
        ref={scroller}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {messages.length === 0 && (
          <Bubble>
            {noAccess ? (
              'Your role does not have read access to anything I can look up. An owner or admin can change that in Settings.'
            ) : (
              <>
                Ask about your invoices, customers, ledger or stock. I answer only from records
                I actually retrieve — if I cannot verify a figure against your data, I will say
                so instead of guessing.
                {capability && !capability.hasModel && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ color: 'var(--mut)', fontSize: 11.5, marginBottom: 6 }}>
                      No AI model is configured on this installation, so I answer a fixed set of
                      questions:
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {capability.examples.map((e) => (
                        <button
                          key={e}
                          type="button"
                          onClick={() => send(e)}
                          style={{
                            border: '1px solid var(--bd)',
                            background: 'transparent',
                            color: 'var(--ac)',
                            borderRadius: 6,
                            padding: '3px 8px',
                            fontSize: 11.5,
                            fontFamily: 'inherit',
                            cursor: 'pointer',
                          }}
                        >
                          {e}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </Bubble>
        )}

        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div
              key={i}
              style={{
                alignSelf: 'flex-end',
                maxWidth: '88%',
                padding: '9px 12px',
                fontSize: 12.5,
                lineHeight: 1.5,
                borderRadius: '10px 10px 3px 10px',
                background: 'var(--ac)',
                color: '#fff',
              }}
            >
              {m.content}
            </div>
          ) : (
            <div key={i} style={{ maxWidth: '88%' }}>
              <Bubble warn={m.grounded === false}>
                <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
              </Bubble>
              {/* The visible end of the audit trail. An answer with no citation
                  ran no query, and saying so is more useful than hiding it. */}
              {m.retrievals && (
                <div
                  style={{
                    font: '400 9.5px var(--font-mono), monospace',
                    color: 'var(--mut)',
                    marginTop: 5,
                    paddingLeft: 2,
                  }}
                >
                  {m.retrievals.length === 0
                    ? 'no records retrieved'
                    : m.retrievals
                        .map((r) => `${r.query} · ${r.rows} row${r.rows === 1 ? '' : 's'}`)
                        .join('  |  ')}
                </div>
              )}
            </div>
          ),
        )}

        {pending && (
          <Bubble>
            <span style={{ color: 'var(--mut)' }}>Looking it up…</span>
          </Bubble>
        )}
      </div>

      <div
        style={{
          flex: 'none',
          padding: '11px 16px 14px',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <input
          ref={field}
          value={input}
          disabled={noAccess}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(input)
            }
          }}
          placeholder="Find an invoice, partner, journal entry…"
          aria-label="Ask the assistant"
          style={{
            flex: 1,
            height: 34,
            borderRadius: 8,
            border: '1px solid var(--bd)',
            background: 'var(--pnl)',
            color: 'var(--fg)',
            padding: '0 11px',
            fontSize: 12.5,
            fontFamily: 'inherit',
            outline: 'none',
            opacity: noAccess ? 0.6 : 1,
          }}
        />
        <button
          type="button"
          onClick={() => send(input)}
          disabled={pending || noAccess || input.trim() === ''}
          aria-label="Send"
          style={{
            width: 34,
            height: 34,
            flex: 'none',
            borderRadius: 8,
            background: 'var(--ac)',
            color: '#fff',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            cursor: pending || noAccess ? 'default' : 'pointer',
            opacity: pending || noAccess || input.trim() === '' ? 0.5 : 1,
          }}
        >
          ↑
        </button>
      </div>
    </div>
  )
}

function Bubble({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <div
      style={{
        maxWidth: warn ? '100%' : '88%',
        padding: '9px 12px',
        fontSize: 12.5,
        lineHeight: 1.5,
        borderRadius: '10px 10px 10px 3px',
        background: warn ? 'color-mix(in srgb, var(--warn) 10%, var(--hov))' : 'var(--hov)',
        border: `1px solid ${warn ? 'var(--warn)' : 'var(--bd)'}`,
      }}
    >
      {children}
    </div>
  )
}
