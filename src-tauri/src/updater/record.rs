//! What the silent updater last did, for the interface and for support.
//!
//! Two files beside the others in the config dir. `updater-state.json` holds
//! the latest answer to each question Settings → About asks — which schedule
//! is in force and why, what the last run did — and is rewritten whole.
//! `updater.log` is one line per event, capped at [`LOG_LINES`], because a
//! GUI-subsystem process has no console and "why did this PC not update last
//! Tuesday" is otherwise unanswerable.
//!
//! Every write here is best effort: failing to record a run must never be why
//! the run itself fails.

use serde::{Deserialize, Serialize};

use super::schedule::{Mechanism, ScheduleOutcome};
use super::{now_ms, DeferReason, Trigger};

pub const STATE_FILE: &str = "updater-state.json";
pub const LOG_FILE: &str = "updater.log";

/// How many lines `updater.log` keeps: two runs a day for three months.
pub const LOG_LINES: usize = 200;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdaterRecord {
    pub schedule: Option<ScheduleRecord>,
    pub last_run: Option<RunRecord>,
    /// The newest version a check has seen and not yet seen installed, and
    /// since when. Written by the headless updater and by the interface's
    /// own check; read by the MCP connector, which makes no request of its
    /// own ([`super::pending_notice`]).
    pub available: Option<Available>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub version: String,
    /// When this version was first seen. A newer one resets it: the clock is
    /// "how long has *this* update been waiting".
    pub first_seen_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRecord {
    pub mechanism: Mechanism,
    /// What Windows said when a layer was refused, verbatim (localised).
    pub detail: Option<String>,
    pub at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub at_ms: i64,
    pub trigger: Trigger,
    pub outcome: RunOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunOutcome {
    /// The feed has nothing newer.
    UpToDate,
    /// The installer was started. The process exits right after, so this is
    /// the last thing a successful run records; the next one says whether the
    /// new version is in.
    Installing { version: String },
    /// An update is there and was left for later.
    Deferred {
        version: String,
        reason: DeferReason,
    },
    /// Background installs are off in Settings.
    Disabled,
    /// Another headless run holds the lock.
    Busy,
    /// Checking, downloading or starting the installer failed.
    Failed { message: String },
}

pub fn load() -> UpdaterRecord {
    crate::state_file::load_or_default(STATE_FILE, "updater")
}

fn save(record: &UpdaterRecord) {
    if let Err(e) = crate::state_file::save_atomic(STATE_FILE, record) {
        eprintln!("[updater] cannot save {STATE_FILE}: {e}");
    }
}

pub fn save_schedule(outcome: ScheduleOutcome) {
    log(&format!(
        "schedule: {:?}{}",
        outcome.mechanism,
        outcome
            .detail
            .as_deref()
            .map(|d| format!(" ({d})"))
            .unwrap_or_default()
    ));
    let mut record = load();
    record.schedule = Some(ScheduleRecord {
        mechanism: outcome.mechanism,
        detail: outcome.detail,
        at_ms: now_ms(),
    });
    save(&record);
}

pub fn save_run(trigger: Trigger, outcome: RunOutcome) {
    log(&format!("run ({}): {outcome:?}", trigger.arg()));
    let mut record = load();
    record.last_run = Some(RunRecord {
        at_ms: now_ms(),
        trigger,
        outcome,
    });
    save(&record);
}

/// What a check found: `Some(version)` when the feed has something newer,
/// `None` when it has nothing. Keeps `first_seen_ms` while the version stays
/// the same.
pub fn note_available(version: Option<&str>) {
    let mut record = load();
    let next = next_available(record.available.as_ref(), version, now_ms());
    if next != record.available {
        record.available = next;
        save(&record);
    }
}

fn next_available(
    previous: Option<&Available>,
    found: Option<&str>,
    now: i64,
) -> Option<Available> {
    let version = found?;
    Some(match previous {
        Some(p) if p.version == version => p.clone(),
        _ => Available {
            version: version.to_string(),
            first_seen_ms: now,
        },
    })
}

/// Append one timestamped line to `updater.log`, keeping the last
/// [`LOG_LINES`].
pub fn log(line: &str) {
    let Ok(path) = crate::state_file::path(LOG_FILE) else {
        return;
    };
    let previous = std::fs::read_to_string(&path).unwrap_or_default();
    let stamped = format!(
        "{} {line}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    );
    let _ = crate::state_file::write_atomic(&path, append_capped(&previous, &stamped).as_bytes());
}

/// `previous` plus `line`, trimmed from the front to [`LOG_LINES`].
fn append_capped(previous: &str, line: &str) -> String {
    let mut lines: Vec<&str> = previous.lines().collect();
    lines.push(line);
    let start = lines.len().saturating_sub(LOG_LINES);
    let mut out = lines[start..].join("\n");
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_keeps_only_the_newest_lines() {
        let previous: String = (0..LOG_LINES).map(|i| format!("line {i}\n")).collect();
        let out = append_capped(&previous, "newest");
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), LOG_LINES);
        assert_eq!(lines.first(), Some(&"line 1"));
        assert_eq!(lines.last(), Some(&"newest"));
    }

    #[test]
    fn the_same_version_keeps_its_first_sighting() {
        let seen = Available {
            version: "1.30.0".into(),
            first_seen_ms: 100,
        };
        assert_eq!(next_available(Some(&seen), Some("1.30.0"), 999), Some(seen));
    }

    #[test]
    fn a_newer_version_restarts_the_clock_and_nothing_clears_it() {
        let seen = Available {
            version: "1.30.0".into(),
            first_seen_ms: 100,
        };
        assert_eq!(
            next_available(Some(&seen), Some("1.31.0"), 999),
            Some(Available {
                version: "1.31.0".into(),
                first_seen_ms: 999
            })
        );
        assert_eq!(next_available(Some(&seen), None, 999), None);
    }

    #[test]
    fn an_empty_log_gets_its_first_line() {
        assert_eq!(append_capped("", "first"), "first\n");
    }

    #[test]
    fn a_record_written_by_an_older_version_still_loads() {
        let parsed: UpdaterRecord = serde_json::from_str("{}").unwrap();
        assert!(parsed.schedule.is_none() && parsed.last_run.is_none());
    }

    #[test]
    fn outcomes_serialize_with_a_kind_tag_for_the_interface() {
        let json = serde_json::to_value(RunOutcome::Deferred {
            version: "1.30.0".into(),
            reason: DeferReason::ConnectorInUse,
        })
        .unwrap();
        assert_eq!(json["kind"], "deferred");
        assert_eq!(json["reason"], "connectorInUse");
    }
}
