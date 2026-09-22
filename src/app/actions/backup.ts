'use server'

import { revalidatePath } from 'next/cache'
import { getSession } from '@/server/session'
import { requirePermission } from '@/server/context'
import { AppError } from '@/lib/errors'
import { isDesktop } from '@/desktop/mode'
import { listBackups, requestBackup, requestRestore, type BackupSummary } from '@/desktop/backup'

/**
 * Backup and restore, for the Settings panel.
 *
 * DESKTOP ONLY, checked in every action here rather than only in the UI that
 * calls them. The panel that renders these buttons already hides on the
 * hosted deployment, but a server action is a public endpoint regardless of
 * what rendered the button that called it — the check belongs on the server
 * side of that boundary, not the client side of it.
 *
 * Neither action performs anything immediately. `desktop/backup.ts` explains
 * why: the server that would be doing the copying is the same process whose
 * files it would be copying, and this codebase cannot be certain that is safe
 * while PGlite is live. Both write a marker and hand off to the next launch,
 * which is the one moment nothing has the database directory open.
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

const fail = (err: unknown): Result<never> => {
  if (err instanceof AppError) return { ok: false, error: err.message }
  console.error('[backup]', err)
  return { ok: false, error: 'Something went wrong.' }
}

const NOT_DESKTOP: Result<never> = {
  ok: false,
  error: 'Backup and restore apply to the standalone desktop app, not this deployment.',
}

export async function listBackupsAction(): Promise<Result<BackupSummary[]>> {
  if (!isDesktop()) return NOT_DESKTOP
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  try {
    requirePermission(ctx, 'license.read')
    return { ok: true, data: listBackups() }
  } catch (err) {
    return fail(err)
  }
}

/** Queues a backup for the next time Syncrèse starts. Does not take one now —
 *  see the module comment for why. */
export async function requestBackupAction(): Promise<Result<null>> {
  if (!isDesktop()) return NOT_DESKTOP
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  try {
    requirePermission(ctx, 'license.manage')
    requestBackup()
    revalidatePath('/settings')
    return { ok: true, data: null }
  } catch (err) {
    return fail(err)
  }
}

/**
 * Queues a restore from `backupFile` for the next launch.
 *
 * Cannot be undone by anything short of another restore, so this is one of
 * the few actions gated on the same permission as changing the licence
 * itself — an accidental click here loses however many hours of work
 * happened since the backup being restored, and that is not a decision a
 * casual mistake should be able to make.
 */
export async function requestRestoreAction(backupFile: string): Promise<Result<null>> {
  if (!isDesktop()) return NOT_DESKTOP
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  try {
    requirePermission(ctx, 'license.manage')
    // Restrict to what listBackupsAction() would have returned, so this
    // cannot be pointed at an arbitrary path on the machine by a modified
    // client request.
    const known = listBackups().find((b) => b.file === backupFile)
    if (!known) throw new AppError('VALIDATION_FAILED', 'That is not one of this workspace’s backups.')
    requestRestore(backupFile)
    return { ok: true, data: null }
  } catch (err) {
    return fail(err)
  }
}
