//! Who launches the headless updater, in layers.
//!
//! A domain administrator can forbid any one mechanism, so none of them is
//! load-bearing on its own:
//!
//! 1. Two scheduled tasks for the current user, registered from XML: one at
//!    logon, one daily. XML rather than `schtasks /SC ONLOGON`, which needs an
//!    administrator; a `LogonTrigger` scoped to the registering user is what a
//!    standard account can create. Blocked by the "Prohibit New Task Creation"
//!    policy.
//! 2. When the logon task is refused, a value under
//!    `HKCU\...\CurrentVersion\Run` does the same job at the next sign-in.
//!    Blocked by "Do not process the legacy run list".
//! 3. When both are refused, the schedule is [`Mechanism::Manual`], recorded
//!    with what Windows said, and Settings → About shows it. The interface's
//!    own updater still works whenever someone opens the app.
//!
//! Nothing here tries to get around a restriction; a refusal is reported, not
//! retried a different way.
//!
//! Tasks live in the root folder because creating a folder under it needs an
//! administrator. They are named from the bundle's `productName`, so the
//! canary's are separate from the stable build's.

use serde::{Deserialize, Serialize};
use std::path::Path;

use super::Trigger;

/// Which layer is in force.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mechanism {
    /// Both scheduled tasks.
    Tasks,
    /// The logon task, without the daily one.
    LogonTaskOnly,
    /// The `Run` value at logon plus the daily task.
    RunValueAndDaily,
    /// Only the `Run` value.
    RunValueOnly,
    /// Only the daily task.
    DailyTaskOnly,
    /// Nothing could be registered: updates wait for the interface.
    Manual,
    /// Background installs are off in Settings, so the schedule was removed.
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleOutcome {
    pub mechanism: Mechanism,
    pub detail: Option<String>,
}

/// What each layer's registration came to. `run_value` is `None` when it was
/// not attempted because the logon task took.
fn combine(
    logon_task: &Result<(), String>,
    daily_task: &Result<(), String>,
    run_value: Option<&Result<(), String>>,
) -> ScheduleOutcome {
    let logon_ok = logon_task.is_ok();
    let run_ok = matches!(run_value, Some(Ok(())));
    let daily_ok = daily_task.is_ok();
    let mechanism = match (logon_ok, run_ok, daily_ok) {
        (true, _, true) => Mechanism::Tasks,
        (true, _, false) => Mechanism::LogonTaskOnly,
        (false, true, true) => Mechanism::RunValueAndDaily,
        (false, true, false) => Mechanism::RunValueOnly,
        (false, false, true) => Mechanism::DailyTaskOnly,
        (false, false, false) => Mechanism::Manual,
    };
    let errors: Vec<&str> = [Some(logon_task), Some(daily_task), run_value]
        .into_iter()
        .flatten()
        .filter_map(|r| r.as_ref().err().map(String::as_str))
        .collect();
    ScheduleOutcome {
        mechanism,
        detail: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}

pub fn task_name(product: &str, trigger: Trigger) -> String {
    match trigger {
        Trigger::Daily => format!("{product} Update (daily)"),
        _ => format!("{product} Update (logon)"),
    }
}

pub fn run_value_name(product: &str) -> String {
    format!("{product} Update")
}

pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// The task definition. `user` is `DOMAIN\name`: both the logon trigger and
/// the principal are scoped to it, which is what lets a standard account
/// register the task at all.
fn task_xml(exe: &Path, trigger: Trigger, user: &str) -> String {
    let user = xml_escape(user);
    let trigger_xml = match trigger {
        // Around midday with up to two hours' jitter, so a fleet does not hit
        // the feed at the same second; `StartWhenAvailable` catches up a day
        // the machine was off.
        Trigger::Daily => "<CalendarTrigger>\
             <StartBoundary>2026-01-01T12:00:00</StartBoundary>\
             <Enabled>true</Enabled>\
             <RandomDelay>PT2H</RandomDelay>\
             <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>\
             </CalendarTrigger>"
            .to_string(),
        // A minute after sign-in: the network is usually up by then, and it is
        // still well before anyone has opened an AI client.
        _ => format!(
            "<LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId><Delay>PT1M</Delay></LogonTrigger>"
        ),
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Keeps HuginnDB and its MCP connector up to date. Removed when HuginnDB is uninstalled or background updates are turned off in Settings.</Description>
  </RegistrationInfo>
  <Triggers>{trigger_xml}</Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>{arg}</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        exe = xml_escape(&exe.display().to_string()),
        arg = trigger.arg(),
    )
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The `Run` value's command line.
fn run_value_command(exe: &Path) -> String {
    format!("\"{}\" {}", exe.display(), Trigger::Logon.arg())
}

/// Make the schedule match the preference.
///
/// `force` recreates tasks that already exist, which is what the installer
/// wants (the executable may have moved) and a preference change wants. The
/// app's startup and every headless run pass `false` and only fill in what is
/// missing — recreating a task from inside a run of that same task is not
/// something to do on every tick.
pub fn reconcile(product: &str, exe: &Path, enabled: bool, force: bool) -> ScheduleOutcome {
    if !enabled {
        remove(product);
        return ScheduleOutcome {
            mechanism: Mechanism::Disabled,
            detail: None,
        };
    }
    ensure(product, exe, force)
}

#[cfg(windows)]
fn ensure(product: &str, exe: &Path, force: bool) -> ScheduleOutcome {
    let user = current_user();
    let register = |trigger: Trigger| {
        let name = task_name(product, trigger);
        if !force && sys::task_exists(&name) {
            return Ok(());
        }
        sys::create_task(&name, &task_xml(exe, trigger, &user))
    };
    let logon = register(Trigger::Logon);
    let daily = register(Trigger::Daily);
    let run_value = if logon.is_ok() {
        // The task does the job; a value left from an earlier refusal would
        // start a second run at every sign-in.
        sys::delete_run_value(&run_value_name(product));
        None
    } else {
        Some(sys::set_run_value(
            &run_value_name(product),
            &run_value_command(exe),
        ))
    };
    combine(&logon, &daily, run_value.as_ref())
}

#[cfg(not(windows))]
fn ensure(_product: &str, _exe: &Path, _force: bool) -> ScheduleOutcome {
    ScheduleOutcome {
        mechanism: Mechanism::Manual,
        detail: Some("background updates are only available on Windows".into()),
    }
}

/// Take away every layer. Nothing to report: absent is the goal either way.
pub fn remove(product: &str) {
    #[cfg(windows)]
    {
        sys::delete_task(&task_name(product, Trigger::Logon));
        sys::delete_task(&task_name(product, Trigger::Daily));
        sys::delete_run_value(&run_value_name(product));
    }
    #[cfg(not(windows))]
    let _ = product;
}

/// `DOMAIN\name` of the signed-in user. The environment is fine here: this
/// only names the account the user's own task runs as, and a wrong value makes
/// the registration fail rather than grant anything.
#[cfg(windows)]
fn current_user() -> String {
    let name = std::env::var("USERNAME").unwrap_or_else(|_| whoami::username());
    match std::env::var("USERDOMAIN") {
        Ok(domain) if !domain.is_empty() => format!("{domain}\\{name}"),
        _ => name,
    }
}

#[cfg(windows)]
mod sys {
    use crate::updater::process::CREATE_NO_WINDOW;
    use std::os::windows::process::CommandExt;

    fn schtasks(args: &[&str]) -> Result<(), String> {
        let out = std::process::Command::new("schtasks")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("schtasks: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            let text = String::from_utf8_lossy(&out.stderr);
            let text = if text.trim().is_empty() {
                String::from_utf8_lossy(&out.stdout)
            } else {
                text
            };
            Err(text.trim().to_string())
        }
    }

    pub fn task_exists(name: &str) -> bool {
        schtasks(&["/Query", "/TN", name]).is_ok()
    }

    pub fn create_task(name: &str, xml: &str) -> Result<(), String> {
        // `schtasks /XML` reads UTF-16 with a BOM reliably; UTF-8 with an
        // encoding declaration is refused as malformed on some builds.
        let path = std::env::temp_dir().join(format!(
            "huginndb-task-{}-{}.xml",
            std::process::id(),
            name.len()
        ));
        let bytes: Vec<u8> = std::iter::once(0xFEFF_u16)
            .chain(xml.encode_utf16())
            .flat_map(u16::to_le_bytes)
            .collect();
        std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        let result = schtasks(&[
            "/Create",
            "/F",
            "/TN",
            name,
            "/XML",
            &path.display().to_string(),
        ]);
        let _ = std::fs::remove_file(&path);
        result
    }

    pub fn delete_task(name: &str) {
        let _ = schtasks(&["/Delete", "/F", "/TN", name]);
    }

    pub fn set_run_value(name: &str, command: &str) -> Result<(), String> {
        windows_registry::CURRENT_USER
            .create(super::RUN_KEY)
            .and_then(|key| key.set_string(name, command))
            .map_err(|e| format!("HKCU\\{}: {e}", super::RUN_KEY))
    }

    pub fn delete_run_value(name: &str) {
        if let Ok(key) = windows_registry::CURRENT_USER.open(super::RUN_KEY) {
            let _ = key.remove_value(name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(msg: &str) -> Result<(), String> {
        Err(msg.to_string())
    }

    #[test]
    fn both_tasks_is_the_normal_case() {
        let out = combine(&Ok(()), &Ok(()), None);
        assert_eq!(out.mechanism, Mechanism::Tasks);
        assert_eq!(out.detail, None);
    }

    #[test]
    fn a_refused_logon_task_falls_back_to_the_run_value() {
        let out = combine(&refused("Access is denied."), &Ok(()), Some(&Ok(())));
        assert_eq!(out.mechanism, Mechanism::RunValueAndDaily);
        assert_eq!(out.detail.as_deref(), Some("Access is denied."));
    }

    #[test]
    fn no_task_creation_at_all_leaves_the_run_value() {
        let out = combine(&refused("policy"), &refused("policy"), Some(&Ok(())));
        assert_eq!(out.mechanism, Mechanism::RunValueOnly);
    }

    #[test]
    fn everything_refused_is_manual_and_says_why() {
        let out = combine(
            &refused("tasks prohibited"),
            &refused("tasks prohibited"),
            Some(&refused("run list disabled")),
        );
        assert_eq!(out.mechanism, Mechanism::Manual);
        assert_eq!(
            out.detail.as_deref(),
            Some("tasks prohibited; tasks prohibited; run list disabled")
        );
    }

    #[test]
    fn a_refused_run_value_with_a_daily_task_still_updates_daily() {
        let out = combine(&refused("a"), &Ok(()), Some(&refused("b")));
        assert_eq!(out.mechanism, Mechanism::DailyTaskOnly);
    }

    #[test]
    fn the_logon_task_without_the_daily_one_is_named_as_such() {
        let out = combine(&Ok(()), &refused("x"), None);
        assert_eq!(out.mechanism, Mechanism::LogonTaskOnly);
    }

    #[test]
    fn task_names_follow_the_product_so_canary_is_separate() {
        assert_eq!(
            task_name("HuginnDB", Trigger::Logon),
            "HuginnDB Update (logon)"
        );
        assert_eq!(
            task_name("HuginnDB Canary", Trigger::Daily),
            "HuginnDB Canary Update (daily)"
        );
    }

    #[test]
    fn the_logon_task_is_scoped_to_the_user_and_passes_its_trigger() {
        let xml = task_xml(
            Path::new(r"C:\Users\a&b\AppData\Local\HuginnDB\huginndb.exe"),
            Trigger::Logon,
            r"ITB\alopez",
        );
        assert!(xml.contains("<LogonTrigger>"));
        assert_eq!(xml.matches(r"<UserId>ITB\alopez</UserId>").count(), 2);
        assert!(xml.contains("<Arguments>--update=logon</Arguments>"));
        assert!(xml.contains(r"C:\Users\a&amp;b\AppData"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
    }

    #[test]
    fn the_daily_task_is_a_calendar_trigger_that_catches_up() {
        let xml = task_xml(Path::new(r"C:\x\huginndb.exe"), Trigger::Daily, "u");
        assert!(xml.contains("<CalendarTrigger>"));
        assert!(!xml.contains("<LogonTrigger>"));
        assert!(xml.contains("<StartWhenAvailable>true</StartWhenAvailable>"));
        assert!(xml.contains("<Arguments>--update=daily</Arguments>"));
    }

    /// The part no unit test can prove: that `schtasks` accepts the generated
    /// XML. Registers two tasks under a throwaway product name, checks them,
    /// and removes them. Run by hand (`cargo test -- --ignored`); on an
    /// administrator's account it says nothing about what a standard account
    /// may create — that is the domain test in the plan.
    #[cfg(windows)]
    #[test]
    #[ignore = "registers real scheduled tasks for a moment; run by hand"]
    fn schtasks_accepts_the_generated_tasks() {
        let product = "HuginnDB Selftest";
        let exe = std::env::current_exe().unwrap();
        let out = reconcile(product, &exe, true, true);
        let registered =
            [Trigger::Logon, Trigger::Daily].map(|t| sys::task_exists(&task_name(product, t)));
        remove(product);
        let left =
            [Trigger::Logon, Trigger::Daily].map(|t| sys::task_exists(&task_name(product, t)));
        assert_eq!(out.mechanism, Mechanism::Tasks, "{:?}", out.detail);
        assert_eq!(registered, [true, true]);
        assert_eq!(left, [false, false]);
    }

    #[test]
    fn the_run_value_quotes_the_executable() {
        assert_eq!(
            run_value_command(Path::new(r"C:\Program Files\HuginnDB\huginndb.exe")),
            r#""C:\Program Files\HuginnDB\huginndb.exe" --update=logon"#
        );
    }
}
