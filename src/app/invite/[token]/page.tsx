import Image from 'next/image'
import Link from 'next/link'
import { auth } from '@/auth'
import { db } from '@/db'
import { resolveInvitation } from '@/server/members'
import { panelStyle } from '@/components/ui/primitives'
import { AcceptInviteForm } from './AcceptInviteForm'

export const metadata = { title: 'Join' }
export const dynamic = 'force-dynamic'

/**
 * The invitation landing page.
 *
 * Reached by someone who may have no account, so it sits outside the
 * authenticated `(app)` group entirely. Resolving the token is pre-tenant —
 * which organization this is IS the question — and goes through the
 * `resolve_invitation` SECURITY DEFINER function.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const handle = await db()
  const invite = await resolveInvitation(handle, decodeURIComponent(token))

  const session = await auth()
  const signedInUserId = session?.user?.id ?? null

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
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: 22,
          }}
        >
          <Image src="/syncrese-mark.png" alt="" width={56} height={56} priority />
          <div style={{ fontWeight: 600, fontSize: 22, letterSpacing: '-.025em', marginTop: 10 }}>
            Syncrèse
          </div>
        </div>

        {/* A bad token and a withdrawn one look identical from out here. Telling
            a stranger which of the two they hold would confirm that a real
            invitation exists at that URL. */}
        {!invite || invite.problem ? (
          <div style={{ ...panelStyle, padding: '20px 22px 22px', fontSize: 12.5 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>This link is not usable</div>
            <p style={{ color: 'var(--mut)', lineHeight: 1.55, margin: '0 0 14px' }}>
              {invite?.problem ?? 'This invitation link is not valid.'} Ask whoever invited you
              to send a new one.
            </p>
            <Link href="/sign-in" style={{ color: 'var(--ac)' }}>
              Go to sign in
            </Link>
          </div>
        ) : (
          <AcceptInviteForm
            token={decodeURIComponent(token)}
            organizationName={invite.organizationName}
            email={invite.email}
            roleName={invite.roleName}
            userExists={invite.userExists}
            isSignedIn={Boolean(signedInUserId)}
          />
        )}
      </div>
    </main>
  )
}
