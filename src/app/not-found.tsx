import Link from 'next/link'
import { panelStyle } from '@/components/ui/primitives'

/**
 * The 404 page.
 *
 * Its absence was a build failure, not a cosmetic gap. Without an App Router
 * `not-found`, Next falls back to the Pages Router error page and prerenders it
 * — which raises "`<Html>` should not be imported outside of pages/_document"
 * and takes `next build` down with it. The message names neither this file nor
 * the reason, and `next dev` never renders that fallback, so nothing shows up
 * until the first production build.
 *
 * `notFound()` is called from real places — a module the role cannot read, an
 * invoice in another tenant — so this is also what a permission denial looks
 * like. It says nothing about whether the thing exists: confirming that a
 * record is there but forbidden is an information leak in a multi-tenant
 * product, and the sign-in page takes the same care for the same reason.
 */
export const metadata = { title: 'Not found' }

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        padding: 20,
      }}
    >
      <div style={{ ...panelStyle, padding: '26px 28px', maxWidth: 420, textAlign: 'center' }}>
        <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: '-.03em' }}>404</div>
        <div style={{ fontWeight: 600, fontSize: 15, marginTop: 4 }}>
          That page is not here
        </div>
        <p style={{ color: 'var(--mut)', fontSize: 12.5, lineHeight: 1.6, marginTop: 10 }}>
          The link may be out of date, or the record may belong to a workspace this account
          cannot see.
        </p>
        <Link
          href="/dashboard"
          style={{
            display: 'inline-block',
            marginTop: 16,
            color: 'var(--ac)',
            fontSize: 12.5,
            textDecoration: 'none',
          }}
        >
          Back to the dashboard
        </Link>
      </div>
    </main>
  )
}
