import '../src/lib/load-env'
import { checkEnvironment, formatFindings } from '../src/lib/env'

/**
 * Pre-deploy configuration check.
 *
 * Same rules the server applies at boot, runnable against a candidate
 * environment before anything is deployed into it — finding a missing
 * AUTH_SECRET in CI costs a minute, finding it in production costs everybody's
 * session.
 *
 * `--production` applies the strict rules regardless of NODE_ENV, which is the
 * normal way to run it: the checking machine is rarely the one being checked.
 */
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production'

const findings = checkEnvironment({ production })
const errors = findings.filter((f) => f.severity === 'error')
const warnings = findings.filter((f) => f.severity === 'warning')

console.log(`Checking ${production ? 'PRODUCTION' : 'development'} configuration…\n`)

if (warnings.length > 0) console.log(`${warnings.length} warning(s):\n${formatFindings(warnings)}\n`)

if (errors.length > 0) {
  console.error(`${errors.length} error(s):\n${formatFindings(errors)}\n`)
  console.error('Not safe to deploy. See docs/03-deployment.md.')
  process.exit(1)
}

console.log(warnings.length > 0 ? 'No blocking problems.' : 'Configuration looks good.')
