import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Backup and restore for the standalone desktop install.
 *
 * These run against real directories rather than a mocked filesystem, because
 * every bug worth catching here is about what actually ends up on disk: whether
 * the key travelled with the data, whether a truncated archive is detected
 * before it overwrites the live database, whether the thing it replaced still
 * exists afterwards.
 *
 * The modules read the data directory from the environment at call time, so
 * each test points them at its own temporary folder.
 */
describe('desktop backup', () => {
  let root: string
  let mod: typeof import('@/desktop/backup')

  beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'syncrese-backup-'))
    process.env.SYNCRESE_DESKTOP = '1'
    process.env.SYNCRESE_DATA_DIR = root

    // Stand in for PGlite's data directory.
    mkdirSync(path.join(root, 'database'), { recursive: true })
    writeFileSync(path.join(root, 'database', 'base.dat'), 'ledger contents')
    writeFileSync(
      path.join(root, 'secrets.json'),
      JSON.stringify({ encryptionKey: 'the-key-everything-depends-on' }),
    )

    mod = await import('@/desktop/backup')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    delete process.env.SYNCRESE_DESKTOP
    delete process.env.SYNCRESE_DATA_DIR
  })

  it('includes the encryption key, because a backup without it restores to nothing', () => {
    const b = mod.takeBackup()
    const key = path.join(b.file, 'secrets.json')
    expect(existsSync(key)).toBe(true)
    // The whole point of choosing a recoverable key: a restore onto replacement
    // hardware has to be able to read the MFA secrets and integration tokens it
    // just restored. Dropping this file turns "we restored from backup" into
    // "we restored something that will not open", found out weeks later.
    expect(JSON.parse(readFileSync(key, 'utf8')).encryptionKey).toBe(
      'the-key-everything-depends-on',
    )
  })

  it('records a checksum and refuses a backup that does not match it', () => {
    const b = mod.takeBackup()
    expect(b.sha256).toMatch(/^[0-9a-f]{64}$/)

    // A truncated copy from a failing USB stick looks exactly like a good one
    // until it is unpacked over the live database.
    writeFileSync(path.join(b.file, 'database', 'base.dat'), 'corrupted')

    expect(() => mod.restoreBackup(b.file)).toThrow(/damaged/i)
    // And it stopped BEFORE touching anything.
    expect(readFileSync(path.join(root, 'database', 'base.dat'), 'utf8')).toBe('ledger contents')
  })

  it('restores the database and the key together', () => {
    const b = mod.takeBackup()

    writeFileSync(path.join(root, 'database', 'base.dat'), 'later, wrong contents')
    writeFileSync(path.join(root, 'secrets.json'), JSON.stringify({ encryptionKey: 'wrong' }))

    mod.restoreBackup(b.file)

    expect(readFileSync(path.join(root, 'database', 'base.dat'), 'utf8')).toBe('ledger contents')
    expect(JSON.parse(readFileSync(path.join(root, 'secrets.json'), 'utf8')).encryptionKey).toBe(
      'the-key-everything-depends-on',
    )
  })

  it('keeps what it replaced', () => {
    const b = mod.takeBackup()
    writeFileSync(path.join(root, 'database', 'base.dat'), 'the state before the restore')
    mod.restoreBackup(b.file)

    // A restore from a bad archive must be survivable. This folder is the
    // customer's last resort and nothing here deletes it.
    const aside = readdirSync(root).find((f) => f.startsWith('database.replaced-'))
    expect(aside, 'the replaced database should be kept aside').toBeTruthy()
    expect(readFileSync(path.join(root, aside!, 'base.dat'), 'utf8')).toBe(
      'the state before the restore',
    )
  })

  it('rejects a folder that is not a backup', () => {
    const notABackup = path.join(root, 'holiday-photos')
    mkdirSync(notABackup, { recursive: true })
    expect(() => mod.restoreBackup(notABackup)).toThrow(/does not look like a backup/i)
  })

  it('lists backups newest first', async () => {
    const first = mod.takeBackup()
    // The folder name is a timestamp to the millisecond; without a gap two
    // backups in the same tick would collide.
    await new Promise((r) => setTimeout(r, 5))
    const second = mod.takeBackup()

    const listed = mod.listBackups()
    expect(listed.length).toBeGreaterThanOrEqual(2)
    expect(listed[0]!.file).toBe(second.file)
    expect(listed.map((l) => l.file)).toContain(first.file)
  })
})
