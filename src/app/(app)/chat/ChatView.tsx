'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Badge,
  chipButtonStyle,
  inputStyle,
  panelStyle,
  primaryButtonStyle,
} from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import type { ChannelSummary, ChatMessage } from '@/chat/service'
import {
  loadMessages,
  markRead,
  newChannel,
  newDirectMessage,
  sendMessage,
} from '@/app/actions/chat'

type Member = { id: string; name: string | null; email: string; handle: string }

/**
 * Team chat (MUST DO #13).
 *
 * Two panes: conversations on the left, the thread on the right. Deliberately
 * not a Slack clone — no threads, no reactions, no emoji picker. The one thing
 * it does that an external chat tool cannot is turn `INV-00042` into a link
 * straight to the record.
 */
export function ChatView({
  channels,
  members,
  activeId,
  messages: initialMessages,
  currentUserId,
}: {
  channels: ChannelSummary[]
  members: Member[]
  activeId: string | null
  messages: ChatMessage[]
  currentUserId: string
}) {
  const router = useRouter()
  const params = useSearchParams()
  const toast = useToast()

  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [composing, setComposing] = useState(false)
  const [channelName, setChannelName] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const active = channels.find((c) => c.id === activeId) ?? null

  useEffect(() => {
    setMessages(initialMessages)
  }, [initialMessages])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(scrollToBottom, [messages, scrollToBottom])

  // Mark read on open, so a channel you are looking at does not keep nagging.
  useEffect(() => {
    if (activeId) void markRead(activeId)
  }, [activeId])

  /**
   * Live updates over SSE.
   *
   * EventSource reconnects on its own, so a dropped connection or the server
   * closing the stream at its lifetime cap recovers without any code here.
   */
  useEffect(() => {
    const source = new EventSource('/api/chat/stream')

    source.addEventListener('messages', (event) => {
      const incoming = JSON.parse((event as MessageEvent).data) as (ChatMessage & {
        channelId: string
      })[]
      const forThisChannel = incoming.filter((m) => m.channelId === activeId)
      if (forThisChannel.length === 0) {
        // Something arrived elsewhere — refresh so the sidebar badge updates.
        router.refresh()
        return
      }
      setMessages((current) => {
        const seen = new Set(current.map((m) => m.id))
        const fresh = forThisChannel
          .filter((m) => !seen.has(m.id))
          .map((m) => ({ ...m, refs: m.refs ?? [], deletedAt: null, editedAt: null }))
        return fresh.length ? [...current, ...fresh] : current
      })
      void markRead(activeId!)
    })

    source.addEventListener('notifications', (event) => {
      const notes = JSON.parse((event as MessageEvent).data) as { title: string; body: string }[]
      for (const n of notes) toast(`${n.title}: ${n.body ?? ''}`.slice(0, 90))
      router.refresh()
    })

    return () => source.close()
  }, [activeId, router, toast])

  const openChannel = (id: string) => {
    const next = new URLSearchParams(params.toString())
    next.set('channel', id)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  const send = async () => {
    const body = draft.trim()
    if (!body || !activeId || sending) return
    setSending(true)
    const result = await sendMessage(activeId, body)
    setSending(false)

    if (!result.ok) {
      toast(result.error, 'err')
      return
    }
    setDraft('')
    // Pull immediately rather than waiting for the next stream tick, so your
    // own message appears instantly.
    const refreshed = await loadMessages(activeId)
    if (refreshed.ok && refreshed.data) setMessages(refreshed.data)
    router.refresh()
  }

  const createNamedChannel = async () => {
    const name = channelName.trim()
    if (!name) return
    const result = await newChannel({ name })
    if (result.ok) {
      toast(`#${name} created`)
      setChannelName('')
      setComposing(false)
      router.refresh()
      if (result.data) openChannel(result.data.id)
    } else toast(result.error, 'err')
  }

  const startDm = async (userId: string) => {
    const result = await newDirectMessage(userId)
    if (result.ok && result.data) {
      router.refresh()
      openChannel(result.data.id)
    } else if (!result.ok) toast(result.error, 'err')
  }

  const dmCandidates = useMemo(
    () =>
      members.filter(
        (m) =>
          m.id !== currentUserId &&
          !channels.some((c) => c.type === 'dm' && c.counterpartName === (m.name ?? m.email)),
      ),
    [members, channels, currentUserId],
  )

  return (
    <div style={{ display: 'flex', gap: 12, height: 'calc(100vh - 108px)', minHeight: 420 }}>
      {/* Conversations */}
      <aside
        style={{
          ...panelStyle,
          width: 260,
          flex: 'none',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '11px 13px',
            borderBottom: '1px solid var(--bd)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 12.5 }}>Conversations</span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setComposing((v) => !v)}
            aria-label="New channel"
            style={{ ...chipButtonStyle, height: 22, fontFamily: 'inherit' }}
          >
            {composing ? '✕' : '+'}
          </button>
        </div>

        {composing && (
          <div style={{ padding: 10, borderBottom: '1px solid var(--bd)' }}>
            <input
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void createNamedChannel()}
              placeholder="channel name"
              style={inputStyle}
            />
            <button
              type="button"
              onClick={createNamedChannel}
              style={{ ...primaryButtonStyle, marginTop: 8, width: '100%', justifyContent: 'center', fontFamily: 'inherit' }}
            >
              Create channel
            </button>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
          {channels.length === 0 && (
            <p style={{ fontSize: 11.5, color: 'var(--mut)', padding: '8px 7px' }}>
              No conversations yet. Create a channel, or start a direct message below.
            </p>
          )}

          {channels.map((c) => {
            const on = c.id === activeId
            const label = c.type === 'dm' ? (c.counterpartName ?? 'Direct message') : `# ${c.name}`
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => openChannel(c.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '7px 8px',
                  borderRadius: 6,
                  border: 'none',
                  background: on ? 'var(--acs)' : 'transparent',
                  color: on ? 'var(--ac)' : 'var(--fg)',
                  fontWeight: on || c.unreadCount > 0 ? 600 : 400,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {label}
                </span>
                {c.mentionCount > 0 && <Badge color="#dc2626">@{c.mentionCount}</Badge>}
                {c.unreadCount > 0 && c.mentionCount === 0 && (
                  <span
                    style={{
                      font: '600 10px var(--font-mono), monospace',
                      background: 'var(--ac)',
                      color: '#fff',
                      borderRadius: 9,
                      padding: '1px 6px',
                    }}
                  >
                    {c.unreadCount}
                  </span>
                )}
              </button>
            )
          })}

          {dmCandidates.length > 0 && (
            <>
              <div
                style={{
                  font: '500 9.5px var(--font-mono), monospace',
                  letterSpacing: '.08em',
                  color: 'var(--mut)',
                  padding: '12px 8px 5px',
                }}
              >
                START A DM
              </div>
              {dmCandidates.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => startDm(m.id)}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '6px 8px',
                    borderRadius: 6,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--mut)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 12,
                    textAlign: 'left',
                  }}
                >
                  {m.name ?? m.email}
                </button>
              ))}
            </>
          )}
        </div>
      </aside>

      {/* Thread */}
      <section style={{ ...panelStyle, flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {!active ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--mut)',
              fontSize: 12.5,
            }}
          >
            Pick a conversation, or start one.
          </div>
        ) : (
          <>
            <header
              style={{
                padding: '11px 14px',
                borderBottom: '1px solid var(--bd)',
                display: 'flex',
                alignItems: 'baseline',
                gap: 9,
              }}
            >
              <span style={{ fontWeight: 600, fontSize: 12.5 }}>
                {active.type === 'dm' ? (active.counterpartName ?? 'Direct message') : `# ${active.name}`}
              </span>
              <span style={{ font: '400 10px var(--font-mono), monospace', color: 'var(--mut)' }}>
                {active.type === 'dm'
                  ? 'direct message'
                  : `${active.memberCount} member${active.memberCount === 1 ? '' : 's'}`}
                {active.topic ? ` · ${active.topic}` : ''}
              </span>
            </header>

            <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
              {messages.length === 0 && (
                <p style={{ fontSize: 12, color: 'var(--mut)' }}>
                  Nothing here yet. Mention a colleague with <code>@name</code>, or reference a
                  record like <code>INV-00042</code> to link straight to it.
                </p>
              )}

              {messages.map((m, i) => {
                const mine = m.userId === currentUserId
                const sameAuthorAsPrevious = i > 0 && messages[i - 1]!.userId === m.userId
                return (
                  <div key={m.id} style={{ marginTop: sameAuthorAsPrevious ? 4 : 12 }}>
                    {!sameAuthorAsPrevious && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: 8,
                          marginBottom: 3,
                        }}
                      >
                        <span style={{ fontWeight: 600, fontSize: 12 }}>
                          {mine ? 'You' : (m.authorName ?? 'Someone')}
                        </span>
                        <span
                          style={{
                            font: '400 9.5px var(--font-mono), monospace',
                            color: 'var(--mut)',
                          }}
                        >
                          {new Date(m.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                    )}

                    {m.deletedAt ? (
                      <div style={{ fontSize: 12.5, color: 'var(--mut)', fontStyle: 'italic' }}>
                        Message deleted
                      </div>
                    ) : (
                      <div style={{ fontSize: 12.5, lineHeight: 1.5, wordBreak: 'break-word' }}>
                        <MessageBody body={m.body} refs={m.refs} />
                        {m.editedAt && (
                          <span
                            style={{
                              font: '400 9.5px var(--font-mono), monospace',
                              color: 'var(--mut)',
                              marginLeft: 6,
                            }}
                          >
                            (edited)
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div
              style={{
                flex: 'none',
                padding: '10px 14px 12px',
                borderTop: '1px solid var(--bd)',
                display: 'flex',
                gap: 8,
                alignItems: 'flex-end',
              }}
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                rows={1}
                placeholder="Message… @mention someone, or reference INV-00042"
                aria-label="Message"
                style={{
                  ...inputStyle,
                  height: 'auto',
                  minHeight: 34,
                  maxHeight: 120,
                  padding: '8px 10px',
                  resize: 'vertical',
                  fontSize: 12.5,
                }}
              />
              <button
                type="button"
                onClick={send}
                disabled={sending || !draft.trim()}
                style={{
                  ...primaryButtonStyle,
                  height: 34,
                  fontFamily: 'inherit',
                  opacity: sending || !draft.trim() ? 0.5 : 1,
                }}
              >
                Send
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

/**
 * Renders a message, turning resolved record references into links.
 *
 * Only references the SERVER resolved become links — the client never guesses
 * at a URL, so a reference to a record that does not exist stays plain text
 * rather than becoming a dead link.
 */
function MessageBody({ body, refs }: { body: string; refs: ChatMessage['refs'] }) {
  if (refs.length === 0) return <>{body}</>

  const byLabel = new Map(refs.map((r) => [r.label.toUpperCase(), r]))
  const pattern = new RegExp(
    `\\b(${refs.map((r) => r.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
    'gi',
  )

  const parts: React.ReactNode[] = []
  let last = 0
  for (const match of body.matchAll(pattern)) {
    const start = match.index!
    if (start > last) parts.push(body.slice(last, start))
    const ref = byLabel.get(match[0]!.toUpperCase())
    parts.push(
      ref ? (
        <Link
          key={`${ref.entityId}-${start}`}
          href={`/${ref.module}?record=${ref.entityId}`}
          style={{
            color: 'var(--ac)',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '.94em',
            textDecoration: 'none',
            borderBottom: '1px solid var(--acs)',
          }}
        >
          {match[0]}
        </Link>
      ) : (
        match[0]
      ),
    )
    last = start + match[0]!.length
  }
  if (last < body.length) parts.push(body.slice(last))

  return <>{parts}</>
}
