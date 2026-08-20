#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Assembles everything the standalone desktop installer needs.
 *
 *   node scripts/build-desktop.mjs
 *
 * Produces `desktop/sidecar/`:
 *
 *   node.exe        the runtime, copied from whatever node is running this
 *   launcher.mjs    bundled from src/desktop/launcher.ts
 *   server/         the Next standalone build, with static assets and public/
 *   server/drizzle/ the migrations, which run on first launch
 *
 * Tauri ships that directory as a resource and spawns `node.exe launcher.mjs`.
 *
 * WHY THE RUNTIME IS COPIED RATHER THAN DEPENDED ON
 *
 * The customer has no Node and should never be asked to install one. Bundling
 * it costs about 50 MB and removes an entire category of support call — the
 * one that begins "it worked on my other computer".
 *
 * NEXT BUILD IS NOT RUN HERE
 *
 * On purpose. `next build` takes minutes and is usually already done; running
 * it implicitly would hide which artefacts this script actually consumed. It
 * checks instead, and says exactly what to run.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'desktop', 'sidecar')
const standalone = path.join(root, '.next', 'standalone')

const step = (msg) => console.log(`  ${msg}`)

function requireBuild() {
  if (!existsSync(path.join(standalone, 'server.js'))) {
    console.error('No standalone build found at .next/standalone.\n')
    console.error('Run `npm run build` first. If it produced .next but no standalone/,')
    console.error('check that VERCEL is not set in the environment — next.config.ts skips')
    console.error('standalone output when it is.')
    process.exit(1)
  }
}

/**
 * Bundles the launcher through esbuild's API rather than its CLI.
 *
 * `npx esbuild` would mean spawning `npx.cmd`, and Node refuses to spawn a
 * .cmd without a shell since the batch-injection fix in 18.20 — it fails with
 * a bare EINVAL that names no cause. The API has no such problem and no shell
 * in the path at all.
 */
async function bundleLauncher() {
  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'desktop', 'launcher.ts')],
    outfile: path.join(out, 'launcher.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    external: ['node:*'],
    logLevel: 'warning',
  })
}

const sizeOf = (dir) => {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? sizeOf(full) : statSync(full).size
  }
  return total
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`

console.log('Assembling the desktop sidecar\n')
requireBuild()

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

step('the Next server')
cpSync(standalone, path.join(out, 'server'), { recursive: true })

step('static assets')
cpSync(path.join(root, '.next', 'static'), path.join(out, 'server', '.next', 'static'), {
  recursive: true,
})
if (existsSync(path.join(root, 'public'))) {
  cpSync(path.join(root, 'public'), path.join(out, 'server', 'public'), { recursive: true })
}

step('migrations')
// Beside server.js, where the launcher's resolver looks first.
cpSync(path.join(root, 'drizzle'), path.join(out, 'server', 'drizzle'), { recursive: true })

step('the Node runtime')
cpSync(process.execPath, path.join(out, 'node.exe'))

step('the launcher')
await bundleLauncher()

// A manifest, so a support call can establish what is actually installed
// without asking somebody to read file dates.
writeFileSync(
  path.join(out, 'sidecar.json'),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    null,
    2,
  ),
)

console.log(`\nReady: ${path.relative(root, out)} (${mb(sizeOf(out))})`)
console.log('Next: cd desktop && npm run build')
