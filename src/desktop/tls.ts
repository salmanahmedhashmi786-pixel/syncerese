import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { networkInterfaces, hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { certDir } from './mode'

/**
 * The desktop server's own TLS certificate.
 *
 * WHY THIS EXISTS
 *
 * A LAN install serves the workspace to other machines in the office. Over
 * plain http every session cookie and every password crosses that network in
 * the clear, readable by anything else plugged into it. Desktop accounting
 * software has historically shrugged at this. There is no good reason to.
 *
 * There is also no certificate authority to ask — no internet, no domain name,
 * no Let's Encrypt. So the install issues its own and trusts its own, which is
 * what a CA is, scoped to one office.
 *
 * WHY WINDOWS' OWN CRYPTO RATHER THAN A LIBRARY
 *
 * The obvious choice is node-forge, or something wrapping it. node-forge
 * carries seven unfixed high-severity advisories — certificate chain
 * verification bypass and RSA signature forgery among them — with no patched
 * release. None of them plausibly applies to generating a certificate from our
 * own inputs, since they concern parsing hostile input, but software being sold
 * should not ship a dependency in that state to save a day, and Windows has had
 * this in the box since 8.1.
 *
 * The cost is that this path is Windows-only. That is the stated target, and it
 * fails loudly elsewhere rather than quietly falling back to http.
 *
 * WHY A CA AND A LEAF RATHER THAN ONE SELF-SIGNED CERTIFICATE
 *
 * Client machines trust the CA once. The leaf can then be reissued whenever the
 * host's address changes — routine on an office DHCP network — without every
 * client having to be touched again.
 */

export type Certificate = {
  /**
   * PKCS#12 blob holding the leaf, its key and the issuing CA.
   *
   * Node's TLS takes this directly. The obvious alternative — exporting a PEM
   * private key — needs `ExportPkcs8PrivateKey`, which is .NET Core only, and
   * Windows PowerShell 5.1 is .NET Framework. Rather than hand-assemble PKCS#8
   * ASN.1 or depend on PowerShell 7 being installed on a customer's machine,
   * the key never leaves PKCS#12 at all.
   */
  pfx: Buffer
  /** Passphrase for `pfx`. Random per issue, stored beside it — the directory
   *  is the security boundary here, not this string. */
  passphrase: string
  /** PEM of the CA, for clients to install. */
  caCert: string
  /** SHA-256 of the CA, colon-separated, as Windows displays it. */
  fingerprint: string
  /** Every name and address this certificate is valid for. */
  names: string[]
}

const CA_CERT = 'ca.crt'
const PFX = 'server.pfx'
const PFX_PASS = 'server.pass'
const NAMES = 'names.json'

const isIpv4 = (v: string): boolean => /^\d+\.\d+\.\d+\.\d+$/.test(v)

/** Every name and address a client might legitimately use to reach this host. */
export function subjectNames(): string[] {
  const names = new Set<string>(['localhost', hostname().toLowerCase()])
  const ips = new Set<string>(['127.0.0.1'])
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      // 169.254.x is what an interface gets when DHCP failed. Nobody reaches
      // this machine there deliberately.
      if (iface.internal || iface.address.startsWith('169.254.')) continue
      if (iface.family === 'IPv4') ips.add(iface.address)
    }
  }
  return [...names, ...ips]
}

/** Runs a PowerShell script from a file. Written to disk rather than passed with
 *  -Command so that quoting and backtick continuations cannot be mangled twice
 *  on the way through a shell. */
function powershellFile(script: string): string {
  const file = path.join(tmpdir(), `syncrese-${randomBytes(8).toString('hex')}.ps1`)
  writeFileSync(file, script, 'utf8')
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    )
  } finally {
    rmSync(file, { force: true })
  }
}

/**
 * Returns the certificate, issuing one if there is none, or if this machine has
 * gained an address the current certificate does not cover.
 *
 * That second case is the one that bites in an office: the host picks up a new
 * DHCP lease and every client starts failing with a certificate error rather
 * than anything pointing at the real cause.
 */
export function ensureCertificate(): Certificate {
  if (process.platform !== 'win32') {
    throw new Error(
      'The desktop server issues its own TLS certificate using Windows CryptoAPI, and this is ' +
        'not Windows. Serving the office network over plain http is not an alternative this ' +
        'code will pick on your behalf.',
    )
  }

  const dir = certDir()
  mkdirSync(dir, { recursive: true })
  const at = (f: string) => path.join(dir, f)
  const wanted = subjectNames()

  const present =
    existsSync(at(CA_CERT)) && existsSync(at(PFX)) && existsSync(at(PFX_PASS)) && existsSync(at(NAMES))

  if (present) {
    const covered = JSON.parse(readFileSync(at(NAMES), 'utf8')) as string[]
    if (wanted.every((n) => covered.includes(n))) return read(at, covered)
    console.log('[syncrese] this machine has a new address — reissuing the certificate')
  }

  issue(dir, wanted)
  return read(at, wanted)
}

function read(at: (f: string) => string, names: string[]): Certificate {
  const caCert = readFileSync(at(CA_CERT), 'utf8')
  return {
    // The PFX already carries the leaf, its key and the issuing CA, so Node
    // presents the full chain without any assembly here.
    pfx: readFileSync(at(PFX)),
    passphrase: readFileSync(at(PFX_PASS), 'utf8').trim(),
    caCert,
    fingerprint: fingerprintOf(caCert),
    names,
  }
}

/**
 * Creates the CA and the leaf, exports both, and removes them from the Windows
 * certificate store again.
 *
 * The store is scratch space only — `New-SelfSignedCertificate` cannot write
 * straight to a file. Leaving them in `Cert:\CurrentUser\My` would abandon a CA
 * signing key somewhere nothing here manages the lifetime of.
 */
function issue(dir: string, names: string[]): void {
  const dns = names.filter((n) => !isIpv4(n))
  const ips = names.filter(isIpv4)
  const san = [...dns.map((d) => `DNS=${d}`), ...ips.map((i) => `IPAddress=${i}`)].join('&')
  const cn = dns[1] ?? 'localhost'
  const esc = (p: string) => p.replace(/'/g, "''")
  const pfxOut = path.join(dir, PFX)
  const passphrase = randomBytes(24).toString('base64url')

  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$ca = New-SelfSignedCertificate -Type Custom -Subject 'CN=Syncrese Local CA' -KeyUsage CertSign,CRLSign,DigitalSignature -KeyUsageProperty All -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(10) -CertStoreLocation 'Cert:\\CurrentUser\\My' -TextExtension @('2.5.29.19={text}CA=true&pathlength=0')`,
    `$leaf = New-SelfSignedCertificate -Type SSLServerAuthentication -Subject 'CN=${cn}' -TextExtension @('2.5.29.17={text}${san}') -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(10) -CertStoreLocation 'Cert:\\CurrentUser\\My' -Signer $ca`,
    // -ChainOption BuildChain puts the issuing CA inside the PFX, so Node
    // presents the whole chain and a client that trusts the CA can verify it
    // without being handed anything else.
    `$pw = ConvertTo-SecureString -String '${esc(passphrase)}' -Force -AsPlainText`,
    `Export-PfxCertificate -Cert $leaf -FilePath '${esc(pfxOut)}' -Password $pw -ChainOption BuildChain | Out-Null`,
    `$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My','CurrentUser')`,
    `$store.Open('ReadWrite')`,
    `foreach ($t in @($ca.Thumbprint, $leaf.Thumbprint)) { $c = $store.Certificates | Where-Object { $_.Thumbprint -eq $t }; if ($c) { $store.Remove($c) } }`,
    `$store.Close()`,
    `Write-Output '---CA---'`,
    `Write-Output ([Convert]::ToBase64String($ca.RawData, 'InsertLineBreaks'))`,
  ].join('\n')

  const out = powershellFile(script)
  writeFileSync(path.join(dir, CA_CERT), pem(between(out, '---CA---', null)))
  writeFileSync(path.join(dir, PFX_PASS), passphrase, { mode: 0o600 })
  writeFileSync(path.join(dir, NAMES), JSON.stringify(names, null, 2))

  console.log(`[syncrese] issued a certificate for ${names.join(', ')}`)
}

function between(out: string, from: string, to: string | null): string {
  const start = out.indexOf(from)
  if (start === -1) throw new Error(`certificate generation produced no ${from} section`)
  const end = to ? out.indexOf(to) : out.length
  return out.slice(start + from.length, end).trim()
}

const pem = (b64: string): string =>
  `-----BEGIN CERTIFICATE-----\n${b64.trim()}\n-----END CERTIFICATE-----\n`

export function fingerprintOf(pemText: string): string {
  const der = Buffer.from(pemText.replace(/-----[^-]+-----|\s/g, ''), 'base64')
  return (createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g) ?? []).join(':')
}

/**
 * Installs the CA into the CURRENT USER's trust store, so the webview stops
 * complaining without anybody being asked anything.
 *
 * CurrentUser rather than LocalMachine: LocalMachine needs administrator
 * rights, and an installer demanding elevation in order to add a root
 * certificate is one a user is right to be suspicious of. CurrentUser is
 * enough — Edge, Chrome and WebView2 all consult it.
 *
 * Returns whether it worked. The caller carries on regardless: a certificate
 * warning is a bad experience and refusing to start is a worse one.
 *
 * ON REVOCATION, because this looks broken before it is understood.
 *
 * A local CA publishes no revocation list — there is nowhere to publish one, and
 * nothing to revoke. Windows' chain engine notices, and STRICT clients treat the
 * inconclusive check as fatal: curl's schannel backend refuses outright with
 * CERT_TRUST_REVOCATION_STATUS_UNKNOWN, which reads like a broken certificate
 * and is not one.
 *
 * Browsers do not. Verified in a real engine against this exact certificate:
 * the page loads with no warning and reports isSecureContext true, so the
 * connection is trusted rather than excused. That is what matters, because a
 * browser engine is what renders this application.
 *
 * If you are testing with curl, pass --ssl-no-revoke. Nothing is wrong.
 */
export function trustCaLocally(): boolean {
  if (process.platform !== 'win32') return false
  try {
    execFileSync('certutil', ['-user', '-addstore', 'Root', path.join(certDir(), CA_CERT)], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}
