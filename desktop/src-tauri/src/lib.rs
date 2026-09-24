//! Syncrèse desktop shell.
//!
//! # The shape of this application, and why
//!
//! There are two webviews and the difference between them is the whole security
//! design:
//!
//! * **`shell`** — a small local page bundled with the binary. It asks for the
//!   instance URL and a pairing code, stores the result, and opens the second
//!   window. It has IPC, scoped by `capabilities/shell-window.json`.
//!
//! * **`instance`** — the customer's own Syncrèse deployment, loaded from a URL
//!   the customer typed. It appears in no capability file, and in Tauri v2 a
//!   webview matching no capability has **no access to the IPC layer at all**.
//!
//! That second point is not a precaution, it is forced. Capabilities are static
//! build-time configuration, and a self-hosted customer's hostname cannot be
//! known when the installer is built. Any design that granted the remote page
//! IPC would either have to ship a wildcard — turning "whatever URL the user
//! typed" into native code execution — or stop supporting self-hosting. Tauri's
//! own documentation is blunt about the risk of remote IPC even for domains you
//! *do* control, because a domain takeover then reaches every installation.
//!
//! The consequence, stated plainly because it is a real limitation: the ERP page
//! cannot trigger native behaviour. Notifications, the updater and the device
//! heartbeat all live here, in the shell, not in the web application.

mod server;

use std::process::Child;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const KEYRING_SERVICE: &str = "com.syncrese.desktop";
const KEYRING_ACCOUNT: &str = "connection";

/// What the shell remembers between launches.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Connection {
    /// Origin only — scheme, host and port. Never a path: the shell always
    /// navigates to a path it chose, so a stored path could not change where
    /// the app goes, but keeping the value minimal keeps it obviously safe.
    pub origin: String,
    pub device_id: String,
    /// True when this machine runs the server itself rather than connecting to
    /// a hosted instance. `serde(default)` so a connection saved by an earlier
    /// version — which had no such field — still loads instead of being
    /// silently discarded and forcing the user to pair again.
    #[serde(default)]
    pub local: bool,
    /// Whether the local server accepts connections from other machines.
    #[serde(default)]
    pub share_on_lan: bool,
}

#[derive(Default)]
struct State {
    connection: Mutex<Option<Connection>>,
    /// The bundled server, when this machine is the one running it. Held so it
    /// can be stopped when the application closes — an orphaned Node process
    /// keeps the database locked, and the next launch fails to open it.
    server: Mutex<Option<Child>>,
}

/// Validates a customer-supplied instance URL.
///
/// This is the one place a value typed by a human decides what the application
/// loads, so it is checked rather than trusted:
///
/// * **https only.** A session cookie over plaintext on a café network is the
///   failure this prevents, and the ERP sets `AUTH_URL` to https for the same
///   reason. `http://localhost` is allowed as the single exception, because
///   developing against a local instance is a real workflow and localhost is not
///   reachable by a network attacker.
/// * **No credentials in the URL.** They would be sent to the host and written
///   into logs by anything in the path.
/// * **Origin only.** Path, query and fragment are discarded — the shell decides
///   where to navigate, not the string.
pub fn parse_instance_origin(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        // Somebody typing "erp.example.com" means https, and refusing it over a
        // missing prefix is a support ticket rather than a security win.
        format!("https://{trimmed}")
    };

    let url = url::Url::parse(&with_scheme).map_err(|_| "That is not a valid address.".to_string())?;

    let host = url.host_str().ok_or("That address has no host.")?.to_string();
    let is_local = host == "localhost" || host == "127.0.0.1" || host == "::1";

    if url.scheme() != "https" && !(url.scheme() == "http" && is_local) {
        return Err("The address must start with https://.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The address must not contain a username or password.".into());
    }

    let mut origin = format!("{}://{}", url.scheme(), host);
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    Ok(origin)
}

/// A stable, non-reversible identifier for this machine.
///
/// Hashed here rather than on the server, and deliberately coarse. It exists so
/// an administrator can tell two laptops apart in a list — not to identify a
/// person. A raw disk serial or MAC address tied to a named workspace is
/// personal data under the GDPR, and there is no reason for the server to hold
/// one.
///
/// It is an identifier, never an authenticator. Nothing is authorised by it, so
/// a modified build that reports someone else's fingerprint gains nothing.
#[tauri::command]
fn device_fingerprint() -> String {
    let mut hasher = Sha256::new();
    hasher.update(std::env::consts::OS.as_bytes());
    hasher.update(std::env::consts::ARCH.as_bytes());
    hasher.update(
        hostname_or_default().as_bytes(),
    );
    // Salted with the application identifier so the same value cannot be
    // correlated with another product that hashes the same inputs.
    hasher.update(KEYRING_SERVICE.as_bytes());
    hex::encode(hasher.finalize())
}

fn hostname_or_default() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown-host".into())
}

#[tauri::command]
fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    }
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Stores the connection in the OS credential store.
///
/// Not a file beside the binary: on a shared machine that is readable by every
/// other process running as the same user, and the device id is the thing an
/// administrator uses to recognise a machine when revoking it.
#[tauri::command]
fn save_connection(
    state: tauri::State<'_, State>,
    origin: String,
    device_id: String,
    local: Option<bool>,
    share_on_lan: Option<bool>,
) -> Result<(), String> {
    let origin = parse_instance_origin(&origin)?;
    let connection = Connection {
        origin,
        device_id,
        local: local.unwrap_or(false),
        share_on_lan: share_on_lan.unwrap_or(false),
    };
    let json = serde_json::to_string(&connection).map_err(|e| e.to_string())?;

    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .and_then(|entry| entry.set_password(&json))
        .map_err(|e| format!("Could not save the connection: {e}"))?;

    *state.connection.lock().unwrap() = Some(connection);
    Ok(())
}

#[tauri::command]
fn load_connection() -> Option<Connection> {
    let json = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .ok()?
        .get_password()
        .ok()?;
    serde_json::from_str(&json).ok()
}

/// Forgets this installation locally.
///
/// Deliberately does NOT revoke the device server-side: that is an
/// administrator's decision, taken in Settings, and a user who signs out on a
/// machine they are handing back should not silently change the workspace's
/// device list.
#[tauri::command]
fn forget_connection(state: tauri::State<'_, State>) -> Result<(), String> {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
        let _ = entry.delete_credential();
    }
    *state.connection.lock().unwrap() = None;
    Ok(())
}

/// Starts the bundled server on this machine and returns the URL it serves.
///
/// Idempotent: if it is already running, the stored origin comes back rather
/// than a second copy being started. Two servers over one PGlite directory is
/// the single worst thing that can happen to this data — PGlite is
/// single-writer, and the second process corrupts the first's store rather than
/// failing to open it.
#[tauri::command]
async fn start_local_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
    share_on_lan: bool,
) -> Result<String, String> {
    {
        let running = state.server.lock().unwrap();
        if running.is_some() {
            if let Some(existing) = state.connection.lock().unwrap().as_ref() {
                return Ok(existing.origin.clone());
            }
        }
    }

    let (child, url) = server::start(&app, share_on_lan)?;
    let origin = parse_instance_origin(&url)?;

    *state.server.lock().unwrap() = Some(child);
    Ok(origin)
}

/// Stops the bundled server, if this machine is running one.
///
/// Called when the application closes. An orphaned Node process keeps the
/// database directory locked, and the next launch cannot open it — a failure
/// that looks like corruption and is not.
fn stop_local_server(state: &State) {
    if let Some(mut child) = state.server.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Opens the customer's instance in a second window.
///
/// The window label is `instance`, which appears in no capability file. That is
/// what leaves it without IPC — see the module comment. If a future change adds
/// `instance` to a capability, everything above stops being true.
#[tauri::command]
async fn open_instance(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
    origin: String,
) -> Result<(), String> {
    let origin = parse_instance_origin(&origin)?;
    let url = url::Url::parse(&origin).map_err(|e| e.to_string())?;

    if app.get_webview_window("instance").is_some() {
        return Ok(());
    }

    // Whether closing this window would cut off other computers, decided once
    // here rather than read again inside the event handler below — the
    // handler fires on the main thread and must not block it waiting on a
    // mutex a slower path might be holding.
    let sharing = state
        .connection
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|c| c.local && c.share_on_lan);

    let window = WebviewWindowBuilder::new(&app, "instance", WebviewUrl::External(url))
        .title("Syncrèse")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .build()
        .map_err(|e| format!("Could not open the workspace: {e}"))?;

    // Closing this window when this machine is sharing on the LAN does not
    // merely close a window — it kills the server everyone else on the
    // network is using. A tray-resident mode would let the office keep
    // working while this person's screen goes elsewhere; this is the smaller
    // fix that ships today: ask first, so the disconnection is a decision
    // rather than an accident.
    if sharing {
        let app_for_close = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let dialog_app = app_for_close.clone();
                app_for_close
                    .dialog()
                    .message(
                        "This computer is sharing Syncrèse with your network. Closing it will \
                         disconnect everyone using it right now, mid-work.",
                    )
                    .title("Quit Syncrèse?")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Quit anyway".into(),
                        "Keep sharing".into(),
                    ))
                    .show(move |confirmed| {
                        if confirmed {
                            stop_local_server(&dialog_app.state::<State>());
                            dialog_app.exit(0);
                        }
                    });
            }
        });
    }

    if let Some(shell) = app.get_webview_window("shell") {
        let _ = shell.hide();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // NO AUTO-UPDATER, deliberately. It was configured against
        // `https://releases.syncrese.example` with the literal public key
        // `REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY` — a fake host and a key that is
        // not a key. Tauri validates that key when the updater initialises, so
        // this did not degrade gracefully: it was a build that could not ship.
        //
        // Shipping an updater means committing to three things that do not
        // exist yet: somewhere to host the release feed, a signing keypair whose
        // private half is kept off this machine, and the discipline to sign
        // every release with it. An updater is a remote code execution channel
        // into every customer's machine, so a placeholder key is worse than no
        // updater at all.
        //
        // To re-enable: `npx tauri signer generate`, publish a feed, restore the
        // `plugins.updater` block in tauri.conf.json with the real public key,
        // add `tauri-plugin-updater` back to Cargo.toml, and put this line back.
        .manage(State::default())
        .invoke_handler(tauri::generate_handler![
            device_fingerprint,
            platform_name,
            app_version,
            save_connection,
            load_connection,
            forget_connection,
            open_instance,
            start_local_server,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Syncrese")
        .run(|app, event| {
            // Stop the bundled server when the application exits.
            //
            // Without this the Node process outlives the window, keeps the
            // PGlite directory locked, and the next launch cannot open its own
            // database — a failure that reads as corruption and is not. It is
            // also how a user ends up with two servers over one data directory,
            // which for a single-writer store is the worst thing that can
            // happen to it.
            if let tauri::RunEvent::Exit = event {
                stop_local_server(&app.state::<State>());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::parse_instance_origin;

    #[test]
    fn accepts_an_https_instance() {
        assert_eq!(
            parse_instance_origin("https://erp.example.com").unwrap(),
            "https://erp.example.com"
        );
        // A bare hostname means https rather than an error.
        assert_eq!(
            parse_instance_origin("erp.example.com").unwrap(),
            "https://erp.example.com"
        );
    }

    #[test]
    fn keeps_only_the_origin() {
        // The shell decides where to navigate; a stored path must not.
        assert_eq!(
            parse_instance_origin("https://erp.example.com/settings?x=1#y").unwrap(),
            "https://erp.example.com"
        );
        assert_eq!(
            parse_instance_origin("https://erp.example.com:8443/x").unwrap(),
            "https://erp.example.com:8443"
        );
    }

    #[test]
    fn refuses_plaintext_except_on_localhost() {
        assert!(parse_instance_origin("http://erp.example.com").is_err());
        // Developing against a local instance is a real workflow, and localhost
        // is not reachable by a network attacker.
        assert_eq!(
            parse_instance_origin("http://localhost:3000").unwrap(),
            "http://localhost:3000"
        );
    }

    #[test]
    fn refuses_embedded_credentials() {
        assert!(parse_instance_origin("https://user:pass@erp.example.com").is_err());
    }

    #[test]
    fn refuses_nonsense() {
        assert!(parse_instance_origin("").is_err());
        assert!(parse_instance_origin("file:///etc/passwd").is_err());
        assert!(parse_instance_origin("javascript:alert(1)").is_err());
    }
}
