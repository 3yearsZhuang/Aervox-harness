mod activity;
mod audio;
mod protocol;
mod supervisor;
mod vector;
use serde_json::json;
use std::{
    io::{self, Write},
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
            match protocol::read_frame(&mut input) {
                Ok(Some(request)) => {
                    if tx.send(Ok(request)).is_err() {
                        return;
                    }
                }
                Ok(None) => {
                    INPUT_OPEN.store(false, std::sync::atomic::Ordering::Release);
                    return;
                }
                Err(error) => {
                    let _ = tx.send(Err(error));
                    return;
                }
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
        let p = &request["params"];
        let result = protocol::validate_request(&request).and_then(|()| match request["method"].as_str().unwrap_or("") {
            "hello" => Ok(
                json!({"protocol":protocol::version(),"version":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS}),
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
        });
        if result.is_err()
            && matches!(
                request["method"].as_str(),
                Some("activity.lease" | "activity.capture")
            )
        {
            activity.revoke();
        }
        let response = protocol::response(&request, result);
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
