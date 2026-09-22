import { spawn, type ChildProcess } from 'node:child_process'
import { createServer as createHttpsServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { applyDesktopEnv, dataDir } from './mode'
import { ensureCertificate, trustCaLocally } from './tls'
import { runScheduledBackupWork } from './backup'

/**
 * The desktop server.
 *
 * Tauri spawns this, waits for the ready line, and points its window at the URL
 * it prints. Everything the hosted deployment gets from Vercel and Neon happens
 * here instead, on one machine, with no internet.
 *
 * WHY TWO LISTENERS
 *
 * Next's standalone build serves HTTP and has no TLS of its own. So it is bound
 * to 127.0.0.1 — unreachable from the network — and an HTTPS listener in front
 * carries the office traffic. Terminating TLS here rather than teaching Next
 * about it keeps the standalone bundle exactly as `next build` produced it,
 * which is one less thing to be surprised by after an upgrade.
 *
 * The internal port is not a security boundary on its own. It is bound to
 * loopback, so nothing on the LAN can reach it, and that is the boundary.
 */

/** The port the office connects to. Chosen from the IANA dynamic range, and
 *  unlikely to collide with anything a small business runs. */
const PUBLIC_PORT = Number(process.env.SYNCRESE_PORT ?? 7429)
/** Loopback only. Next never sees the network directly. */
const INTERNAL_PORT = Number(process.env.SYNCRESE_INTERNAL_PORT ?? 7430)

/**
 * Whether to accept connections from other machines.
 *
 * Single-user installs bind loopback and are unreachable from the network at
 * all — no firewall rule, no exposure, nothing to think about. Sharing is a
 * decision somebody makes, not a default they inherit.
 */
const shareOnLan = process.env.SYNCRESE_SHARE_LAN === '1'

function serverEntry(): string {
  // Beside the launcher once bundled; in `.next/standalone` when run from the
  // repository during development.
  const candidates = [
    path.join(process.cwd(), 'server', 'server.js'),
    path.join(process.cwd(), '.next', 'standalone', 'server.js'),
    path.join(path.dirname(process.argv[1] ?? '.'), 'server', 'server.js'),
  ]
  const found = candidates.find((c) => existsSync(c))
  if (!found) {
    throw new Error(
      `Could not find the application server. Looked in:\n  ${candidates.join('\n  ')}`,
    )
  }
  return found
}

/** Resolves once Next answers, or rejects after `timeoutMs`. Polling rather
 *  than parsing stdout: the ready message is Next's to change, the port
 *  answering is ours to rely on. */
function waitForNext(timeoutMs = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const startedAt = Date.now()
  let announced = 0
  // Without this the polling chain carries on after resolve, and keeps
  // announcing progress for a database that is already up.
  let settled = false
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: INTERNAL_PORT,
          path: '/api/health',
          timeout: 5_000,
          // The detailed answer, which the endpoint gives only to the cron
          // secret. The plain one reports `ok` as soon as HTTP is up — before
          // the database exists — and the window would open onto an
          // application still applying migrations.
          headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` },
        },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (d) => (body += d))
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body) as { status?: string; database?: string }
              if (parsed.status === 'ok' && parsed.database === 'ok') {
                settled = true
                resolve()
                return
              }
            } catch {
              /* not JSON yet */
            }
            retry()
          })
        },
      )
      req.on('error', retry)
      req.on('timeout', () => {
        req.destroy()
        retry()
      })
      req.end()
    }
    const retry = () => {
      if (settled) return
      if (Date.now() > deadline) {
        reject(new Error(`The application server did not start within ${timeoutMs / 1000}s.`))
        return
      }
      // FIRST RUN IS SLOW, and silence looks like a hang. PGlite applies
      // twenty-five migrations into an empty data directory before the health
      // endpoint can answer, which takes minutes on modest hardware — the
      // original sixty-second limit gave up while it was still working.
      const seconds = Math.floor((Date.now() - startedAt) / 1000)
      if (seconds >= announced + 15) {
        announced = seconds
        console.log(`[syncrese] preparing the database (${seconds}s)…`)
      }
      setTimeout(attempt, 250)
    }
    attempt()
  })
}

async function main(): Promise<void> {
  process.env.SYNCRESE_DESKTOP = '1'
  // Next's types declare NODE_ENV read-only; it is an ordinary environment
  // variable and the child process needs it set before it boots.
  Object.assign(process.env, { NODE_ENV: 'production' })

  // Secrets first: the boot gate reads them, and on a fresh install they do not
  // exist yet.
  applyDesktopEnv()

  // Backup and restore both happen HERE, before Next opens the database
  // directory at all — the one moment nothing else has it open. See the note
  // at the top of desktop/backup.ts for why neither ever runs while the app
  // itself is live.
  try {
    const work = runScheduledBackupWork()
    if (work.restored) console.log(`[syncrese] restored from ${work.restored}`)
    if (work.backedUp) {
      console.log(
        `[syncrese] backed up (${(work.backedUp.bytes / 1024 / 1024).toFixed(1)} MB) to ${work.backedUp.file}`,
      )
    }
  } catch (err) {
    // A failed backup must not be a failure to start — that would turn "we
    // could not protect your data" into "we also would not let you use it".
    // A failed RESTORE is worse to swallow, since the customer asked for it
    // specifically and deserves to know it did not happen, but it still must
    // not brick the app: the pre-restore database is untouched either way,
    // because restoreBackup() only removes the live directory after the new
    // one is validated.
    console.error(
      `[syncrese] backup/restore step failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const cert = ensureCertificate()
  const trusted = trustCaLocally()
  if (!trusted) {
    console.warn(
      '[syncrese] could not add the local certificate to the trust store; the window may ' +
        'warn about the certificate. The connection is still encrypted.',
    )
  }

  // AUTH_URL has to match the address the browser actually used, or session
  // cookies are issued for the wrong origin and sign-in silently fails. On a
  // LAN host that is the machine's own name, not localhost.
  const advertised = shareOnLan ? (cert.names[1] ?? 'localhost') : 'localhost'
  const url = `https://${advertised}:${PUBLIC_PORT}`
  process.env.AUTH_URL = url

  const entry = serverEntry()
  const child: ChildProcess = spawn(process.execPath, [entry], {
    // The standalone server resolves its own assets relative to its directory.
    cwd: path.dirname(entry),
    env: {
      ...process.env,
      PORT: String(INTERNAL_PORT),
      HOSTNAME: '127.0.0.1',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  child.on('exit', (code) => {
    console.error(`[syncrese] the application server exited with code ${code}`)
    process.exit(code ?? 1)
  })

  await waitForNext()

  const proxy = createHttpsServer({ pfx: cert.pfx, passphrase: cert.passphrase }, (req, res) => {
    const forward = httpRequest(
      {
        host: '127.0.0.1',
        port: INTERNAL_PORT,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          // Next builds absolute URLs from these. Without them every redirect
          // and every cookie would be issued against the loopback address the
          // client never used.
          'x-forwarded-proto': 'https',
          'x-forwarded-host': req.headers.host ?? advertised,
        },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers)
        upstream.pipe(res)
      },
    )
    forward.on('error', (err: NodeJS.ErrnoException) => {
      // Logged, not just returned. A 502 that says only "not responding" is the
      // same unhelpful shape as the pairing screen's "could not reach that
      // address" — true, and impossible to act on.
      console.error(`[syncrese] proxy -> 127.0.0.1:${INTERNAL_PORT} failed: ${err.code ?? ''} ${err.message}`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('The application server is not responding.')
    })
    req.pipe(forward)
  })

  // A port already in use is the one startup failure a customer can actually
  // act on, and Node's default for it is an unhandled EADDRINUSE with a stack
  // trace. Say which port, and how to change it.
  proxy.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[syncrese] port ${PUBLIC_PORT} is already in use on this computer.
` +
          `Another program has it — possibly a second copy of Syncrèse that is still ` +
          `running.
Close that, or set SYNCRESE_PORT to a different number and start again.`,
      )
    } else {
      console.error(`[syncrese] could not listen on port ${PUBLIC_PORT}: ${err.message}`)
    }
    child.kill()
    process.exit(1)
  })

  proxy.listen(PUBLIC_PORT, shareOnLan ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`[syncrese] data directory ${dataDir()}`)
    if (shareOnLan) {
      console.log(`[syncrese] sharing on this network as ${cert.names.filter((n) => n !== 'localhost').join(', ')}`)
      console.log(`[syncrese] certificate fingerprint ${cert.fingerprint}`)
    } else {
      console.log('[syncrese] this machine only; not reachable from the network')
    }
    // Tauri waits for this exact line before opening the window.
    console.log(`SYNCRESE_READY ${url}`)
  })

  const shutdown = () => {
    proxy.close()
    child.kill()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err: unknown) => {
  console.error(`[syncrese] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
