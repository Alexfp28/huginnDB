//! "Is a process with this image name running?", without a process crate.
//!
//! Shells out to the platform's own listing tool (`tasklist` / `pgrep`), the
//! approach `commands::mcp::is_mcp_sidecar_running` already took, so the
//! dependency tree stays as it is. Any failure to run the check reads as "not
//! running": a check that cannot be made must not be the reason an update
//! never happens, and every caller decides something recoverable.

/// Whether a process named `image` (without `.exe`) is running, other than
/// the one with pid `except`.
pub fn is_running(image: &str, except: Option<u32>) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let exe = format!("{image}.exe");
        let mut cmd = std::process::Command::new("tasklist");
        cmd.args(["/FI", &format!("IMAGENAME eq {exe}"), "/NH", "/FO", "CSV"]);
        if let Some(pid) = except {
            cmd.args(["/FI", &format!("PID ne {pid}")]);
        }
        // The headless updater is a GUI-subsystem process: without this, every
        // console tool it starts flashes a window on the user's desktop.
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output()
            .map(|out| lists_image(&String::from_utf8_lossy(&out.stdout), &exe))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let Ok(out) = std::process::Command::new("pgrep")
            .args(["-x", image])
            .output()
        else {
            return false;
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .any(|pid| Some(pid) != except)
    }
}

/// `CREATE_NO_WINDOW`, from `winbase.h`.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Whether `tasklist /FO CSV /NH` output names `exe`. With no match it prints
/// a localised "INFO: no tasks" line instead, which never starts with the
/// quoted image name.
#[cfg_attr(not(windows), allow(dead_code))]
fn lists_image(stdout: &str, exe: &str) -> bool {
    let quoted = format!("\"{}\"", exe.to_lowercase());
    stdout
        .lines()
        .any(|line| line.trim_start().to_lowercase().starts_with(&quoted))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listed_process_is_found() {
        let out = "\"huginndb.exe\",\"4242\",\"Console\",\"1\",\"80.000 K\"\r\n";
        assert!(lists_image(out, "huginndb.exe"));
    }

    #[test]
    fn the_localised_no_match_line_is_not_a_match() {
        let es = "INFORMACIÓN: no hay tareas ejecutándose que coincidan con los criterios especificados.\r\n";
        assert!(!lists_image(es, "huginndb.exe"));
        assert!(!lists_image(
            "INFO: No tasks are running which match the specified criteria.\r\n",
            "huginndb.exe"
        ));
    }

    #[test]
    fn a_longer_name_is_not_the_same_image() {
        let out = "\"huginndb-mcp.exe\",\"77\",\"Console\",\"1\",\"9.000 K\"\r\n";
        assert!(!lists_image(out, "huginndb.exe"));
        assert!(lists_image(out, "huginndb-mcp.exe"));
    }
}
