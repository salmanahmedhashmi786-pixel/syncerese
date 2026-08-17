import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      /** Populated from the JWT `sub`. Proof of AUTHENTICATION only — every
       *  authorization decision re-reads membership and role from the database
       *  in resolveContext(). Nothing here is trusted for access control. */
      id: string
    } & DefaultSession['user']
  }
}

export {}
