import Image from 'next/image'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession } from '@/server/session'
import { emailConfigured } from '@/email/send'
import { ForgotPasswordForm } from './ForgotPasswordForm'

export const metadata = { title: 'Reset your password' }
export const dynamic = 'force-dynamic'

export default async function ForgotPasswordPage() {
  const { ctx } = await getSession()
  if (ctx) redirect('/dashboard')

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
          <div style={{ fontWeight: 600, fontSize: 22, letterSpacing: '-.025em', marginTop: 10 }}>
            Reset your password
          </div>
        </div>

        {/* Said before anything is typed, not after. A deployment with no mail
            server would otherwise send somebody to watch an inbox that is never
            going to receive anything. */}
        <ForgotPasswordForm mailReady={emailConfigured()} />

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 11.5, color: 'var(--mut)' }}>
          <Link href="/sign-in" style={{ color: 'var(--ac)' }}>
            Back to sign in
          </Link>
        </div>
      </div>
    </main>
  )
}
