import Image from 'next/image'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession } from '@/server/session'
import { effectiveSignupMode } from '@/server/signup-mode'
import { panelStyle } from '@/components/ui/primitives'
import { SignUpForm } from './SignUpForm'

export const metadata = { title: 'Create your workspace' }
export const dynamic = 'force-dynamic'

export default async function SignUpPage() {
  const { ctx } = await getSession()
  if (ctx) redirect('/dashboard')

  const mode = await effectiveSignupMode()

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
      <div style={{ width: '100%', maxWidth: 420 }}>
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
          <div
            style={{
              font: '400 10.5px var(--font-mono), monospace',
              color: 'var(--mut)',
              letterSpacing: '.06em',
              marginTop: 2,
            }}
          >
            CREATE YOUR WORKSPACE
          </div>
        </div>

        {mode === 'open' ? (
          <SignUpForm />
        ) : (
          // Rendered instead of the form, not merely hidden — the action
          // refuses regardless, but a form that cannot succeed is worse than an
          // explanation.
          <div style={{ ...panelStyle, padding: '20px 22px 22px', fontSize: 12.5 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Signups are closed here</div>
            <p style={{ color: 'var(--mut)', lineHeight: 1.55, margin: '0 0 14px' }}>
              This installation does not create new organizations from the public internet. Ask an
              administrator of your workspace to send you an invitation.
            </p>
            <Link href="/sign-in" style={{ color: 'var(--ac)' }}>
              Go to sign in
            </Link>
          </div>
        )}
      </div>
    </main>
  )
}
