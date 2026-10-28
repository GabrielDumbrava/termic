//! GH #437: does a program's mouse reporting request reach the terminal?
//!
//! On Windows the request (`CSI ? 1000 h` / `1006 h`) goes through ConPTY,
//! and the ConPTY built into Windows does not forward it, so xterm never
//! learns the program wants the wheel. Termic ships Microsoft's newer
//! `conpty.dll` + `OpenConsole.exe` next to the exe (resources/windows/conpty),
//! which portable-pty prefers. This test puts them next to the test binary,
//! the same place, and checks the request comes out of the master side.
//!
//! Its own file so it is its own process: portable-pty picks its ConPTY once
//! per process, on the first pseudoconsole.
#![cfg(windows)]

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

fn place_bundled_conpty() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/windows/conpty");
    let exe = std::env::current_exe().expect("current_exe");
    let dir = exe.parent().expect("exe dir");
    for name in ["conpty.dll", "OpenConsole.exe"] {
        std::fs::copy(src.join(name), dir.join(name)).expect(name);
    }
}

#[test]
fn mouse_reporting_request_reaches_the_terminal() {
    place_bundled_conpty();
    let pair = NativePtySystem::default()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");
    // What opencode's TUI writes on start: button tracking plus SGR encoding.
    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-Command",
        "[Console]::Out.Write([char]27 + '[?1000h' + [char]27 + '[?1006h' + 'PROBE-END'); \
         [Console]::Out.Flush(); Start-Sleep -Seconds 2",
    ]);
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().expect("reader");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut out = Vec::new();
    let started = Instant::now();
    let text = |out: &[u8]| String::from_utf8_lossy(out).into_owned();
    while started.elapsed() < Duration::from_secs(15) {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
            out.extend_from_slice(&chunk);
        }
        // ConPTY re-renders rather than copying bytes, so accept any mouse
        // tracking mode it chooses to request (1000, 1002 or 1003).
        let t = text(&out);
        if t.contains("PROBE-END") && ["\x1b[?1000h", "\x1b[?1002h", "\x1b[?1003h"].iter().any(|m| t.contains(m)) {
            break;
        }
    }
    let _ = child.kill();
    drop(pair.master);
    let t = text(&out);
    assert!(
        ["\x1b[?1000h", "\x1b[?1002h", "\x1b[?1003h"].iter().any(|m| t.contains(m)),
        "no mouse tracking request reached the terminal; got {:?}",
        t.escape_debug().to_string()
    );
}
