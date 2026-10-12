mod activity;
mod audio;
mod supervisor;
mod vector;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    sync::mpsc,
    time::Duration,
};
pub static INPUT_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

fn run() -> Result<(), String> {
    #[cfg(unix)]
    if std::env::args().nth(1).as_deref() == Some("guard") {
        return supervisor::run_guard();
    }
    let mut supervisor = if std::env::args().nth(1).as_deref() == Some("supervise") {
        Some(supervisor::Supervisor::open(
            &std::env::args()
                .nth(2)
                .ok_or("supervisor_manifest_required")?,
        )?)
    } else {
        None
    };
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            // Bound allocation before parsing or waiting for the rest of a hostile frame.
            let mut bytes = Vec::new();
            let mut ended = false;
            while let Ok(chunk) = input.fill_buf() {
                if chunk.is_empty() {
                    ended = true;
                    break;
                }
                let n = chunk
                    .iter()
                    .position(|b| *b == b'\n')
                    .map(|n| n + 1)
                    .unwrap_or(chunk.len());
                if bytes.len() + n > 48 * 1024 * 1024 {
                    let _ = tx.send(Err("native_input_limit".into()));
                    return;
                }
                let complete = chunk[n - 1] == b'\n';
                bytes.extend_from_slice(&chunk[..n]);
                input.consume(n);
                if complete {
                    break;
                }
            }
            if ended {
                INPUT_OPEN.store(false, std::sync::atomic::Ordering::Release);
                return;
            }
            if tx
                .send(
                    serde_json::from_slice::<Value>(&bytes)
                        .map_err(|_| "native_request_invalid".into()),
                )
                .is_err()
            {
                return;
            }
        }
    });
    let mut activity = activity::Activity::default();
    let mut store: Option<vector::Store> = None;
    let mut out = io::BufWriter::new(io::stdout().lock());
    loop {
        activity.poll();
        if let Some(s) = supervisor.as_mut() {
            s.reap();
        }
        let request = match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        };
        let id = &request["id"];
        let p = &request["params"];
        let result = match request["method"].as_str().unwrap_or("") {
            "hello" => Ok(
                json!({"protocol":1,"version":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS}),
            ),
            "vector.open" => p["path"]
                .as_str()
                .ok_or("vector_path_invalid".into())
                .and_then(|path| {
                    store = Some(vector::Store::open(path)?);
                    Ok(json!({"readonly":true}))
                }),
            "vector.search" => store
                .as_mut()
                .ok_or("vector_not_open".into())
                .and_then(|s| s.search(p)),
            "vector.clear" => {
                store = None;
                Ok(json!({"cleared":true}))
            }
            "audio.preprocess" => audio::preprocess(p),
            m if m.starts_with("activity.") => activity.handle(m, p),
            m if m.starts_with("supervisor.") => supervisor
                .as_mut()
                .ok_or("supervisor_not_configured".into())
                .and_then(|s| s.handle(m, p)),
            _ => Err("native_method_unknown".into()),
        };
        let response = match result {
            Ok(value) => json!({"id":id,"result":value}),
            Err(error) => json!({"id":id,"error":error}),
        };
        writeln!(out, "{response}").map_err(|_| "native_output_failed")?;
        out.flush().map_err(|_| "native_output_failed")?;
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
