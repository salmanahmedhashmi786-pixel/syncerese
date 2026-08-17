import { getSession, tenantQuery } from '@/server/session'
import { listChannels, listMessages, listOrganizationMembers } from '@/chat/service'
import { ChatView } from './ChatView'

export const metadata = { title: 'Team chat' }
export const dynamic = 'force-dynamic'

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { ctx } = await getSession()
  if (!ctx) return null

  const sp = await searchParams
  const requested = Array.isArray(sp.channel) ? sp.channel[0] : sp.channel

  const data = await tenantQuery(async (tx) => {
    const channels = await listChannels(tx, ctx)
    const members = await listOrganizationMembers(tx, ctx)

    // Fall back to the most recently active channel the user belongs to, so
    // opening /chat lands somewhere useful rather than on an empty pane.
    const activeId =
      channels.find((c) => c.id === requested)?.id ?? channels[0]?.id ?? null

    const messages = activeId ? await listMessages(tx, ctx, activeId) : []

    return { channels, members, activeId, messages }
  })

  return <ChatView {...data} currentUserId={ctx.userId} />
}
