/**
 * Whether this installation accepts new organizations.
 *
 *  - `open`   — public SaaS. Anyone can create a tenant at /sign-up.
 *  - `closed` — self-hosted or invite-only. New members arrive by invitation
 *               from inside an existing organization.
 *
 * Defaults to closed, because that is the safe answer for a self-hosted install
 * that someone put on the public internet without reading the runbook. The
 * hosted deployment sets SIGNUP_MODE=open explicitly.
 *
 * Deliberately NOT in the 'use server' action module: every export of one of
 * those becomes a callable HTTP endpoint, and a flag the pages read at render
 * time has no business being one.
 */
export type SignupMode = 'open' | 'closed'

export function signupMode(): SignupMode {
  return process.env.SIGNUP_MODE === 'open' ? 'open' : 'closed'
}
