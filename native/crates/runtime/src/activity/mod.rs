mod platform;
use platform::{capture, probe, request_permission};

use serde_json::{Value, json};
use std::time::{Duration, Instant, SystemTime};

pub struct Activity {
    observed: Option<(String, SystemTime)>,
    lease: Option<(Value, Instant, Duration, SystemTime)>,
    latest: Option<Value>,
    last_poll: Instant,
}
impl Default for Activity {
    fn default() -> Self {
        Self {
            observed: None,
            lease: None,
            latest: None,
            last_poll: Instant::now(),
        }
    }
}
impl Activity {
    pub fn poll(&mut self) {
        if self.lease.as_ref().is_none_or(|(_, start, ttl, wall)| {
            start.elapsed() >= *ttl || !wall.elapsed().is_ok_and(|d| d < *ttl)
        }) {
            self.revoke();
            return;
        }
        if self.last_poll.elapsed() < Duration::from_secs(1) {
            return;
        }
        self.last_poll = Instant::now();
        self.latest = if probe()["ready"] == true {
            capture().ok().map(|value| self.enrich(value))
        } else {
            None
        };
        if self.latest.is_none() {
            self.revoke();
        }
    }
    pub fn revoke(&mut self) {
        self.observed = None;
        self.lease = None;
        self.latest = None;
    }
    fn enrich(&mut self, mut value: Value) -> Value {
        let identity = format!("{}:{}", value["applicationId"], value["processId"]);
        if self
            .observed
            .as_ref()
            .is_none_or(|(old, _)| *old != identity)
        {
            self.observed = Some((identity, SystemTime::now()));
        }
        if let Some((_, start)) = self.observed.as_ref() {
            value["activeSinceMs"] = json!(
                start
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64
            );
            value["activeForMs"] = json!(start.elapsed().unwrap_or_default().as_millis() as u64);
        }
        value
    }
    pub fn handle(&mut self, method: &str, p: &Value) -> Result<Value, String> {
        match method {
            "activity.probe" => Ok(probe()),
            "activity.request" => {
                request_permission();
                Ok(probe())
            }
            "activity.revoke" => {
                self.revoke();
                Ok(json!({"stopped":true}))
            }
            "activity.lease" => {
                if self.lease.as_ref().is_some_and(|(l, _, _, _)| {
                    ["deviceId", "revisionId", "epoch"]
                        .iter()
                        .any(|k| l[*k] != p[*k])
                }) {
                    self.revoke();
                }
                for key in ["deviceId", "revisionId", "epoch"] {
                    if p[key]
                        .as_str()
                        .is_none_or(|s| s.is_empty() || s.len() > 256)
                    {
                        return Err("activity_lease_invalid".into());
                    }
                }
                let ttl = p["ttlMs"]
                    .as_u64()
                    .filter(|n| *n > 0 && *n <= 15_000)
                    .ok_or("activity_lease_invalid")?;
                if p["source"].as_str() != Some("device.app_activity") {
                    return Err("activity_source_invalid".into());
                }
                if probe()["ready"] != true {
                    self.revoke();
                    return Err("activity_os_unavailable".into());
                }
                self.lease = Some((
                    p.clone(),
                    Instant::now(),
                    Duration::from_millis(ttl),
                    SystemTime::now(),
                ));
                self.latest = None;
                Ok(json!({"active":true}))
            }
            "activity.capture" => {
                let valid = self.lease.as_ref().is_some_and(|(l, start, ttl, wall)| {
                    start.elapsed() < *ttl
                        && wall.elapsed().is_ok_and(|d| d < *ttl)
                        && ["deviceId", "revisionId", "epoch"]
                            .iter()
                            .all(|k| l[*k] == p[*k])
                });
                if !valid {
                    self.revoke();
                    return Err("activity_lease_expired_or_mismatched".into());
                }
                // Re-probe for every read; neither an old handle nor a cached event grants access.
                if probe()["ready"] != true {
                    self.revoke();
                    return Err("activity_os_unavailable".into());
                }
                let value = self.enrich(capture()?);
                if probe()["ready"] != true {
                    self.revoke();
                    return Err("activity_os_revoked".into());
                }
                self.latest = Some(value.clone());
                Ok(json!({"records":[value]}))
            }
            _ => Err("activity_method_unknown".into()),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_or_foreign_lease_cannot_capture() {
        let mut a = Activity::default();
        assert!(a.handle("activity.capture", &json!({})).is_err());
        a.lease = Some((
            json!({"deviceId":"a","revisionId":"r","epoch":"e"}),
            Instant::now(),
            Duration::from_secs(1),
            SystemTime::now(),
        ));
        assert!(
            a.handle(
                "activity.capture",
                &json!({"deviceId":"b","revisionId":"r","epoch":"e"})
            )
            .is_err()
        );
        assert!(a.lease.is_none());
    }
    #[test]
    fn expired_lease_discards_buffered_data() {
        let mut a = Activity {
            lease: Some((
                json!({}),
                Instant::now() - Duration::from_secs(1),
                Duration::from_millis(1),
                SystemTime::now(),
            )),
            latest: Some(json!({"applicationName":"old"})),
            ..Activity::default()
        };
        a.poll();
        assert!(a.lease.is_none() && a.latest.is_none());
    }
}
