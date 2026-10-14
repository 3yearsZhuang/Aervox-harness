use serde_json::{Value, json};
use std::{io::BufRead, sync::OnceLock};

fn contract() -> &'static Value {
    static CONTRACT: OnceLock<Value> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!("../../../protocol/runtime.json"))
            .expect("checked native protocol schema")
    })
}

pub fn version() -> u64 {
    contract()["protocol"].as_u64().unwrap()
}

pub fn read_frame(input: &mut impl BufRead) -> Result<Option<Value>, String> {
    let limit = contract()["limits"]["inputBytes"].as_u64().unwrap() as usize;
    let mut bytes = Vec::new();
    loop {
        let chunk = input.fill_buf().map_err(|_| "native_input_failed")?;
        if chunk.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("native_request_truncated".into())
            };
        }
        let n = chunk
            .iter()
            .position(|b| *b == b'\n')
            .map_or(chunk.len(), |n| n + 1);
        if bytes.len() + n > limit {
            return Err("native_input_limit".into());
        }
        let complete = chunk[n - 1] == b'\n';
        bytes.extend_from_slice(&chunk[..n]);
        input.consume(n);
        if complete {
            return serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "native_request_invalid".into());
        }
    }
}

fn matches(schema: &Value, value: &Value) -> bool {
    if let Some(reference) = schema["$ref"].as_str() {
        return matches(
            &contract()["$defs"][reference.trim_start_matches("#/$defs/")],
            value,
        );
    }
    if let Some(expected) = schema.get("const") {
        return value == expected;
    }
    if let Some(values) = schema["enum"].as_array() {
        return values.contains(value);
    }
    if let Some(types) = schema["type"].as_array() {
        return types.iter().any(|kind| {
            let mut variant = schema.clone();
            variant["type"] = kind.clone();
            matches(&variant, value)
        });
    }
    match schema["type"].as_str() {
        Some("null") => value.is_null(),
        Some("boolean") => value.is_boolean(),
        Some("string") => value.as_str().is_some_and(|s| {
            schema["minLength"]
                .as_u64()
                .is_none_or(|min| s.chars().count() as u64 >= min)
        }),
        Some(kind @ ("integer" | "number")) => value.as_f64().is_some_and(|n| {
            n.is_finite()
                && (kind != "integer" || (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0))
                && schema["minimum"].as_f64().is_none_or(|min| n >= min)
                && schema["maximum"].as_f64().is_none_or(|max| n <= max)
        }),
        Some("array") => value.as_array().is_some_and(|items| {
            schema["maxItems"]
                .as_u64()
                .is_none_or(|max| items.len() as u64 <= max)
                && items.iter().all(|item| matches(&schema["items"], item))
        }),
        Some("object") => value.as_object().is_some_and(|object| {
            if schema["required"].as_array().is_some_and(|keys| {
                keys.iter()
                    .any(|key| !object.contains_key(key.as_str().unwrap()))
            }) {
                return false;
            }
            object.iter().all(|(key, item)| {
                if let Some(field) = schema["properties"].get(key) {
                    matches(field, item)
                } else if schema["additionalProperties"].is_object() {
                    matches(&schema["additionalProperties"], item)
                } else {
                    schema["additionalProperties"] != false
                }
            })
        }),
        _ => false,
    }
}

fn matches_payload(method: &str, side: &str, value: &Value) -> bool {
    contract()["methods"]
        .get(method)
        .is_some_and(|definition| matches(&definition[side], value))
}

pub fn validate_request(request: &Value) -> Result<(), String> {
    if !request.is_object()
        || request.as_object().unwrap().len() != 3
        || !request["id"]
            .as_u64()
            .is_some_and(|id| (1..=9_007_199_254_740_991).contains(&id))
    {
        return Err("native_request_invalid".into());
    }
    let method = request["method"].as_str().ok_or("native_request_invalid")?;
    if contract()["methods"].get(method).is_none() {
        return Err("native_method_unknown".into());
    }
    if !matches_payload(method, "params", &request["params"]) {
        return Err("native_request_invalid".into());
    }
    Ok(())
}

pub fn response(request: &Value, result: Result<Value, String>) -> Value {
    let method = request["method"].as_str().unwrap_or("");
    match result {
        Ok(value) if matches_payload(method, "result", &value) => {
            json!({"id":request["id"],"result":value})
        }
        Ok(_) => json!({"id":request["id"],"error":"native_response_invalid"}),
        Err(error)
            if contract()["errors"]
                .as_array()
                .unwrap()
                .contains(&json!(error)) =>
        {
            json!({"id":request["id"],"error":error})
        }
        Err(_) => json!({"id":request["id"],"error":"native_response_invalid"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_payload_contracts() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../../../protocol/fixtures.json")).unwrap();
        for fixture in fixtures {
            assert_eq!(
                matches_payload(
                    fixture["method"].as_str().unwrap(),
                    fixture["side"].as_str().unwrap(),
                    &fixture["value"]
                ),
                fixture["valid"].as_bool().unwrap(),
                "{}",
                fixture["name"]
            );
        }
    }
    #[test]
    fn frames_are_complete_bounded_and_envelopes_are_checked() {
        use std::io::Cursor;
        assert!(read_frame(&mut Cursor::new(b"{\"id\":1}")).is_err());
        assert!(read_frame(&mut Cursor::new(b"")).unwrap().is_none());
        let request = json!({"id":1,"method":"hello","params":{}});
        assert!(validate_request(&request).is_ok());
        for bad in [
            json!({"id":-1,"method":"hello","params":{}}),
            json!({"id":1,"method":"hello"}),
            json!({"id":1,"method":"hello","params":{},"extra":true}),
        ] {
            assert!(validate_request(&bad).is_err());
        }
        let limit = contract()["limits"]["inputBytes"].as_u64().unwrap() as usize;
        assert_eq!(
            read_frame(&mut Cursor::new(vec![b' '; limit + 1])).unwrap_err(),
            "native_input_limit"
        );
    }
}
