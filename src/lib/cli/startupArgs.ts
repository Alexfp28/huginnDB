/**
 * Constructors for {@link StartupArgs}, the payload `open_new_window` carries
 * to a new window's boot.
 *
 * **Why a helper rather than an object literal at each call site.** The Rust
 * struct (`src-tauri/src/state.rs`) is not fully defaultable: `connect_by_id`
 * is a bare `bool`, and serde only fills a missing key for `Option` fields. A
 * partial payload therefore fails to deserialize *at the IPC boundary*, at
 * runtime, with nothing for `tsc` to catch — the TypeScript interface declares
 * all eleven fields as `X | null` rather than optional, so an incomplete
 * literal is already a type error, but that only helps for as long as nobody
 * reaches for a cast or the interface gains an optional field. This is gotcha
 * #14's shape: the two declarations have to stay in step, and the way to make
 * that cheap is to have one place that builds the object.
 *
 * Until now no `StartupArgs` literal existed in the frontend at all — every
 * instance came back from Rust already populated — so this is the first.
 */

import type { StartupArgs } from "@/types";

/**
 * Every field explicitly null/false: the neutral payload, equivalent to
 * launching with no CLI flags.
 *
 * Spelled out rather than assembled, so adding a field to `StartupArgs` is a
 * compile error here (the interface requires all of them) instead of a
 * deserialize failure in a window that then boots blank.
 */
export function emptyStartupArgs(): StartupArgs {
  return {
    connect_profile: null,
    connect_by_id: false,
    adhoc_host: null,
    adhoc_port: null,
    adhoc_database: null,
    adhoc_username: null,
    adhoc_driver: null,
    adhoc_connection_string: null,
    adhoc_auth_source: null,
    adhoc_name: null,
    adhoc_password: null,
  };
}

/**
 * An intent that connects the new window to one saved profile.
 *
 * `connect_by_id` is what tells the backend `connect_profile` is a UUID rather
 * than a display name — names are not unique, so resolving by name from here
 * could open a different server than the row the user right-clicked.
 *
 * No password travels: the new window resolves it from the OS keychain like
 * any other connect. A profile with no stored secret (an `ephemeral` CLI
 * launch, or a password typed into the dialog only this session) will fail to
 * connect there, and the error lands in that window's Console panel. The
 * window still opens and is usable, which is why the menu entry is not gated
 * on having a secret — gating it would hide the majority case to spare a
 * legible failure in the minority one.
 */
export function profileIntent(profileId: string): StartupArgs {
  return { ...emptyStartupArgs(), connect_profile: profileId, connect_by_id: true };
}
