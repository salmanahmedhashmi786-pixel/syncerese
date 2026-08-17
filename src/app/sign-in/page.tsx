import Image from 'next/image'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession } from '@/server/session'
import { signupMode } from '@/server/signup-mode'
import { SignInForm } from './SignInForm'

export const metadata = { title: 'Sign in' }
export const dynamic = 'force-dynamic'

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { ctx } = await getSession()
  if (ctx) redirect('/dashboard')

  const sp = await searchParams
  const error = Array.isArray(sp.error) ? sp.error[0] : sp.error
  const canSignUp = signupMode() === 'open'
  const callbackUrl = Array.isArray(sp.callbackUrl) ? sp.callbackUrl[0] : sp.callbackUrl

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
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: 22,
          }}
        >
          <Image src="/syncrese-mark.png" alt="" width={56} height={56} priority />
          <div
            style={{
              fontWeight: 600,
              fontSize: 22,
              letterSpacing: '-.025em',
              marginTop: 10,
            }}
          >
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
            ERP FOR SMALL &amp; MEDIUM BUSINESS
          </div>
        </div>

        <SignInForm error={error} callbackUrl={callbackUrl} />

        <div style={{ textAlign: 'center', marginTop: 14, fontSize: 11.5 }}>
          <Link href="/forgot-password" style={{ color: 'var(--mut)' }}>
            Forgot your password?
          </Link>
        </div>

        {canSignUp && (
          <div
            style={{
              textAlign: 'center',
              marginTop: 16,
              fontSize: 11.5,
              color: 'var(--mut)',
            }}
          >
            No account yet?{' '}
            <Link href="/sign-up" style={{ color: 'var(--ac)' }}>
              Create a workspace
            </Link>
          </div>
        )}
      </div>
    </main>
  )
}
