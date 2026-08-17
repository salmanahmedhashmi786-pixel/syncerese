# The desktop app

A Tauri v2 shell around a deployed Syncrèse instance. Source in [`desktop/`](../desktop).

> **Built and verified.** `Syncrese_1.0.0_x64-setup.exe`, an MSI and the standalone binary
> are produced by the steps below. The window opens, WebView2 renders the pairing UI, and
> the icon and version metadata are embedded correctly. The installers are **unsigned** —
> see Signing.

---

## What it is

Two webviews, and the difference between them is the entire security design.

| Window | Content | IPC |
| --- | --- | --- |
| `shell` | A local page bundled in the binary: workspace address, pairing code | **Yes**, scoped by `capabilities/shell-window.json` |
| `instance` | The customer's own deployment, at a URL they typed | **None** |

The second row is forced, not chosen. Tauri capabilities are **static build-time
configuration**, and a self-hosted customer's hostname cannot be known when the installer is
built. Granting the remote page IPC would mean shipping a wildcard — turning "whatever URL
the user typed" into native code execution — or dropping self-hosting. Tauri's own docs warn
against remote IPC even for domains you control, because a domain takeover then reaches
every installation. In Tauri v2 a webview matching no capability has no access to the IPC
layer at all, which is exactly the behaviour wanted here.

**The limitation this creates, stated plainly:** the ERP page cannot trigger native
behaviour. Notifications, the updater and the device heartbeat live in the shell, not in the
web application. A future "print this invoice natively" feature cannot simply call from the
page; it would need a design that does not involve trusting remote content.

---

## Pairing

The shell and the signed-in page cannot talk to each other — that is the point above — so
the user carries a code between them.

1. In the browser: **Settings → Devices → Pair a computer**. A code like `6GG0-8SK7`,
   good for ten minutes, single use.
2. In the desktop app: the workspace address and that code.
3. The shell POSTs `{action: 'redeem', code, fingerprint, platform, appVersion}` to
   `/api/desktop/pair` and gets back a device id.
4. The instance window opens. **The user signs in there, normally.**

The obvious alternative — having the shell send the product key — is worse than it looks: it
turns the product key into a bearer credential travelling from every installation, and needs
its own throttle or it becomes an oracle for guessing keys.

### A device id is not a credential

Worth being explicit, because it is the natural misreading and the requirement warns against
exactly this. Pairing records that a machine exists. It authenticates nobody. The only thing
a device id can do is ask "am I still allowed to run", and the only answer is yes or no.

The server remains the authority on everything else: sessions authorise requests, and licence
state is re-checked server-side on every write. A modified desktop build that lied about its
fingerprint, or replayed someone else's device id, would gain nothing.

Codes are stored hashed with a four-character prefix. Machine fingerprints are hashed on the
client and never sent raw — a disk serial or MAC address tied to a named workspace is
personal data, and there is no reason for the server to hold one.

### Revocation

**Settings → Devices → Revoke.** The next heartbeat returns `ok: false`, the shell forgets
the connection locally, and the app asks to be paired again. It works without the holder's
cooperation, which is the point for a stolen laptop.

Revoked and never-existed answer identically, so probing device ids reveals nothing. A
revoked machine can be paired again with a fresh code — a mistaken revocation must be
recoverable.

Revoking a device does **not** revoke the person. They can still sign in from a browser. If
the intent is to remove someone, deactivate the member instead.

---

## Building it

### Prerequisites

**Windows needs no administrator rights.** An earlier version of this page said it did — that
Tauri required Visual Studio Build Tools and an elevated shell. That is the documented path,
but it is not the only one, and the alternative installs entirely into your user profile.

Two commands, neither elevated:

```powershell
winget install --id BrechtSanders.WinLibs.POSIX.UCRT -e --scope user
```

Rustup has no user-scope winget package, so fetch it directly and ask for the GNU toolchain:

```powershell
Invoke-WebRequest https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe -OutFile "$env:TEMP\rustup-init.exe"
& "$env:TEMP\rustup-init.exe" -y --default-toolchain stable-x86_64-pc-windows-gnu --profile minimal
```

The GNU toolchain (`x86_64-pc-windows-gnu`) links with MinGW rather than Microsoft's
`link.exe`. It is not Tauri's officially supported Windows target — but it builds this
application, produces both bundles, and the result runs.

If you would rather stay on the supported MSVC path, install Visual Studio Build Tools with
the C++ workload from an **elevated** shell and skip the two commands above:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

WebView2 is already present on Windows 11; the bundle downloads it if missing.

- **macOS** — Xcode command line tools (`xcode-select --install`).
- **Linux** — `libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.

### Four things that will go wrong on the GNU path

All four cost a build each, and none of them says what it means.

**`error calling dlltool 'dlltool.exe': program not found`.** It exists, in
`…/rustlib/x86_64-pc-windows-gnu/bin/self-contained/`, which cargo does not put on PATH.

**`dlltool.exe: CreateProcess`.** dlltool found, but it shells out to the GNU assembler and
rustup's minimal profile ships no `as.exe`. This is what the WinLibs install above fixes; put
its `mingw64\bin` **ahead** of the rustup toolchain on PATH so the complete set wins.

**`cc1.exe: fatal error: Claude\ERP\: No such file or directory`.** `windres` cannot parse
spaces in paths. The repository lives at `D:\Softwares Claude\ERP system`, and windres splits
it at the space. Build from a path without spaces — copy `desktop/` to `C:\syncbuild\` and
build there. Worth knowing generally: this directory name will break other Windows toolchains
in equally cryptic ways.

**`Permission updater:default not found`.** A capability in `capabilities/` naming a plugin
that is not loaded. Tauri validates permissions against registered plugins at build time and
refuses — correctly. This one was real: the updater was removed and its capability entry was
not.

### Then build it

```powershell
cd desktop
npm install
npm run build
```

The installers land in `desktop/src-tauri/target/release/bundle/` — `msi/` and `nsis/` on
Windows. The `.exe` inside `nsis/` is the one to hand somebody.

Expect the first build to take a while: it compiles the whole Rust dependency tree, several
hundred crates, and nothing is cached yet.

### Running and building

```bash
cd desktop && npm install && npm run dev
```

```bash
cd desktop && npm run build
```

The Rust unit tests cover the instance-URL validation, which is the one place a
customer-typed value decides what the application loads:

```bash
cd desktop/src-tauri && cargo test
```

Cross-compiling is not worth attempting. Build each platform on that platform, in CI.

---

## Signing — the part that needs your accounts

Unsigned desktop software is a support problem, not a security preference: Windows
SmartScreen warns on every download until a reputation accrues, and macOS Gatekeeper simply
refuses to open it.

| Platform | What you need | Rough cost |
| --- | --- | --- |
| Windows | An **OV or EV code-signing certificate** (DigiCert, Sectigo, SSL.com). EV avoids the SmartScreen reputation delay. Since June 2023 the private key must live on hardware or in a cloud HSM. | ~$200–600/yr |
| macOS | **Apple Developer Program** membership, a Developer ID Application certificate, and notarisation. Without notarisation Gatekeeper blocks it. | $99/yr |
| Linux | Nothing required. | — |

Neither can be obtained on your behalf: both need identity verification against your
registered business.

### The updater key is separate

Tauri's updater verifies release manifests with its own signing key, unrelated to the OS
certificates:

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/syncrese.key
```

The **public** key goes in `tauri.conf.json` under `plugins.updater.pubkey`. The private key
signs each release and belongs in a secret store, never in the repository.

Losing it means shipping a new installer to every user by hand, because existing
installations will not accept updates signed by anything else. Back it up separately from
the repository, like `ENCRYPTION_KEY`.

### The updater has been removed, not configured

It was pointed at `https://releases.syncrese.example` with the literal public key
`REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY`. Tauri validates that key when the plugin
initialises, so it did not degrade into a dormant feature — it was a build that could not
ship. The plugin, its dependency and its configuration are all gone.

That is the honest default. An updater is a remote code execution channel into every
customer's machine, and turning it on means committing to three things that do not exist
yet: somewhere to host the release feed, a signing keypair whose private half never touches
a build machine, and the discipline to sign every release with it. A placeholder key is
worse than no updater at all.

To turn it on later: `npx tauri signer generate`, publish an **https** feed, restore the
`plugins.updater` block with the real public key, put `tauri-plugin-updater` back in
`Cargo.toml`, and restore the `.plugin(...)` line in `src/lib.rs` — it is commented in place
with these instructions.

### Still to replace before shipping

- `identifier` — `com.syncrese.desktop` should match a domain you own.

The updater endpoint must be **https**. It tells every installation what to download and
run, so a plaintext one is a remote code execution channel on your entire customer base.

---

## What is deliberately not here

- **Offline mode.** The app is a client of a deployed instance. Real offline support means a
  local replica and a conflict-resolution story for double-entry accounting, which is a
  larger project than this shell.
- **In-app payment.** Billing stays on the web, through Stripe Checkout and the Billing
  Portal, per the product decision. The desktop app never handles card details.
- **Client-side licence enforcement.** Anything the desktop believed about seats would be
  bypassable by the person who owns the machine. The server decides.
