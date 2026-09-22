import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import path from 'node:path'
import { backupDir, dataDir, databaseDir, secretsFile } from './mode'

/**
 * Backup and restore for a standalone install.
 *
 * WHY THIS IS NOT OPTIONAL
 *
 * On the hosted service the database is Neon's problem and it is solved:
 * continuous backup, point-in-time restore, somebody paid to care. Here the
 * only copy of a company's ledger is a folder on one PC in an office. Nobody
 * backs up their own laptop. Ten years of statutory accounting records sit on a
 * consumer SSD with a five-year life.
 *
 * So the software does it, on a schedule, without being asked — and says
 * plainly when the last one happened, because a backup nobody has looked at is
 * a backup nobody knows is broken.
 *
 * WHAT GOES IN, AND WHY THE KEY GOES WITH IT
 *
 * The database, and the secrets file. Including the encryption key in the same
 * archive is a real decision and it follows from the one already made: the key
 * is recoverable, not sealed to the machine. A backup without it restores to
 * unreadable ciphertext for every MFA secret and integration token — which
 * turns "we restored from backup" into "we restored something that will not
 * open", discovered weeks later.
 *
 * The consequence, stated where it will be read: THE BACKUP ARCHIVE IS AS
 * SENSITIVE AS THE DATABASE. It is not encrypted at rest by us, because we
 * would have to put that key somewhere too, and the somewhere is the same
 * folder. Tell customers to keep backups where they keep their accounts.
 *
 * The TLS certificate is deliberately excluded. It is per-machine, it regenerates
 * in three seconds, and a restore onto new hardware wants a new one anyway.
 */

export type BackupSummary = {
  file: string
  bytes: number
  takenAt: string
  /** SHA-256 of the archive, written beside it. Restore checks it before
   *  touching anything, because a truncated copy from a failing USB stick looks
   *  exactly like a good one until it is unpacked over the live database. */
  sha256: string
}

const STAMP = () => new Date().toISOString().replace(/[:.]/g, '-')

/** How many to keep. Old enough to survive "we noticed the problem last week",
 *  small enough not to fill a laptop. */
const KEEP = 14

/**
 * WHY EVERY FUNCTION HERE ASSUMES THE SERVER IS NOT RUNNING.
 *
 * `takeBackup` is a raw filesystem copy of PGlite's data directory. Real
 * Postgres can be backed up this way while live, safely, because its WAL gives
 * a copy taken mid-write the same consistency guarantee as recovering from a
 * power cut. PGlite is "real Postgres compiled to WASM", which makes that
 * plausible here too — but this codebase has no way to confirm PGlite's Node
 * filesystem backend actually preserves that property, and the thing at stake
 * is a business's only copy of its accounting records.
 *
 * So neither backup nor restore ever runs while the app itself is the process
 * serving requests against that directory. Both are driven from the launcher,
 * before Next starts — the same moment migrations already run in, for the same
 * reason: it is the one point where nothing else has the directory open yet.
 *
 * The cost is real and worth stating: "back up now" in the Settings panel does
 * not back up now. It queues one for the next launch. Slower than it could be,
 * never wrong.
 */

const REQUEST_FILE = 'backup-requested'
const RESTORE_FILE = 'restore-requested'
const DUE_AFTER_MS = 24 * 60 * 60 * 1000

/** Called from the Settings panel. Queues a backup for the next launch rather
 *  than taking one inline, for the reason above. */
export function requestBackup(): void {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(path.join(dataDir(), REQUEST_FILE), new Date().toISOString())
}

/** Called from the Settings panel. Queues a restore FROM the given backup
 *  folder for the next launch — never performed inline, for the same reason. */
export function requestRestore(from: string): void {
  if (!existsSync(path.join(from, 'backup.json'))) {
    throw new Error(`${from} does not look like a backup — no backup.json in it.`)
  }
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(path.join(dataDir(), RESTORE_FILE), from)
}

/**
 * Called once from the launcher, before Next starts. Applies a queued restore
 * if one is waiting, then takes a backup if one is either queued or overdue.
 * Returns what it did, so the launcher can log something a support call can
 * ask the customer to read out.
 */
export function runScheduledBackupWork(): { restored: string | null; backedUp: BackupSummary | null } {
  let restored: string | null = null
  const restoreMarker = path.join(dataDir(), RESTORE_FILE)
  if (existsSync(restoreMarker)) {
    const from = readFileSync(restoreMarker, 'utf8').trim()
    rmSync(restoreMarker, { force: true })
    if (from && existsSync(from)) {
      restoreBackup(from)
      restored = from
    }
  }

  const requestMarker = path.join(dataDir(), REQUEST_FILE)
  const requested = existsSync(requestMarker)
  if (requested) rmSync(requestMarker, { force: true })

  const due = requested || isBackupDue()
  const backedUp = due && existsSync(databaseDir()) ? takeBackup() : null

  return { restored, backedUp }
}

/** No backup at all, or the newest one is more than a day old. Checked rather
 *  than scheduled with a timer: the process this runs in does not stay alive
 *  between launches, so "once per launch, if due" is what "daily" actually
 *  means for software that is not always running. */
export function isBackupDue(): boolean {
  const latest = listBackups()[0]
  if (!latest) return true
  return Date.now() - new Date(latest.takenAt).getTime() > DUE_AFTER_MS
}

/**
 * Copies the database and secrets into a dated folder under `backups/`.
 *
 * A directory copy rather than a zip: PGlite's data directory is small, Node
 * has no archiver in the standard library, and a folder can be inspected and
 * restored by hand by somebody who has never heard of this software. When the
 * customer's only recovery path is a support call, "copy this folder back" is
 * an instruction that survives the call.
 */
export function takeBackup(): BackupSummary {
  const root = backupDir()
  mkdirSync(root, { recursive: true })

  const takenAt = new Date().toISOString()
  const dest = path.join(root, STAMP())
  mkdirSync(dest, { recursive: true })

  cpSync(databaseDir(), path.join(dest, 'database'), { recursive: true })
  if (existsSync(secretsFile())) {
    cpSync(secretsFile(), path.join(dest, 'secrets.json'))
  }

  const bytes = directorySize(dest)
  const sha256 = hashDirectory(dest)
  writeFileSync(
    path.join(dest, 'backup.json'),
    JSON.stringify({ takenAt, bytes, sha256, source: dataDir() }, null, 2),
  )

  prune(root)
  return { file: dest, bytes, takenAt, sha256 }
}

/** Newest first. */
export function listBackups(): BackupSummary[] {
  const root = backupDir()
  if (!existsSync(root)) return []
  const out: BackupSummary[] = []
  for (const name of readdirSync(root)) {
    const meta = path.join(root, name, 'backup.json')
    if (!existsSync(meta)) continue
    try {
      const parsed = JSON.parse(readFileSync(meta, 'utf8')) as Omit<BackupSummary, 'file'>
      out.push({ ...parsed, file: path.join(root, name) })
    } catch {
      /* a half-written backup is not a backup; skip it */
    }
  }
  return out.sort((a, b) => b.takenAt.localeCompare(a.takenAt))
}

/**
 * Restores one, after checking it.
 *
 * The live database is moved aside rather than deleted, so a restore from a
 * corrupt archive is survivable. That folder is the customer's last resort and
 * it stays until they remove it — this is not the place to reclaim disk.
 *
 * THE SERVER MUST NOT BE RUNNING. PGlite is single-writer, and replacing the
 * directory underneath a live process corrupts it. The caller is responsible;
 * in the desktop app that is the launcher, before Next starts.
 */
export function restoreBackup(from: string): void {
  const meta = path.join(from, 'backup.json')
  if (!existsSync(meta)) {
    throw new Error(`${from} does not look like a backup — no backup.json in it.`)
  }
  const parsed = JSON.parse(readFileSync(meta, 'utf8')) as { sha256?: string }
  const actual = hashDirectory(from)
  if (parsed.sha256 && parsed.sha256 !== actual) {
    throw new Error(
      'This backup is damaged: its contents do not match the checksum recorded when it was ' +
        'taken. Nothing has been changed. Try an older backup.',
    )
  }

  const live = databaseDir()
  if (existsSync(live)) {
    const aside = `${live}.replaced-${STAMP()}`
    cpSync(live, aside, { recursive: true })
    rmSync(live, { recursive: true, force: true })
    console.log(`[syncrese] previous database kept at ${aside}`)
  }
  cpSync(path.join(from, 'database'), live, { recursive: true })

  const secrets = path.join(from, 'secrets.json')
  if (existsSync(secrets)) cpSync(secrets, secretsFile())
}

function prune(root: string): void {
  const all = listBackups()
  for (const old of all.slice(KEEP)) {
    rmSync(old.file, { recursive: true, force: true })
  }
  void root
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out.sort()
}

const directorySize = (dir: string): number =>
  walk(dir).reduce((n, f) => n + statSync(f).size, 0)

/** Hash of every file's path and contents, in a stable order. `backup.json`
 *  itself is excluded — it is written after, and holds the hash. */
function hashDirectory(dir: string): string {
  const h = createHash('sha256')
  for (const file of walk(dir)) {
    if (path.basename(file) === 'backup.json') continue
    h.update(path.relative(dir, file).replace(/\\/g, '/'))
    h.update(readFileSync(file))
  }
  return h.digest('hex')
}
