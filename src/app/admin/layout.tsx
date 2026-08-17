import Image from 'next/image'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { db } from '@/db'
import { isPlatformAdmin } from '@/licensing/platform'
import { Toaster } from '@/components/shell/Toaster'
import { ThemeRoot } from '@/components/shell/ThemeRoot'
import { DEFAULT_PREFERENCES } from '@/server/session'

export const dynamic = 'force-dynamic'

/**
 * The vendor's own area, deliberately outside the tenant application.
 *
 * Its own route group, its own frame, no organization switcher and no tenant
 * navigation — because nothing here belongs to a tenant. Somebody who is both a
 * customer and the vendor should be in no doubt about which hat they are
 * wearing.
 *
 * The gate is here AND in every action beneath it. This one stops the page
 * rendering; the ones in the actions are what actually protect the data, since
 * a server action is reachable without ever loading this layout.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  const userId = session?.user?.id ?? null

  if (!userId) redirect('/sign-in?callbackUrl=/admin/keys')

  const handle = await db()
  if (!(await isPlatformAdmin(handle, userId))) {
    // To the dashboard, not to a "forbidden" page. Confirming that a platform
    // admin area exists is itself information a tenant user does not need.
    redirect('/dashboard')
  }

  return (
    // ThemeRoot AND Toaster, because this area lives outside the (app) layout
    // that normally provides them — the shared primitives read theme variables
    // from one and useToast requires the other. Both threw on the first load.
    //
    // Fixed defaults rather than the vendor's saved preferences: the licensing
    // console is not their workspace, and it should look the same whoever opens
    // it.
    <ThemeRoot initial={DEFAULT_PREFERENCES}>
     <Toaster>
      <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 22px',
          borderBottom: '1px solid var(--bd)',
          // Visibly not the tenant app.
          background: 'var(--nav)',
          color: '#fff',
        }}
      >
        <Image src="/syncrese-mark.png" alt="" width={26} height={26} />
        <div style={{ fontWeight: 600, fontSize: 14, letterSpacing: '-.02em' }}>
          Syncrèse · Licensing
        </div>
        <div
          style={{
            font: '500 9px var(--font-mono), monospace',
            letterSpacing: '.1em',
            padding: '2px 7px',
            borderRadius: 4,
            background: 'rgba(255,255,255,.14)',
          }}
        >
          VENDOR
        </div>
        <div style={{ flex: 1 }} />
        <Link href="/admin/keys" style={{ color: '#fff', fontSize: 12.5, opacity: 0.85 }}>
          Product keys
        </Link>
        <Link href="/dashboard" style={{ color: '#fff', fontSize: 12.5, opacity: 0.85 }}>
          Back to the app
        </Link>
      </header>

      <main style={{ padding: '22px', maxWidth: 1080, margin: '0 auto' }}>{children}</main>
      </div>
     </Toaster>
    </ThemeRoot>
  )
}
