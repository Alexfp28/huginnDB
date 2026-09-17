//! Reading a VS Code extension package (`.vsix`) for the colour themes it
//! contributes.
//!
//! A `.vsix` is a ZIP with the extension rooted at `extension/`. This module
//! opens one, reads its manifest, and hands the frontend the **raw text** of
//! the theme files — nothing else. In particular it does not parse a theme,
//! does not look at a colour, and has no opinion about light versus dark:
//! all of that lives in `src/lib/vscodeTheme/`, where it is pure and
//! testable without a running app.
//!
//! The split is not arbitrary. Theme files are JSONC (JSON with comments),
//! which the frontend already parses with `jsonc-parser` and Rust would need
//! a second dependency to touch. Since the manifest itself is strict JSON,
//! the backend can do the one job it is actually needed for — unzipping —
//! and stay out of the rest.
//!
//! **`include` is handled by shipping more than was asked for.** A theme may
//! extend another file, and resolving that chain means parsing JSONC. Rather
//! than pull a JSONC parser into Rust to discover which files to read, every
//! `.json` under `extension/` comes along (within the limits below) and the
//! frontend resolves the chain against what it was given.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Largest single entry read out of the archive. A theme file runs 18–62 KB
/// across the themes this was tested on; 2 MiB is far above any real one and
/// far below what would matter if an archive lied about its contents.
const MAX_ENTRY_BYTES: u64 = 2 * 1024 * 1024;
/// Ceiling on everything extracted from one archive.
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
/// Ceiling on how many JSON entries are worth carrying back.
const MAX_ENTRIES: usize = 64;

/// One `contributes.themes[]` entry, as written in the manifest.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeContribution {
    pub label: String,
    pub ui_theme: String,
    /// Kept verbatim, including any `./` prefix — the frontend canonicalises
    /// it, and it is also the key the frontend looks up in `files`.
    pub path: String,
}

/// What the importer gets back: enough to name the extension, plus the text
/// of every theme file it might need.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VsixPayload {
    pub display_name: String,
    /// `publisher.name`, for attribution in the import dialog. Empty when the
    /// manifest omits a publisher.
    pub identifier: String,
    pub version: String,
    pub license: Option<String>,
    pub themes: Vec<ThemeContribution>,
    /// Theme file bodies keyed by their path relative to `extension/`.
    pub files: BTreeMap<String, String>,
}

fn manifest_string(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

/// Read one entry as UTF-8, refusing anything over [`MAX_ENTRY_BYTES`].
/// A BOM is stripped: `package.json` files written on Windows carry one often
/// enough that `serde_json` would otherwise fail on a perfectly good manifest.
fn read_entry<R: Read>(file: &mut zip::read::ZipFile<'_, R>) -> AppResult<String> {
    if file.size() > MAX_ENTRY_BYTES {
        return Err(AppError::InvalidInput(format!(
            "entry `{}` is {} bytes, over the {MAX_ENTRY_BYTES} byte limit",
            file.name(),
            file.size()
        )));
    }
    let mut buf = String::new();
    file.read_to_string(&mut buf)?;
    Ok(buf.strip_prefix('\u{feff}').unwrap_or(&buf).to_string())
}

/// Open a `.vsix` and return the colour themes it contributes.
///
/// Fails when the file is not a ZIP, has no `extension/package.json`, or
/// contributes no themes — the three cases where continuing would only defer
/// the same message to a less useful place.
#[tauri::command]
pub async fn read_vsix(path: String) -> AppResult<VsixPayload> {
    tauri::async_runtime::spawn_blocking(move || read_vsix_blocking(Path::new(&path)))
        .await
        .map_err(|e| AppError::InvalidInput(format!("vsix read task failed: {e}")))?
}

fn read_vsix_blocking(path: &Path) -> AppResult<VsixPayload> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::InvalidInput(format!("not a readable .vsix archive: {e}")))?;

    let manifest: serde_json::Value = {
        let mut entry = archive
            .by_name("extension/package.json")
            .map_err(|_| AppError::NotFound("extension/package.json not found in .vsix".into()))?;
        serde_json::from_str(&read_entry(&mut entry)?)?
    };

    let themes: Vec<ThemeContribution> = manifest
        .get("contributes")
        .and_then(|c| c.get("themes"))
        .and_then(|t| t.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let path = entry.get("path")?.as_str()?.trim().to_string();
                    if path.is_empty() {
                        return None;
                    }
                    Some(ThemeContribution {
                        label: manifest_string(entry.get("label")),
                        ui_theme: manifest_string(entry.get("uiTheme")),
                        path,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    if themes.is_empty() {
        return Err(AppError::InvalidInput(
            "this extension contributes no colour themes".into(),
        ));
    }

    // Every `.json` under `extension/`, so an `include` chain resolves on the
    // frontend without the backend having to parse JSONC to find out which
    // files matter. `package.json` is excluded: it is the manifest, already
    // read, and never a theme.
    let mut files = BTreeMap::new();
    let mut total: u64 = 0;
    let names: Vec<String> = archive.file_names().map(str::to_string).collect();
    for name in names {
        let Some(relative) = name.strip_prefix("extension/") else {
            continue;
        };
        if relative == "package.json" || !relative.to_ascii_lowercase().ends_with(".json") {
            continue;
        }
        if files.len() >= MAX_ENTRIES || total >= MAX_TOTAL_BYTES {
            break;
        }
        let Ok(mut entry) = archive.by_name(&name) else {
            continue;
        };
        if entry.size() > MAX_ENTRY_BYTES || total + entry.size() > MAX_TOTAL_BYTES {
            continue;
        }
        // A single unreadable entry (bad UTF-8, a directory that looks like a
        // file) must not fail the whole import — the theme the user picked
        // may well not be that one.
        if let Ok(text) = read_entry(&mut entry) {
            total += text.len() as u64;
            files.insert(relative.to_string(), text);
        }
    }

    let display_name = {
        let display = manifest_string(manifest.get("displayName"));
        if display.is_empty() {
            manifest_string(manifest.get("name"))
        } else {
            display
        }
    };
    let publisher = manifest_string(manifest.get("publisher"));
    let name = manifest_string(manifest.get("name"));

    Ok(VsixPayload {
        display_name,
        identifier: if publisher.is_empty() {
            name
        } else {
            format!("{publisher}.{name}")
        },
        version: manifest_string(manifest.get("version")),
        license: manifest
            .get("license")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        themes,
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use zip::write::SimpleFileOptions;

    /// A throwaway file under the OS temp dir that deletes itself on drop.
    /// Deliberately not `tempfile`: the crate is not a dependency here, and
    /// every other test in this workspace already builds scratch paths this
    /// way (see `state_file.rs`, `db/exec.rs`). Never anywhere near the real
    /// state directory — see gotcha #52.
    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    impl Scratch {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    fn scratch(bytes: &[u8]) -> Scratch {
        let path =
            std::env::temp_dir().join(format!("huginndb-vsix-{}.vsix", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        Scratch(path)
    }

    /// Build a `.vsix` on disk from `(path, contents)` pairs.
    fn vsix(entries: &[(&str, &str)]) -> Scratch {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, body) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        scratch(&zip.finish().unwrap().into_inner())
    }

    const MANIFEST: &str = r#"{
        "name": "my-theme",
        "displayName": "My Theme",
        "publisher": "someone",
        "version": "1.2.3",
        "license": "MIT",
        "contributes": { "themes": [
            { "label": "My Theme Dark", "uiTheme": "vs-dark", "path": "./themes/dark.json" },
            { "label": "My Theme Light", "uiTheme": "vs", "path": "./themes/light.json" }
        ] }
    }"#;

    #[test]
    fn reads_manifest_and_theme_files() {
        let f = vsix(&[
            ("extension/package.json", MANIFEST),
            ("extension/themes/dark.json", r#"{"colors":{}}"#),
            ("extension/themes/light.json", r#"{"colors":{}}"#),
        ]);
        let payload = read_vsix_blocking(f.path()).unwrap();

        assert_eq!(payload.display_name, "My Theme");
        assert_eq!(payload.identifier, "someone.my-theme");
        assert_eq!(payload.version, "1.2.3");
        assert_eq!(payload.license.as_deref(), Some("MIT"));
        assert_eq!(payload.themes.len(), 2);
        assert_eq!(payload.themes[0].path, "./themes/dark.json");
        // Keyed relative to `extension/`, matching what the frontend
        // canonicalises a contributed path down to.
        assert!(payload.files.contains_key("themes/dark.json"));
        assert!(payload.files.contains_key("themes/light.json"));
    }

    #[test]
    fn carries_json_files_the_manifest_never_named() {
        // The `include` case: `base.json` is not contributed, but a
        // contributed theme may extend it, so it must come along.
        let f = vsix(&[
            ("extension/package.json", MANIFEST),
            ("extension/themes/dark.json", r#"{"include":"./base.json"}"#),
            ("extension/themes/light.json", "{}"),
            ("extension/themes/base.json", r#"{"colors":{}}"#),
        ]);
        let payload = read_vsix_blocking(f.path()).unwrap();
        assert!(payload.files.contains_key("themes/base.json"));
        // The manifest itself is never handed back as a theme file.
        assert!(!payload.files.contains_key("package.json"));
    }

    #[test]
    fn ignores_non_json_and_out_of_root_entries() {
        let f = vsix(&[
            ("extension/package.json", MANIFEST),
            ("extension/themes/dark.json", "{}"),
            ("extension/themes/light.json", "{}"),
            ("extension/icon.png", "not really a png"),
            ("elsewhere/sneaky.json", r#"{"colors":{}}"#),
            ("[Content_Types].xml", "<xml/>"),
        ]);
        let payload = read_vsix_blocking(f.path()).unwrap();
        assert_eq!(payload.files.len(), 2);
        assert!(!payload.files.keys().any(|k| k.contains("sneaky")));
    }

    #[test]
    fn strips_a_byte_order_mark_from_the_manifest() {
        let f = vsix(&[
            ("extension/package.json", &format!("\u{feff}{MANIFEST}")),
            ("extension/themes/dark.json", "{}"),
            ("extension/themes/light.json", "{}"),
        ]);
        assert_eq!(read_vsix_blocking(f.path()).unwrap().version, "1.2.3");
    }

    #[test]
    fn rejects_an_extension_contributing_no_themes() {
        let f = vsix(&[(
            "extension/package.json",
            r#"{"name":"x","version":"1","contributes":{"commands":[]}}"#,
        )]);
        assert!(matches!(
            read_vsix_blocking(f.path()),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn rejects_an_archive_without_a_manifest() {
        let f = vsix(&[("extension/themes/dark.json", "{}")]);
        assert!(matches!(
            read_vsix_blocking(f.path()),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn rejects_a_file_that_is_not_a_zip() {
        let f = scratch(b"this is plainly not a zip archive");
        assert!(matches!(
            read_vsix_blocking(f.path()),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn refuses_an_entry_over_the_size_limit() {
        // Oversized entries are skipped rather than failing the import, so a
        // bloated sibling file cannot block a perfectly good theme.
        let huge = "x".repeat((MAX_ENTRY_BYTES + 1) as usize);
        let f = vsix(&[
            ("extension/package.json", MANIFEST),
            ("extension/themes/dark.json", "{}"),
            ("extension/themes/light.json", "{}"),
            ("extension/themes/huge.json", &huge),
        ]);
        let payload = read_vsix_blocking(f.path()).unwrap();
        assert!(!payload.files.contains_key("themes/huge.json"));
        assert!(payload.files.contains_key("themes/dark.json"));
    }
}
