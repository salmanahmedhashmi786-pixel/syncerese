'use server'

import { db } from '@/db'
import { callerFingerprint } from '@/server/caller'
import { completeReset, requestReset, tokenLooksValid } from '@/auth/password-reset'
import { emailConfigured } from '@/email/send'

/**
 * The two unauthenticated steps of a password reset.
 *
 * Both are deliberately uninformative. `requestPasswordResetAction` returns the
 * same shape whether or not the address belongs to anybody, because an endpoint
 * that distinguishes them is a membership oracle for anyone holding a list of
 * email addresses — and the addresses of a company's staff are not hard to
 * guess.
 */

export type RequestState = {
  /** Always the same sentence. It says what happens IF the address is known,
   *  which is true either way and tells an attacker nothing. */
  message: string
  /** Development convenience only — see requestReset. Never set in production. */
  devLink?: string
}

export async function requestPasswordResetAction(email: string): Promise<RequestState> {
  const message =
    'If that address belongs to an account, a reset link is on its way. ' +
    'It expires in an hour and works once.'

  const trimmed = email.trim()
  if (trimmed === '' || !trimmed.includes('@')) return { message }

  try {
    const handle = await db()
    const outcome = await requestReset(handle, {
      email: trimmed,
      ipHash: await callerFingerprint(),
      appUrl: process.env.AUTH_URL ?? 'http://localhost:3000',
    })
    return outcome.devLink ? { message, devLink: outcome.devLink } : { message }
  } catch (err) {
    // Even a failure returns the same sentence: an error that only appears for
    // real addresses is the same oracle by another route. Logged so an
    // administrator can see a mail server is down.
    console.error('[password-reset]', err)
    return { message }
  }
}

export type CompleteState = { ok: boolean; error?: string }

export async function completePasswordResetAction(
  token: string,
  password: string,
  confirm: string,
): Promise<CompleteState> {
  if (password !== confirm) {
    return { ok: false, error: 'The two passwords do not match.' }
  }

  try {
    const handle = await db()
    const result = await completeReset(handle, token, password)
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  } catch (err) {
    console.error('[password-reset]', err)
    return { ok: false, error: 'Something went wrong. Ask for a new link.' }
  }
}

/** Whether the link is still live, so the page can say so before asking for a
 *  password twice. Does not spend the token. */
export async function checkResetTokenAction(token: string): Promise<boolean> {
  if (!token) return false
  try {
    return await tokenLooksValid(await db(), token)
  } catch {
    return false
  }
}

/** Whether this deployment can actually send the mail, so the page can be
 *  honest rather than telling somebody to check an inbox that will stay empty. */
export async function emailConfiguredAction(): Promise<boolean> {
  return emailConfigured()
}
