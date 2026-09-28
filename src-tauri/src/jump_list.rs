//! The taskbar Jump List: what Windows shows when you right-click HuginnDB's
//! taskbar button (or its Start menu entry).
//!
//! Two parts, the same layout Claude Desktop and most editors use:
//!
//! - **Recent connections**, a custom category of shell links. Each one
//!   relaunches this executable with `--connect-profile-id <id>`, the CLI flag
//!   that already existed, so nothing downstream is new: with the app open the
//!   single-instance plugin hands the argv to the running process, which asks
//!   "this window or a new one" exactly as for any CLI launch
//!   (`handle_second_instance` → `CliConnectChoiceDialog`); with it closed, the
//!   app starts and connects. Behind `UiPrefs::jump_list_recent`, because
//!   Windows keeps the list under the user's profile
//!   (`%APPDATA%\Microsoft\Windows\Recent\CustomDestinations`) in plain text —
//!   connection *names* and ids, never a password, but still names someone may
//!   not want written down outside the app.
//! - **Tasks**: "New window", which relaunches with [`NEW_WINDOW_FLAG`]. Always
//!   present: it names nothing.
//!
//! ## Where "recent" comes from
//!
//! No new state. Across launches the order is `ConnectionTabState::last_opened`
//! from `tab_state.json` (stamped per connection whenever its tabs or tree
//! change, the same value that already drives the LRU prune), taking the newest
//! across every environment. That misses a connection opened this session that
//! has not saved tab state yet, so connections opened since launch come first,
//! newest first, from a process-local list fed by the `connect` command — the
//! human path only: the MCP bridge shares `connect_inner`, not the wrapper, and
//! an AI opening a pool is not the person's history.
//!
//! ## When it is rebuilt
//!
//! At startup, after every connect, whenever `PROFILES_CHANGED_EVENT` fires (a
//! rename, a delete, an import, an origin sync — every path that changes
//! `profiles.json` already emits it), and when the preference or the UI
//! language changes. Each rebuild replaces the whole list; there is no
//! incremental update in the API.
//!
//! ## Identity
//!
//! The list is committed without `SetAppID`. Neither Tauri nor the NSIS
//! installer sets an explicit AppUserModelID, so the taskbar button, the
//! pinned shortcut and this list all fall back to the one Windows derives from
//! the executable's path — which is also what keeps a canary install's list
//! apart from the stable one's.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tauri::{AppHandle, Listener, Manager, Runtime};

use crate::commands::connection::PROFILES_CHANGED_EVENT;
use crate::state::{AppState, ConnectionProfile, Driver};
use crate::tab_state::Environment;

/// Relaunch flag for the "New window" task. Handled in `handle_second_instance`
/// when the app is already running; a cold start ignores it (unknown flags are
/// skipped by `parse_args`) and simply opens the main window.
pub const NEW_WINDOW_FLAG: &str = "--new-window";

/// How many recent connections the category shows at most. Windows trims
/// further to the user's "items in Jump Lists" setting (`BeginList`'s slot
/// count), so this is a ceiling rather than a promise.
const MAX_RECENT: usize = 8;

/// Connections opened since launch, newest first — see the module docs.
static SESSION_RECENT: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// One entry of the recent-connections category.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentEntry {
    pub profile_id: String,
    pub title: String,
    pub description: String,
}

impl RecentEntry {
    // Read by the Windows shell writer (and the tests); elsewhere the plan is
    // built and then dropped by the no-op `commit`. `allow`, not `expect`: the
    // Linux *test* build does use it, and an unmet `expect` is its own error.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn arguments(&self) -> String {
        format!("--connect-profile-id {}", self.profile_id)
    }
}

/// Everything a rebuild writes, resolved up front so the COM side only copies.
/// Its fields are only read by the Windows writer — see `RecentEntry::arguments`.
#[derive(Debug, Clone)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Plan {
    pub category: String,
    pub recent: Vec<RecentEntry>,
    pub new_window_title: String,
    pub new_window_description: String,
}

/// Rebuild once now and again whenever the profile list changes.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    refresh(app);
    let handle = app.clone();
    app.listen_any(PROFILES_CHANGED_EVENT, move |_| refresh(&handle));
}

/// Record a connection the person just opened and rebuild.
pub fn note_connected<R: Runtime>(app: &AppHandle<R>, profile_id: &str) {
    if let Ok(mut recent) = SESSION_RECENT.lock() {
        push_front(&mut recent, profile_id);
    }
    refresh(app);
}

/// Rebuild the list from the current preferences, profiles and tab state.
/// Never fails the caller: the list is a convenience, so a shell error is
/// logged and dropped.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let plan = plan_for(app.state::<AppState>().inner());
    commit(plan);
}

fn plan_for(state: &AppState) -> Plan {
    let (enabled, language) = {
        let prefs = state.prefs.read();
        (prefs.ui.jump_list_recent, prefs.ui.language.clone())
    };
    let recent = if enabled {
        let session = SESSION_RECENT.lock().map(|r| r.clone()).unwrap_or_default();
        let profiles = state.profiles.read();
        let tab_state = state.tab_state.read();
        recent_entries(&session, &tab_state.environments, &profiles, MAX_RECENT)
    } else {
        Vec::new()
    };
    let labels = Labels::for_language(&language);
    Plan {
        category: labels.category.into(),
        recent,
        new_window_title: labels.new_window.into(),
        new_window_description: labels.new_window_description.into(),
    }
}

/// Move `id` to the front of `list`, dropping any older copy, capped at
/// [`MAX_RECENT`].
fn push_front(list: &mut Vec<String>, id: &str) {
    list.retain(|existing| existing != id);
    list.insert(0, id.to_string());
    list.truncate(MAX_RECENT);
}

/// The recent-connections category, newest first: this session's connects,
/// then every other connection by its newest `last_opened` across all
/// environments. Only profiles that still exist; each at most once.
fn recent_entries(
    session: &[String],
    environments: &[Environment],
    profiles: &[ConnectionProfile],
    limit: usize,
) -> Vec<RecentEntry> {
    let mut last_opened: HashMap<&str, i64> = HashMap::new();
    for env in environments {
        for (id, tabs) in &env.connections {
            let newest = last_opened.entry(id.as_str()).or_insert(tabs.last_opened);
            *newest = (*newest).max(tabs.last_opened);
        }
    }
    let mut by_recency: Vec<(&str, i64)> = last_opened.into_iter().collect();
    // Newest first; the id breaks ties so the order is stable between rebuilds.
    by_recency.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));

    let mut seen = HashSet::new();
    session
        .iter()
        .map(String::as_str)
        .chain(by_recency.into_iter().map(|(id, _)| id))
        .filter(|id| seen.insert(*id))
        .filter_map(|id| profiles.iter().find(|p| p.id == id))
        // An ad-hoc CLI connection is never written to `profiles.json`, so an
        // entry for it would name an id the next launch has never heard of.
        .filter(|p| !p.ephemeral)
        .take(limit)
        .map(|p| RecentEntry {
            profile_id: p.id.clone(),
            title: p.name.clone(),
            description: driver_label(p.driver).into(),
        })
        .collect()
}

/// The tooltip under an entry. Deliberately just the engine: host and
/// database would be more useful and are also exactly what should not end up
/// in a plain-text file outside the app.
fn driver_label(driver: Driver) -> &'static str {
    match driver {
        Driver::Postgres => "PostgreSQL",
        Driver::Mysql => "MySQL",
        Driver::Sqlite => "SQLite",
        Driver::Mongo => "MongoDB",
        Driver::MsSql => "SQL Server",
    }
}

/// The list's own strings. The shell renders them, not the webview, so they
/// cannot come from the frontend's i18next catalogue; the two languages the
/// app ships are spelled out here instead, following `UiPrefs::language`.
struct Labels {
    category: &'static str,
    new_window: &'static str,
    new_window_description: &'static str,
}

impl Labels {
    fn for_language(language: &str) -> Self {
        if language.starts_with("es") {
            Self {
                category: "Conexiones recientes",
                new_window: "Nueva ventana",
                new_window_description: "Abre otra ventana de HuginnDB",
            }
        } else {
            Self {
                category: "Recent connections",
                new_window: "New window",
                new_window_description: "Open another HuginnDB window",
            }
        }
    }
}

#[cfg(windows)]
fn commit(plan: Plan) {
    // COM wants an apartment of its own, and a rebuild must not run on the
    // main thread (it is reached from sync commands) or block an async worker.
    // One short-lived thread per rebuild; they are rare. The lock keeps two
    // rebuilds from interleaving `BeginList`/`CommitList` on the same list.
    static COMMIT: Mutex<()> = Mutex::new(());
    std::thread::spawn(move || {
        let _serial = COMMIT.lock();
        if let Err(e) = shell::commit(&plan) {
            eprintln!("[jump-list] could not update the taskbar Jump List: {e}");
        }
    });
}

#[cfg(not(windows))]
fn commit(_plan: Plan) {}

#[cfg(windows)]
mod shell {
    use super::{Plan, NEW_WINDOW_FLAG};
    use windows::core::{Interface, Result, HSTRING, PWSTR};
    use windows::Win32::Foundation::E_OUTOFMEMORY;
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
    };

    pub fn commit(plan: &Plan) -> Result<()> {
        let exe = std::env::current_exe()
            .map_err(|e| windows::core::Error::new(E_OUTOFMEMORY, e.to_string()))?;
        let exe = HSTRING::from(exe.as_os_str());
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
            let result = build(plan, &exe);
            CoUninitialize();
            result
        }
    }

    unsafe fn build(plan: &Plan, exe: &HSTRING) -> Result<()> {
        let list: ICustomDestinationList =
            CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        let mut slots = 0u32;
        // What the user removed from the list with "Remove from this list".
        // Appending one of those again fails the *whole* category with
        // E_ACCESSDENIED, so they are filtered out here — and stay out until
        // the user connects to it again and it moves back up on its own.
        let removed: IObjectArray = list.BeginList(&mut slots)?;
        let removed = removed_arguments(&removed);

        let result = (|| -> Result<()> {
            let recent: Vec<_> = plan
                .recent
                .iter()
                .filter(|entry| !removed.contains(&entry.arguments()))
                .take(slots as usize)
                .collect();
            if !recent.is_empty() {
                let category: IObjectCollection =
                    CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
                for entry in recent {
                    category.AddObject(&link(
                        exe,
                        &entry.arguments(),
                        &entry.title,
                        &entry.description,
                    )?)?;
                }
                list.AppendCategory(
                    &HSTRING::from(plan.category.as_str()),
                    &category.cast::<IObjectArray>()?,
                )?;
            }

            let tasks: IObjectCollection =
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            tasks.AddObject(&link(
                exe,
                NEW_WINDOW_FLAG,
                &plan.new_window_title,
                &plan.new_window_description,
            )?)?;
            list.AddUserTasks(&tasks.cast::<IObjectArray>()?)?;
            list.CommitList()
        })();
        if result.is_err() {
            let _ = list.AbortList();
        }
        result
    }

    /// A shell link back to this executable. Its visible title is
    /// `PKEY_Title`, not the link's description — the description is only the
    /// tooltip.
    unsafe fn link(
        exe: &HSTRING,
        arguments: &str,
        title: &str,
        tooltip: &str,
    ) -> Result<IShellLinkW> {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(exe)?;
        link.SetArguments(&HSTRING::from(arguments))?;
        link.SetIconLocation(exe, 0)?;
        link.SetDescription(&HSTRING::from(tooltip))?;
        let store: IPropertyStore = link.cast()?;
        let mut value = string_value(title)?;
        let set = store.SetValue(&PKEY_Title, &value);
        let _ = PropVariantClear(&mut value);
        set?;
        store.Commit()?;
        Ok(link)
    }

    /// A `VT_LPWSTR` `PROPVARIANT` holding `text`, allocated with
    /// `CoTaskMemAlloc` as `PropVariantClear` expects to free it.
    /// `InitPropVariantFromString` is an inline helper in the SDK headers, not
    /// an export, so windows-rs has no binding for it.
    unsafe fn string_value(text: &str) -> Result<PROPVARIANT> {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let buffer = CoTaskMemAlloc(wide.len() * std::mem::size_of::<u16>()) as *mut u16;
        if buffer.is_null() {
            return Err(E_OUTOFMEMORY.into());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), buffer, wide.len());
        let mut value = PROPVARIANT::default();
        let inner = &mut *value.Anonymous.Anonymous;
        inner.vt = VT_LPWSTR;
        inner.Anonymous.pwszVal = PWSTR(buffer);
        Ok(value)
    }

    /// The argument strings of the links the user removed. Anything that is
    /// not a shell link, or whose arguments cannot be read, is skipped.
    unsafe fn removed_arguments(removed: &IObjectArray) -> Vec<String> {
        let count = removed.GetCount().unwrap_or(0);
        (0..count)
            .filter_map(|i| removed.GetAt::<IShellLinkW>(i).ok())
            .filter_map(|link| {
                let mut buffer = [0u16; 1024];
                link.GetArguments(&mut buffer).ok()?;
                let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
                Some(String::from_utf16_lossy(&buffer[..len]))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tab_state::ConnectionTabState;

    fn profile(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            name: name.into(),
            driver: Driver::Mysql,
            ..crate::testkit::profile(id)
        }
    }

    fn env_with(entries: &[(&str, i64)]) -> Environment {
        let mut env = Environment::default();
        for (id, last_opened) in entries {
            env.connections.insert(
                (*id).into(),
                ConnectionTabState {
                    last_opened: *last_opened,
                    ..Default::default()
                },
            );
        }
        env
    }

    fn ids(entries: &[RecentEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.profile_id.as_str()).collect()
    }

    #[test]
    fn orders_by_newest_last_opened_across_environments() {
        let profiles = [profile("a", "A"), profile("b", "B"), profile("c", "C")];
        let envs = [
            env_with(&[("a", 10), ("b", 30)]),
            env_with(&[("a", 50), ("c", 20)]),
        ];
        let got = recent_entries(&[], &envs, &profiles, 8);
        assert_eq!(ids(&got), ["a", "b", "c"], "a's newest stamp (50) wins");
    }

    #[test]
    fn this_sessions_connects_come_first_and_are_not_repeated() {
        let profiles = [profile("a", "A"), profile("b", "B"), profile("c", "C")];
        let envs = [env_with(&[("a", 50), ("b", 30)])];
        let got = recent_entries(&["c".into(), "b".into()], &envs, &profiles, 8);
        assert_eq!(ids(&got), ["c", "b", "a"]);
    }

    #[test]
    fn drops_ids_whose_profile_is_gone_and_respects_the_limit() {
        let profiles = [profile("a", "A"), profile("b", "B"), profile("c", "C")];
        let envs = [env_with(&[("ghost", 99), ("a", 3), ("b", 2), ("c", 1)])];
        let got = recent_entries(&[], &envs, &profiles, 2);
        assert_eq!(ids(&got), ["a", "b"]);
    }

    #[test]
    fn leaves_out_ephemeral_cli_connections() {
        let profiles = [
            ConnectionProfile {
                ephemeral: true,
                ..profile("adhoc", "ad hoc")
            },
            profile("a", "A"),
        ];
        let got = recent_entries(&["adhoc".into(), "a".into()], &[], &profiles, 8);
        assert_eq!(ids(&got), ["a"]);
    }

    #[test]
    fn an_entry_carries_the_profile_name_and_only_the_engine() {
        let profiles = [profile("a", "Tencer | MySQL")];
        let got = recent_entries(&["a".into()], &[], &profiles, 8);
        assert_eq!(got[0].title, "Tencer | MySQL");
        assert_eq!(got[0].description, "MySQL");
        assert_eq!(got[0].arguments(), "--connect-profile-id a");
    }

    #[test]
    fn push_front_moves_an_existing_id_up_instead_of_duplicating_it() {
        let mut list = vec!["a".to_string(), "b".to_string()];
        push_front(&mut list, "b");
        assert_eq!(list, ["b", "a"]);
    }

    #[test]
    fn labels_follow_the_ui_language() {
        assert_eq!(Labels::for_language("es").category, "Conexiones recientes");
        assert_eq!(Labels::for_language("en").new_window, "New window");
        assert_eq!(Labels::for_language("fr").new_window, "New window");
    }
}
