'use client'

import { useEffect, useState, useTransition } from 'react'
import { panelStyle, chipButtonStyle } from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import { listBackupsAction, requestBackupAction, requestRestoreAction } from '@/app/actions/backup'
import type { BackupSummary } from '@/desktop/backup'

/**
 * Backup and restore, standalone install only — hidden entirely on the hosted
 * deployment because neither concept applies there.
 *
 * NEITHER BUTTON IS INSTANT, and the copy says so rather than pretending.
 * Both queue for the next time Syncrèse starts rather than running while it
 * is the very process holding the database open — see desktop/backup.ts for
 * why that boundary exists. A "Back up now" that silently takes a few seconds
 * on the next launch is an honest trade; one that claims to run immediately
 * and might not be safe is not.
 */
export function BackupPanel({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [backups, setBackups] = useState<BackupSummary[] | null>(null)
  const [notDesktop, setNotDesktop] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)

  const reload = () =>
    listBackupsAction().then((r) => {
      if (r.ok) setBackups(r.data)
      else setNotDesktop(true)
    })

  useEffect(() => {
    void reload()
  }, [])

  // Nothing to show on the hosted deployment, and nothing to explain either —
  // a panel about a feature that does not apply here is noise, not honesty.
  if (notDesktop) return null

  const requestNow = () =>
    startTransition(async () => {
      const result = await requestBackupAction()
      if (result.ok) {
        toast('Queued. This will run the next time Syncrèse starts.')
      } else {
        toast(result.error, 'err')
      }
    })

  const restore = (file: string) =>
    startTransition(async () => {
      const result = await requestRestoreAction(file)
      setConfirming(null)
      if (result.ok) {
        toast('Queued. Close and reopen Syncrèse to finish restoring — nothing has changed yet.')
      } else {
        toast(result.error, 'err')
      }
    })

  const latest = backups?.[0]
  const dueSoon =
    !latest || Date.now() - new Date(latest.takenAt).getTime() > 20 * 60 * 60 * 1000

  return (
    <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Backup</div>
      <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 16, lineHeight: 1.55 }}>
        This workspace&rsquo;s only copy is on this computer. A backup is taken automatically once a
        day, the moment Syncrèse next starts — and kept for two weeks. Restoring replaces
        everything with what the backup contains; the data it replaces is kept alongside it,
        never deleted.
      </div>

      {backups === null && <div style={{ color: 'var(--mut)', fontSize: 12 }}>Loading…</div>}

      {backups !== null && (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 12px',
              marginBottom: 14,
              borderRadius: 8,
              border: `1px solid ${dueSoon ? 'var(--warn)' : 'var(--bd)'}`,
              fontSize: 12.5,
            }}
          >
            <span>
              {latest
                ? `Last backup ${new Date(latest.takenAt).toLocaleString()} — ${(latest.bytes / 1024 / 1024).toFixed(1)} MB`
                : 'No backup has been taken yet.'}
            </span>
            {canManage && (
              <button type="button" style={chipButtonStyle} disabled={pending} onClick={requestNow}>
                Back up now
              </button>
            )}
          </div>

          {backups.length > 1 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ ...labelStyle, marginBottom: 8 }}>PREVIOUS BACKUPS</div>
              {backups.slice(1, 8).map((b) => (
                <div
                  key={b.file}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '9px 0',
                    borderBottom: '1px solid var(--bd)',
                    fontSize: 12.5,
                  }}
                >
                  <span style={{ color: 'var(--mut)' }}>
                    {new Date(b.takenAt).toLocaleString()} — {(b.bytes / 1024 / 1024).toFixed(1)} MB
                  </span>
                  {canManage &&
                    (confirming === b.file ? (
                      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ color: 'var(--neg)', fontSize: 11.5 }}>
                          Replace everything with this backup?
                        </span>
                        <button
                          type="button"
                          style={{ ...chipButtonStyle, color: 'var(--neg)' }}
                          disabled={pending}
                          onClick={() => restore(b.file)}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          style={chipButtonStyle}
                          onClick={() => setConfirming(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        style={chipButtonStyle}
                        onClick={() => setConfirming(b.file)}
                      >
                        Restore
                      </button>
                    ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {!canManage && (
        <div style={{ color: 'var(--mut)', fontSize: 11.5, marginTop: 8 }}>
          Ask an owner or administrator to back up on demand or restore.
        </div>
      )}
    </section>
  )
}

const labelStyle = {
  font: '500 9.5px var(--font-mono), monospace',
  letterSpacing: '.07em',
  color: 'var(--mut)',
} as const
