//! `huginndb.exe --update` and friends: the app with no window.
//!
//! Branched off at the very top of [`crate::run`], before `tauri::Builder`:
//! building `AppState` writes state files (it can migrate `tab_state.json`),
//! and the single-instance plugin would forward this process to an open
//! window and bring it to the front. Nothing here loads the app's state; the
//! only file it reads is `prefs.json`.
//!
//! The check itself goes through `tauri-plugin-updater`, the same code, feed
//! and minisign key the interface uses, on a minimal `tauri::App` built from
//! the real context with its windows removed and the installer switched to
//! `quiet` (`passive` shows a progress window). The app is built but never
//! run: the updater needs a handle, not an event loop.

use std::fs::File;

use tauri_plugin_updater::UpdaterExt;

use super::record::{self, RunOutcome};
use super::{decide, process, schedule, Decision, Facts, Request, Trigger};

/// Run `request` and return the process exit code. Always `0` unless the
/// runtime itself could not be built: a deferred or failed update is a normal
/// outcome, recorded, and Task Scheduler has nothing useful to do with a
/// non-zero code.
pub fn run(request: Request, context: impl FnOnce() -> tauri::Context<tauri::Wry>) -> i32 {
    let mut ctx = context();
    let product = ctx
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "HuginnDB".into());
    let Ok(exe) = std::env::current_exe() else {
        record::log("cannot resolve the executable's own path; nothing done");
        return 0;
    };
    let enabled = crate::prefs::load_preferences().updates.auto_install;

    match request {
        Request::EnsureSchedule => {
            record::save_schedule(schedule::reconcile(&product, &exe, enabled, true));
            0
        }
        Request::RemoveSchedule => {
            schedule::remove(&product);
            record::log("schedule removed");
            0
        }
        Request::Update(trigger) => {
            let Some(_lock) = lock() else {
                record::save_run(trigger, RunOutcome::Busy);
                return 0;
            };
            if !enabled && trigger != Trigger::Manual {
                record::save_run(trigger, RunOutcome::Disabled);
                return 0;
            }
            // Self-repair: a task the installer could not create, or that
            // someone deleted, is filled back in. Missing ones only — see
            // `schedule::reconcile` on why this never recreates.
            if trigger != Trigger::Manual {
                record::save_schedule(schedule::reconcile(&product, &exe, enabled, false));
            }
            prepare(&mut ctx);
            match check_and_install(ctx, trigger, &exe) {
                Ok(outcome) => record::save_run(trigger, outcome),
                Err(message) => record::save_run(trigger, RunOutcome::Failed { message }),
            }
            0
        }
    }
}

/// No window, silent installer.
fn prepare(ctx: &mut tauri::Context<tauri::Wry>) {
    let config = ctx.config_mut();
    config.app.windows.clear();
    if let Some(serde_json::Value::Object(updater)) = config.plugins.0.get_mut("updater") {
        let windows = updater
            .entry("windows")
            .or_insert_with(|| serde_json::json!({}));
        if let serde_json::Value::Object(windows) = windows {
            windows.insert("installMode".into(), "quiet".into());
        }
    }
}

fn check_and_install(
    ctx: tauri::Context<tauri::Wry>,
    trigger: Trigger,
    exe: &std::path::Path,
) -> Result<RunOutcome, String> {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(ctx)
        .map_err(|e| format!("cannot start the updater: {e}"))?;
    let updater = app.updater().map_err(|e| e.to_string())?;

    tauri::async_runtime::block_on(async move {
        let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
            return Ok(RunOutcome::UpToDate);
        };
        let version = update.version.clone();

        let own_image = exe
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "huginndb".into());
        let facts = Facts {
            app_open: process::is_running(&own_image, Some(std::process::id())),
            connector_running: process::is_running("huginndb-mcp", None),
            trigger,
        };
        if let Decision::Defer(reason) = decide(facts) {
            return Ok(RunOutcome::Deferred { version, reason });
        }

        // Recorded before, because a successful install never returns: the
        // plugin starts the installer and exits this process.
        record::save_run(
            trigger,
            RunOutcome::Installing {
                version: version.clone(),
            },
        );
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| format!("installing {version}: {e}"))?;
        Ok(RunOutcome::Installing { version })
    })
}

/// One headless run at a time. The logon task and a `Run` value left over
/// from an earlier refusal can fire together, and the second would otherwise
/// see the first as an open interface and wait for nothing. An exclusive open
/// of a lock file is enough; Windows releases it when the process ends,
/// however it ends.
fn lock() -> Option<File> {
    use std::os::windows::fs::OpenOptionsExt;
    let path = crate::state_file::path("updater.lock").ok()?;
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .share_mode(0)
        .open(path)
        .ok()
}
