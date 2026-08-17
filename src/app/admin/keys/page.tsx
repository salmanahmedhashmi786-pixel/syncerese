import { auth } from '@/auth'
import { db } from '@/db'
import { listKeys, listOrganizations } from '@/licensing/platform'
import { KeyIssuer } from './KeyIssuer'

export const metadata = { title: 'Product keys' }
export const dynamic = 'force-dynamic'

export default async function AdminKeysPage() {
  // The layout has already established that this is a platform admin; the
  // functions below re-check it in the database regardless.
  const session = await auth()
  const userId = session!.user!.id!
  const handle = await db()

  const [organizations, keys] = await Promise.all([
    listOrganizations(handle, userId),
    listKeys(handle, userId),
  ])

  return <KeyIssuer organizations={organizations} keys={keys} />
}
