import type { NextAuthConfig } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import Google from 'next-auth/providers/google'
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db as getDb } from '@/db'
import { checkCredentials, recordSuccessfulSignIn } from './credentials'
import { consumeSecondFactor } from './mfa'

const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
  /** TOTP or recovery code. Absent on the first step — the client asks for it
   *  only once `mfaRequired` has come back from `checkCredentials`. */
  totp: z.string().max(64).optional(),
})

export const authConfig: NextAuthConfig = {
  // JWT sessions are required for the Credentials provider. The token carries
  // ONLY the user id: it is proof of authentication, never of authorization.
  // Organization membership, role and permissions are re-resolved from the
  // database on every request in resolveContext() — a client that edits its
  // token gains nothing, because nothing in it is trusted for access control.
  session: { strategy: 'jwt', maxAge: 60 * 60 * 12 },

  trustHost: true,
  pages: { signIn: '/sign-in' },

  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw)
        if (!parsed.success) return null

        const db = await getDb()

        const check = await checkCredentials(db, {
          email: parsed.data.email,
          password: parsed.data.password,
        })
        if (!check.ok) return null

        // The second factor, if the account has one. Verified HERE rather than
        // anywhere earlier: this is the only place that actually mints a
        // session, so it is the only place where skipping the check would let
        // somebody in.
        if (check.mfaEnabled) {
          const code = parsed.data.totp?.trim()
          if (!code) return null
          const accepted = await consumeSecondFactor(db, check.userId, code)
          if (!accepted) return null
        }

        await recordSuccessfulSignIn(db, check.userId)

        return { id: check.userId, email: check.email, name: check.name ?? undefined }
      },
    }),

    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      allowDangerousEmailAccountLinking: false,
    }),

    // Most SME buyers are Microsoft 365 shops (MUST DO #2).
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      allowDangerousEmailAccountLinking: false,
    }),
  ],

  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        token.sub = user.id
        // Stamped at sign-in and compared below. `iat` would nearly do, but it
        // is refreshed as next-auth rotates the token, so a revocation could be
        // outrun by an attacker who simply kept using the session.
        token.authAt = Math.floor(Date.now() / 1000)
      }
      return token
    },

    /**
     * The revocation check.
     *
     * Sessions are JWTs and cannot be deleted server-side. Without this, a
     * password reset after an account compromise leaves the attacker signed in
     * for the remaining life of their token — up to twelve hours — which makes
     * the reset close to useless in the case it exists for.
     *
     * One indexed lookup per session read. That is a real cost and it buys the
     * only thing that makes "you have been signed out everywhere" true.
     */
    async session({ session, token }) {
      if (!token.sub) return session
      session.user.id = token.sub

      const authAt = typeof token.authAt === 'number' ? token.authAt : 0
      const db = await getDb()
      const res = await db.execute(
        sql`select credentials_changed_at as "changedAt" from users where id = ${token.sub}::uuid`,
      )
      const changedAt = (res as unknown as { rows: { changedAt: Date | string | null }[] }).rows[0]
        ?.changedAt

      if (changedAt) {
        const changedSeconds = Math.floor(new Date(changedAt).getTime() / 1000)
        // One second of slack: `credentials_changed_at` comes from the database
        // clock and `authAt` from this process, and a session minted in the same
        // second as a reset should not be thrown away.
        if (authAt < changedSeconds - 1) {
          // next-auth has no way to say "this session is dead" from here other
          // than returning something the app treats as signed out. Every page
          // requires `session.user.id`, so clearing it is exactly that.
          return { ...session, user: { ...session.user, id: '' } }
        }
      }

      return session
    },
  },
}
