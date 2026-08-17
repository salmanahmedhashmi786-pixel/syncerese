import { redirect } from 'next/navigation'
import { getSession } from '@/server/session'

export const dynamic = 'force-dynamic'

export default async function Root() {
  const { ctx } = await getSession()
  redirect(ctx ? '/dashboard' : '/sign-in')
}
