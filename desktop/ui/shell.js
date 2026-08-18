/**
 * The pairing flow.
 *
 * Everything here runs in the local shell window. The customer's instance is
 * opened in a separate window with no IPC — see src-tauri/src/lib.rs.
 *
 * The one network call this page makes is to `/api/desktop/pair` on the address
 * the user typed. It carries a pairing code and a hashed machine fingerprint,
 * and it gets back a device id. That device id is not a credential: the user
 * still signs in inside the instance window, and every request there is
 * authorised by that session. The server re-checks licence state on every write
 * regardless of what this application believes.
 *
 * `window.__TAURI__` rather than an `@tauri-apps/api` import, because this page
 * ships as plain files with no bundler. A hundred lines do not justify a build
 * step whose output would be one more thing to get wrong — and the global only
 * exists in webviews that have IPC at all, which is this one and not the
 * instance window.
 */
const { invoke } = window.__TAURI__.core

const form = document.querySelector('#connect')
const originField = document.querySelector('#origin')
const codeField = document.querySelector('#code')
const submit = document.querySelector('#submit')
const errorBox = document.querySelector('#error')

const showError = (message) => {
  errorBox.textContent = message
  errorBox.hidden = !message
}

/** Formats as the user types: uppercase, and a dash after four characters. */
codeField.addEventListener('input', () => {
  const raw = codeField.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8)
  codeField.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
})

/** Already paired? Go straight through, and re-check that we are still allowed. */
async function resume() {
  const saved = await invoke('load_connection')
  if (!saved) return false

  try {
    const response = await fetch(`${saved.origin}/api/desktop/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'heartbeat',
        deviceId: saved.device_id,
        appVersion: await invoke('app_version'),
      }),
    })
    const body = await response.json()

    if (body.ok === false) {
      // Revoked by an administrator, or the workspace no longer knows this
      // machine. Forget it locally and make the user pair again — that is the
      // whole point of revocation, and it must not be skippable by staying
      // offline for ever.
      await invoke('forget_connection')
      showError('This computer was removed from the workspace. Pair it again to continue.')
      originField.value = saved.origin
      return false
    }
  } catch {
    // The instance is unreachable — a laptop on a train, or a server being
    // restarted. That is not a revocation, so it does not un-pair anything:
    // the window opens and the web application shows its own offline state.
  }

  await invoke('open_instance', { origin: saved.origin })
  return true
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  showError('')
  submit.disabled = true
  submit.textContent = 'Connecting…'

  try {
    const origin = originField.value.trim()
    const code = codeField.value.trim()
    if (!origin || !code) {
      showError('Enter the workspace address and the pairing code.')
      return
    }

    // An EMAIL ADDRESS is the mistake people actually make here, because every
    // other field in every other setup form wants one. Left to itself the app
    // prefixed it with https://, failed to resolve it, and reported "Could not
    // reach that address" — technically true, useless to act on, and it happened
    // in testing within a minute of the window opening.
    const addressProblem = describeAddressProblem(origin)
    if (addressProblem) {
      showError(addressProblem)
      return
    }

    // Validated in Rust, which is also what stores it: https only, no embedded
    // credentials, origin only. Doing it there rather than here means the
    // check cannot be skipped by a different caller later.
    const [fingerprint, platform, appVersion] = await Promise.all([
      invoke('device_fingerprint'),
      invoke('platform_name'),
      invoke('app_version'),
    ])

    const response = await fetch(`${normalise(origin)}/api/desktop/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'redeem', code, fingerprint, platform, appVersion }),
    })

    const body = await response.json().catch(() => ({}))
    if (!response.ok || !body.ok) {
      showError(body.error ?? 'That pairing code is not valid. Ask for a new one.')
      return
    }

    await invoke('save_connection', { origin: normalise(origin), deviceId: body.deviceId })
    await invoke('open_instance', { origin: normalise(origin) })
  } catch (err) {
    // A wrong address is the overwhelmingly likely cause, so say that rather
    // than showing a fetch error nobody can act on.
    showError(
      typeof err === 'string'
        ? err
        : 'Could not reach that address. Check it and try again.',
    )
  } finally {
    submit.disabled = false
    submit.textContent = 'Connect'
  }
})

/** Mirrors the Rust check well enough to build a URL. Rust remains the
 *  authority — this only avoids a pointless round trip on an obvious typo. */
function normalise(input) {
  const trimmed = input.trim().replace(/\/+$/, '')
  return trimmed.includes('://') ? trimmed : `https://${trimmed}`
}

/**
 * Why what was typed cannot be a workspace address, in words that say what to do
 * instead. Returns null when it looks plausible — the real validation is in Rust,
 * which is also what stores it; this only exists to fail EARLIER and more clearly
 * than a DNS lookup does.
 */
function describeAddressProblem(input) {
  const raw = input.trim()

  if (raw.includes('@')) {
    return 'That looks like an email address. Paste the web address you open in the browser, like https://example.syncrese.app.'
  }

  let url
  try {
    url = new URL(normalise(raw))
  } catch {
    return 'That is not a web address. It should look like https://example.syncrese.app.'
  }

  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    return 'The address must start with https:// — your session cookie travels over it.'
  }

  // A bare word with no dot is a hostname that cannot resolve on the internet.
  // localhost is the exception, and it is a real one during development.
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') {
    return 'That address is incomplete. It needs a full host name, like example.syncrese.app.'
  }

  return null
}

resume().then((resumed) => {
  if (!resumed) originField.focus()
})
