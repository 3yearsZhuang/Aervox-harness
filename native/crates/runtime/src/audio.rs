use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

pub fn preprocess(p: &Value) -> Result<Value, String> {
    let encoded = p["wav"]
        .as_str()
        .filter(|s| s.len() <= 28 * 1024 * 1024)
        .ok_or("audio_input_limit")?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "audio_base64_invalid")?;
    let (samples, rate) = decode(&bytes)?;
    let length = ((samples.len() as f64 * 16000.0 / rate as f64).round() as usize).max(1);
    if length > 16000 * 600 {
        return Err("audio_duration_limit".into());
    }
    let mut output = Vec::with_capacity(length * 4);
    for i in 0..length {
        let pos = i as f64 * rate as f64 / 16000.0;
        let idx = pos.floor() as usize;
        let frac = pos - idx as f64;
        let a = samples.get(idx).copied().unwrap_or(0.0) as f64;
        let b = samples
            .get((idx + 1).min(samples.len() - 1))
            .copied()
            .unwrap_or(0.0) as f64;
        output.extend_from_slice(&((a + (b - a) * frac) as f32).to_le_bytes());
    }
    Ok(json!({"pcm":STANDARD.encode(output),"sampleRate":16000,"frames":length}))
}
fn decode(b: &[u8]) -> Result<(Vec<f32>, u32), String> {
    let u16at = |i| {
        b.get(i..i + 2)
            .map(|s| u16::from_le_bytes([s[0], s[1]]))
            .ok_or("audio_truncated")
    };
    let u32at = |i| {
        b.get(i..i + 4)
            .map(|s| u32::from_le_bytes(s.try_into().unwrap()))
            .ok_or("audio_truncated")
    };
    if b.len() < 44 || b.len() > 20 * 1024 * 1024 || &b[..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err("audio_wav_invalid".into());
    }
    if u32at(4)? as usize + 8 != b.len() {
        return Err("audio_riff_length_invalid".into());
    }
    let mut offset = 12;
    let mut format = None;
    let mut data = None;
    while offset + 8 <= b.len() {
        let size = u32at(offset + 4)? as usize;
        let end = offset.checked_add(8 + size).ok_or("audio_chunk_invalid")?;
        if end > b.len() {
            return Err("audio_truncated".into());
        }
        if &b[offset..offset + 4] == b"fmt " {
            if size < 16 {
                return Err("audio_fmt_invalid".into());
            }
            format = Some((
                u16at(offset + 8)?,
                u16at(offset + 10)?,
                u32at(offset + 12)?,
                u16at(offset + 22)?,
            ));
        } else if &b[offset..offset + 4] == b"data" {
            data = Some(&b[offset + 8..end]);
        }
        offset = end + (size % 2);
    }
    let (kind, channels, rate, bits) = format.ok_or("audio_fmt_missing")?;
    let data = data.ok_or("audio_data_missing")?;
    if !(1..=8).contains(&channels)
        || !(8000..=192000).contains(&rate)
        || !((kind == 1 && bits == 16) || (kind == 3 && bits == 32))
    {
        return Err("audio_format_unsupported".into());
    }
    let stride = (bits as usize / 8) * channels as usize;
    if data.is_empty() || data.len() % stride != 0 {
        return Err("audio_frames_invalid".into());
    }
    let frames = data.len() / stride;
    if frames > rate as usize * 600 {
        return Err("audio_duration_limit".into());
    }
    let mut samples = Vec::with_capacity(frames);
    for frame in data.chunks_exact(stride) {
        let mut sum = 0f64;
        for channel in frame.chunks_exact(bits as usize / 8) {
            let value = if kind == 1 {
                i16::from_le_bytes(channel.try_into().unwrap()) as f32 / 32768.0
            } else {
                f32::from_le_bytes(channel.try_into().unwrap())
            };
            if !value.is_finite() {
                return Err("audio_nonfinite".into());
            }
            sum += value as f64;
        }
        samples.push((sum / channels as f64) as f32);
    }
    Ok((samples, rate))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_audio_is_rejected() {
        for b in [vec![], vec![0; 44], vec![0; 256]] {
            assert!(decode(&b).is_err());
        }
    }
}
