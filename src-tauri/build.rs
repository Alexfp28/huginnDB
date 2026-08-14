fn main() {
    // `tauri_build::build()` declares only `tauri.conf.json` and `capabilities/`
    // as build inputs (`cargo:rerun-if-changed`), and once a build script emits
    // any of those, cargo tracks *only* what was emitted. The icons are not on
    // that list — yet both places the icon ends up are baked in at compile
    // time: the Win32 resource embedded in the executable (what Windows shows
    // in the title bar, the taskbar and Explorer) and the `default_window_icon`
    // in the generated context. So replacing `icons/*` leaves cargo convinced
    // the crate is fresh, and every later `tauri dev` keeps launching a binary
    // with the previous artwork embedded — with no error, no warning, and
    // nothing a frontend rebuild can fix. That cost a full round of "the icon
    // is still the old one" during the brand redesign; the fix is to declare
    // them, so touching an icon is enough to force the relink.
    for icon in [
        "icons/icon.ico",
        "icons/icon.icns",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }
    tauri_build::build()
}
