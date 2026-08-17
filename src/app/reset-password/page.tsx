import Image from 'next/image'
import Link from 'next/link'
import { db } from '@/db'
import { tokenLooksValid } from '@/auth/password-reset'
import { ResetPasswordForm } from './ResetPasswordForm'

export const metadata = { title: 'Choose a new password' }
export const dynamic = 'force-dynamic'

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const token = (Array.isArray(sp.token) ? sp.token[0] : sp.token) ?? ''

  // Checked WITHOUT spending it, so an expired link says so before somebody
  // types a new password twice and only then finds out.
  const valid = token ? await tokenLooksValid(await db(), token) : false

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
            Choose a new password
          </div>
        </div>

        {valid ? (
          <ResetPasswordForm token={token} />
        ) : (
          <div
            style={{
              background: 'var(--pnl)',
              border: '1px solid var(--bd)',
              borderRadius: 10,
              padding: '18px 20px 20px',
              fontSize: 12.5,
              lineHeight: 1.55,
            }}
          >
            {/* One message for expired, already used and never existed. All
                three lead the same place, and distinguishing them would help
                somebody testing tokens more than it helps the person here. */}
            That link is not valid any more. Links work once and expire an hour after they are
            sent.
            <div style={{ marginTop: 14 }}>
              <Link href="/forgot-password" style={{ color: 'var(--ac)' }}>
                Ask for a new one
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
