//! Where a machine's policy comes from: the anchors an administrator controls
//! and a standard user cannot write (D4, §5.2 of `docs/POLICY_ROADMAP.md`).
//!
//! Read in order, and the first that carries a policy wins:
//!
//! 1. `HKLM\SOFTWARE\Policies\HuginnDB` — `Policy` (the JSON inline) or
//!    `PolicySource` (a path to it, typically on a share). What Group Policy
//!    and Intune write.
//! 2. `managed-policy.json` in the system policy directory — the policy
//!    itself, or `{ "source": "<path>" }`.
//!
//! `HKCU` is never a source: it is user-writable. Nothing here reads an
//! environment variable either, `%ProgramFiles%` included — a user who could
//! point it at an empty directory would turn a managed machine into an
//! unmanaged one.

use std::path::PathBuf;

/// The file name looked for in [`policy_dir`].
pub const FILE_NAME: &str = "managed-policy.json";

/// A policy larger than this is refused rather than parsed. Real ones are a
/// few kilobytes; the cap only stops a mistake — a log file dropped on the
/// share under the policy's name — from being read whole on every reload.
const MAX_BYTES: u64 = 1024 * 1024;

/// What an anchor pointed at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Anchor {
    /// The policy text itself, and where it was found.
    Inline { origin: String, text: String },
    /// A path to the policy (a share, usually), and the anchor naming it.
    Source { origin: String, path: String },
}

impl Anchor {
    /// Where the policy is read from, as the diagnostics show it.
    pub fn describe(&self) -> String {
        match self {
            Anchor::Inline { origin, .. } => origin.clone(),
            Anchor::Source { origin, path } => format!("{path} (named by {origin})"),
        }
    }
}

/// The directory the system file anchor lives in.
pub fn policy_dir() -> PathBuf {
    #[cfg(windows)]
    {
        program_files().join("HuginnDB")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/Library/Application Support/HuginnDB")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        PathBuf::from("/etc/huginndb")
    }
}

/// `Program Files`, from the registry value Windows itself keeps under HKLM —
/// never from `%ProgramFiles%`, which the user's own process environment
/// defines.
#[cfg(windows)]
fn program_files() -> PathBuf {
    windows_registry::LOCAL_MACHINE
        .open(r"SOFTWARE\Microsoft\Windows\CurrentVersion")
        .and_then(|key| key.get_string("ProgramFilesDir"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"C:\Program Files"))
}

/// Read the anchors. `Ok(None)` means the machine is unmanaged; an error means
/// an anchor exists and could not be read, which blocks rather than being
/// mistaken for "no policy".
pub fn read_anchor() -> Result<Option<Anchor>, String> {
    #[cfg(windows)]
    if let Some(anchor) = read_registry()? {
        return Ok(Some(anchor));
    }
    read_file_anchor(&policy_dir().join(FILE_NAME))
}

#[cfg(windows)]
fn read_registry() -> Result<Option<Anchor>, String> {
    const KEY: &str = r"SOFTWARE\Policies\HuginnDB";
    // `ERROR_FILE_NOT_FOUND`, as an HRESULT: the key or the value is absent.
    const NOT_FOUND: i32 = 0x8007_0002_u32 as i32;
    let origin = |value: &str| format!(r"HKLM\{KEY}\{value}");
    let key = match windows_registry::LOCAL_MACHINE.open(KEY) {
        Ok(key) => key,
        Err(e) if e.code().0 == NOT_FOUND => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", origin(""))),
    };
    for (value, inline) in [("Policy", true), ("PolicySource", false)] {
        match key.get_string(value) {
            Ok(text) if text.trim().is_empty() => {}
            Ok(text) if inline => {
                return Ok(Some(Anchor::Inline {
                    origin: origin(value),
                    text,
                }))
            }
            Ok(path) => {
                return Ok(Some(Anchor::Source {
                    origin: origin(value),
                    path: path.trim().to_string(),
                }))
            }
            Err(e) if e.code().0 == NOT_FOUND => {}
            Err(e) => return Err(format!("cannot read {}: {e}", origin(value))),
        }
    }
    Ok(None)
}

fn read_file_anchor(path: &std::path::Path) -> Result<Option<Anchor>, String> {
    let origin = path.display().to_string();
    let text = match read_capped(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {origin}: {e}")),
    };
    // `{ "source": "…" }` and nothing else points somewhere; anything else is
    // the policy itself, and its parser reports what is wrong with it.
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Pointer {
        source: String,
    }
    match serde_json::from_str::<Pointer>(&text) {
        Ok(p) if !p.source.trim().is_empty() => Ok(Some(Anchor::Source {
            origin,
            path: p.source.trim().to_string(),
        })),
        _ => Ok(Some(Anchor::Inline { origin, text })),
    }
}

/// The policy text an anchor leads to.
///
/// Blocking, and possibly slow: a `Source` is usually a network share, which
/// is why [`super::install`] runs this on its own thread rather than on the
/// app's startup path.
pub fn fetch(anchor: &Anchor) -> Result<String, String> {
    match anchor {
        Anchor::Inline { text, .. } => Ok(text.clone()),
        Anchor::Source { path, .. } => {
            read_capped(std::path::Path::new(path)).map_err(|e| format!("cannot read {path}: {e}"))
        }
    }
}

fn read_capped(path: &std::path::Path) -> std::io::Result<String> {
    let len = std::fs::metadata(path)?.len();
    if len > MAX_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("the file is {len} bytes, more than the {MAX_BYTES}-byte limit for a policy"),
        ));
    }
    std::fs::read_to_string(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str, content: Option<&str>) -> PathBuf {
        let path = std::env::temp_dir().join(format!("huginndb_policy_anchor_{name}.json"));
        let _ = std::fs::remove_file(&path);
        if let Some(c) = content {
            std::fs::write(&path, c).unwrap();
        }
        path
    }

    #[test]
    fn no_file_means_unmanaged() {
        assert_eq!(read_file_anchor(&temp("absent", None)).unwrap(), None);
    }

    #[test]
    fn a_file_is_either_a_pointer_or_the_policy() {
        let pointer = temp(
            "pointer",
            Some(r#"{ "source": " \\\\srv\\it\\huginn.json " }"#),
        );
        assert_eq!(
            read_file_anchor(&pointer).unwrap(),
            Some(Anchor::Source {
                origin: pointer.display().to_string(),
                path: r"\\srv\it\huginn.json".into(),
            })
        );
        let inline = temp("inline", Some(r#"{ "version": 1 }"#));
        assert!(matches!(
            read_file_anchor(&inline).unwrap(),
            Some(Anchor::Inline { .. })
        ));
        // Even malformed text is "the policy": its parser says what is wrong,
        // rather than the anchor quietly counting as absent.
        let broken = temp("broken", Some("{ not json"));
        assert!(matches!(
            read_file_anchor(&broken).unwrap(),
            Some(Anchor::Inline { .. })
        ));
    }

    #[test]
    fn a_source_that_cannot_be_read_is_an_error() {
        let anchor = Anchor::Source {
            origin: "test".into(),
            path: temp("missing_source", None).display().to_string(),
        };
        assert!(fetch(&anchor).unwrap_err().contains("cannot read"));
    }
}
