//! Does the platform PTY pass escape sequences a program writes through to
//! the app, byte for byte? (docs/ideas/windows.md, "Measure first", M1.)
//!
//! Termic reads agent state from OSC sequences in the terminal stream: OSC
//! 777 / 9 from agent hooks, OSC 133 prompt marks. On macOS and Linux the PTY
//! is a byte pipe. On Windows, ConPTY parses the child's output and re-renders
//! the screen, and whether it forwards an OSC it does not itself understand
//! decides how agent hooks can work there.
//!
//! Spawns one child per sequence that writes it (plus a marker) and reports
//! whether the exact bytes came out of the master side. Exit code 0 always:
//! this is a measurement, and CI prints it rather than gating on it.
//!
//!   cargo run --example conpty_osc_probe

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::io::Read;
use std::time::{Duration, Instant};

const CASES: &[(&str, &str)] = &[
    ("OSC 777 notify (agent hooks)", "\x1b]777;notify;termic;probe\x07"),
    ("OSC 9 notification", "\x1b]9;termic-probe\x07"),
    ("OSC 133 prompt start", "\x1b]133;A\x07"),
    ("OSC 133 command done", "\x1b]133;D;0\x07"),
    ("OSC 777, ST terminator", "\x1b]777;notify;termic;st\x1b\\"),
    ("OSC 0 title (ConPTY understands this one)", "\x1b]0;termic-title\x07"),
];

/// A command that writes `payload` raw to its stdout, then a plain marker.
fn writer(payload: &str) -> CommandBuilder {
    let hex: String = payload.bytes().map(|b| format!("{b:02x}")).collect();
    if cfg!(windows) {
        let mut c = CommandBuilder::new("powershell.exe");
        c.args([
            "-NoProfile",
            "-Command",
            &format!(
                "$b=[byte[]] -split ('{hex}' -replace '..','0x$& '); \
                 $o=[Console]::OpenStandardOutput(); $o.Write($b,0,$b.Length); $o.Flush(); \
                 [Console]::Out.Write('PROBE-END'); [Console]::Out.Flush()"
            ),
        ]);
        c
    } else {
        let mut c = CommandBuilder::new("sh");
        let oct: String = payload.bytes().map(|b| format!("\\{b:03o}")).collect();
        c.args(["-c", &format!("printf '{oct}PROBE-END'")]);
        c
    }
}

fn run(payload: &str) -> Vec<u8> {
    run_cmd(writer(payload))
}

fn run_cmd(cmd: CommandBuilder) -> Vec<u8> {
    let pty = NativePtySystem::default();
    let pair = pty
        .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().expect("reader");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut out = Vec::new();
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
            out.extend_from_slice(&chunk);
        }
        if out.windows(9).any(|w| w == b"PROBE-END") {
            // A beat more: ConPTY may flush the end of a frame separately.
            let until = Instant::now() + Duration::from_millis(500);
            while Instant::now() < until {
                if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                    out.extend_from_slice(&chunk);
                }
            }
            break;
        }
    }
    let _ = child.kill();
    drop(pair.master);
    out
}

fn printable(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x1b => "\\e".to_string(),
            0x07 => "\\a".to_string(),
            b'\r' => "\\r".to_string(),
            b'\n' => "\\n".to_string(),
            0x20..=0x7e => (b as char).to_string(),
            _ => format!("\\x{b:02x}"),
        })
        .collect()
}

/// `--emit-conout <hex>`: open the CONSOLE (not stdout, which an agent pipes
/// away from a hook) and write the bytes there. This is what a Windows hook
/// transport would do; the probe runs itself in this mode as a grandchild.
#[cfg(windows)]
fn emit_conout(hex: &str) {
    use std::io::Write;
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect();
    match std::fs::OpenOptions::new().write(true).open("CONOUT$") {
        Ok(mut f) => {
            let _ = f.write_all(&bytes);
            let _ = f.write_all(b"PROBE-END");
        }
        Err(e) => eprintln!("CONOUT$ open failed: {e}"),
    }
}

/// A Node parent (the agent) spawning this probe (the hook) with its stdio
/// piped, as agents spawn hooks, then the hook writing to the console.
#[cfg(windows)]
fn hook_writer(payload: &str, hide: bool) -> CommandBuilder {
    let hex: String = payload.bytes().map(|b| format!("{b:02x}")).collect();
    let me = std::env::current_exe().unwrap().to_string_lossy().replace('\\', "\\\\");
    let js = format!(
        "const r=require('child_process').spawnSync('{me}',['--emit-conout','{hex}'],{{stdio:'pipe',windowsHide:{hide}}});\
         if(r.stderr&&r.stderr.length)console.error(String(r.stderr));"
    );
    let mut c = CommandBuilder::new("node.exe");
    c.args(["-e", &js]);
    c
}

/// The same, but the hook is a Git Bash script writing to `/dev/tty`, which is
/// how termic's existing hook scripts would reach the terminal if
/// `TERMIC_PTY=/dev/tty` were enough on Windows.
#[cfg(windows)]
fn bash_hook_writer(payload: &str, hide: bool) -> CommandBuilder {
    let oct: String = payload.bytes().map(|b| format!("\\{b:03o}")).collect();
    let bash = r"C:\Program Files\Git\bin\bash.exe".replace('\\', "\\\\");
    let js = format!(
        "const r=require('child_process').spawnSync('{bash}',['-c',\"printf '{oct}PROBE-END' > /dev/tty\"],{{stdio:'pipe',windowsHide:{hide}}});\
         if(r.stderr&&r.stderr.length)console.error(String(r.stderr));"
    );
    let mut c = CommandBuilder::new("node.exe");
    c.args(["-e", &js]);
    c
}

fn main() {
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).map(String::as_str) == Some("--emit-conout") {
            emit_conout(args.get(2).map(String::as_str).unwrap_or(""));
            return;
        }
    }
    println!("PTY escape-sequence passthrough ({})", std::env::consts::OS);
    for (name, payload) in CASES {
        let out = run(payload);
        let passed = out.windows(payload.len()).any(|w| w == payload.as_bytes());
        let ended = out.windows(9).any(|w| w == b"PROBE-END");
        println!(
            "{} {name}{}",
            if passed { "PASS-THROUGH" } else { "DROPPED     " },
            if ended { "" } else { "  (child output never arrived: inconclusive)" },
        );
        if !passed {
            let tail = &out[out.len().saturating_sub(300)..];
            println!("    got: {}", printable(tail));
        }
    }

    // The hook path: agent (node) -> hook (piped stdio) -> CONOUT$.
    #[cfg(windows)]
    {
        println!("Hook path: a node parent spawns a child with piped stdio; the child writes to CONOUT$");
        let payload = CASES[0].1;
        let cases: Vec<(String, CommandBuilder)> = vec![
            ("OSC 777 via CONOUT$ (windowsHide: false)".into(), hook_writer(payload, false)),
            ("OSC 777 via CONOUT$ (windowsHide: true)".into(), hook_writer(payload, true)),
            ("OSC 777 via Git Bash > /dev/tty (windowsHide: false)".into(), bash_hook_writer(payload, false)),
            ("OSC 777 via Git Bash > /dev/tty (windowsHide: true)".into(), bash_hook_writer(payload, true)),
        ];
        for (name, cmd) in cases {
            let out = run_cmd(cmd);
            let passed = out.windows(payload.len()).any(|w| w == payload.as_bytes());
            let ended = out.windows(9).any(|w| w == b"PROBE-END");
            println!(
                "{} {name}{}",
                if passed { "PASS-THROUGH" } else { "DROPPED     " },
                if ended { "" } else { "  (child output never arrived)" },
            );
            if !passed {
                let tail = &out[out.len().saturating_sub(300)..];
                println!("    got: {}", printable(tail));
            }
        }
    }
}
