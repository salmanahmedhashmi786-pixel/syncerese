//! Running the application on this machine.
//!
//! In standalone mode there is no hosted instance to point at: this process
//! starts one. `desktop/sidecar` ships beside the binary and holds a Node
//! runtime, the built application and the migrations; the launcher inside it
//! brings up PGlite, issues a TLS certificate and serves HTTPS.
//!
//! # Why the child is watched rather than just spawned
//!
//! First run applies twenty-five migrations into an empty database and takes a
//! couple of minutes on modest hardware. A window opened before that finishes
//! shows errors, so the launcher prints `SYNCRESE_READY <url>` only once the
//! database actually answers, and this waits for that line. Everything else it
//! prints is forwarded to the shell window as a progress event, because two
//! minutes of a motionless splash screen is indistinguishable from a hang.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// Generous, because the first run is genuinely slow and the failure mode of
/// being too eager is worse: the user is told it did not start, while it is
/// still working, and starts it again on top of itself.
const READY_TIMEOUT: Duration = Duration::from_secs(900);

/// Starts the bundled server and returns the URL it is serving.
///
/// `share_on_lan` decides whether other machines in the office can reach it. Off
/// means the listener binds loopback and is not merely firewalled but absent
/// from the network, which is the right default for a single-user install.
pub fn start(app: &AppHandle, share_on_lan: bool) -> Result<(Child, String), String> {
    let sidecar = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Could not locate the application files: {e}"))?
        .join("sidecar");

    let node = sidecar.join(if cfg!(windows) { "node.exe" } else { "node" });
    let launcher = sidecar.join("launcher.mjs");

    if !node.exists() || !launcher.exists() {
        return Err(format!(
            "The application files are incomplete — expected a runtime and launcher in {}. \
             Reinstall Syncrèse.",
            sidecar.display()
        ));
    }

    let mut child = Command::new(&node)
        .arg(&launcher)
        .current_dir(&sidecar)
        .env("SYNCRESE_DESKTOP", "1")
        .env("SYNCRESE_SHARE_LAN", if share_on_lan { "1" } else { "0" })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start the application server: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The application server produced no output.".to_string())?;

    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let handle = app.clone();

    // Read on a separate thread: the pipe must keep being drained even after the
    // ready line, or the child eventually blocks writing into a full buffer and
    // the whole application freezes some minutes after it looked fine.
    std::thread::spawn(move || {
        let mut announced = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(url) = line.strip_prefix("SYNCRESE_READY ") {
                if !announced {
                    announced = true;
                    let _ = tx.send(Ok(url.trim().to_string()));
                }
                continue;
            }
            let _ = handle.emit("server-progress", line.clone());
            println!("{line}");
        }
        // The stream ended. If that happened before the ready line, the server
        // died during startup and the waiting side must be told rather than left
        // on the timeout.
        if !announced {
            let _ = tx.send(Err(
                "The application server stopped before it finished starting.".to_string()
            ));
        }
    });

    // stderr likewise, or a crash message sits unread in a pipe nobody drains.
    if let Some(stderr) = child.stderr.take() {
        let handle = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = handle.emit("server-progress", line.clone());
                eprintln!("{line}");
            }
        });
    }

    match rx.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(url)) => Ok((child, url)),
        Ok(Err(message)) => {
            let _ = child.kill();
            Err(message)
        }
        Err(_) => {
            let _ = child.kill();
            Err(format!(
                "The application server did not finish starting within {} minutes.",
                READY_TIMEOUT.as_secs() / 60
            ))
        }
    }
}
