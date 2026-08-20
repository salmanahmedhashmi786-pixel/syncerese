import { spawn, type ChildProcess } from 'node:child_process'
import { createServer as createHttpsServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { applyDesktopEnv, dataDir } from './mode'
import { ensureCertificate, trustCaLocally } from './tls'

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
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = httpRequest(
        { host: '127.0.0.1', port: INTERNAL_PORT, path: '/api/health', timeout: 2_000 },
        (res) => {
          res.resume()
          resolve()
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
    forward.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('The application server is not responding.')
    })
    req.pipe(forward)
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
