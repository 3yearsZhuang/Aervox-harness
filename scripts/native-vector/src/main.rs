use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::fs::File;
use std::io::{self, BufReader, Read, Write};
use std::time::Instant;

#[derive(Debug, Clone, Copy)]
struct Hit {
    index: usize,
    score: f64,
}

impl PartialEq for Hit {
    fn eq(&self, other: &Self) -> bool {
        self.index == other.index && self.score == other.score
    }
}
impl Eq for Hit {}
impl PartialOrd for Hit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Hit {
    fn cmp(&self, other: &Self) -> Ordering {
        // The heap root is the worst retained result; earlier rows win ties.
        other
            .score
            .total_cmp(&self.score)
            .then(self.index.cmp(&other.index))
    }
}

fn cosine(a: &[f64], b: &[f64]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (mut dot, mut norm_a, mut norm_b) = (0.0_f64, 0.0_f64, 0.0_f64);
    for (&x, &y) in a.iter().zip(b) {
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        0.0
    } else {
        dot / (norm_a.sqrt() * norm_b.sqrt())
    }
}

fn search(matrix: &[f64], dimensions: usize, query: &[f64], k: usize, min_score: f64) -> Vec<Hit> {
    if k == 0 || dimensions == 0 {
        return Vec::new();
    }
    let mut heap = BinaryHeap::with_capacity(k);
    for (index, row) in matrix.chunks_exact(dimensions).enumerate() {
        let score = cosine(query, row);
        if score < min_score || !score.is_finite() {
            continue;
        }
        let hit = Hit { index, score };
        if heap.len() < k {
            heap.push(hit);
        } else if heap.peek().is_some_and(|worst| hit < *worst) {
            heap.pop();
            heap.push(hit);
        }
    }
    let mut hits = heap.into_vec();
    hits.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.index.cmp(&b.index)));
    hits
}

fn read_u32(reader: &mut impl Read) -> io::Result<usize> {
    let mut bytes = [0; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes) as usize)
}

fn read_floats(reader: &mut impl Read, count: usize) -> io::Result<Vec<f64>> {
    let mut values = Vec::with_capacity(count);
    for _ in 0..count {
        let mut bytes = [0; 8];
        reader.read_exact(&mut bytes)?;
        let value = f64::from_le_bytes(bytes);
        if !value.is_finite() {
            return Err(io::Error::other("non-finite fixture value"));
        }
        values.push(value);
    }
    Ok(values)
}

fn run() -> io::Result<()> {
    let start = Instant::now();
    let path = std::env::args()
        .nth(1)
        .ok_or_else(|| io::Error::other("fixture path required"))?;
    let file = File::open(path)?;
    let file_bytes = file.metadata()?.len();
    let mut reader = BufReader::new(file);
    let mut magic = [0; 8];
    reader.read_exact(&mut magic)?;
    if &magic != b"AVXVEC01" {
        return Err(io::Error::other("invalid fixture magic"));
    }
    let rows = read_u32(&mut reader)?;
    let dimensions = read_u32(&mut reader)?;
    let queries = read_u32(&mut reader)?;
    let k = read_u32(&mut reader)?;
    if !(1..=100_000).contains(&rows)
        || !(1..=1024).contains(&dimensions)
        || !(1..=32).contains(&queries)
        || !(1..=200).contains(&k)
        || rows * dimensions > 32_000_000
    {
        return Err(io::Error::other("fixture capacity exceeded"));
    }
    let expected_bytes = 24 + ((rows + queries) * dimensions * 8) as u64;
    if file_bytes != expected_bytes {
        return Err(io::Error::other("fixture length mismatch"));
    }
    let matrix = read_floats(&mut reader, rows * dimensions)?;
    let query_vectors = read_floats(&mut reader, queries * dimensions)?;
    let mut out = io::BufWriter::new(io::stdout().lock());
    writeln!(
        out,
        "{{\"ready\":true,\"loadMs\":{},\"matrixBytes\":{}}}",
        start.elapsed().as_secs_f64() * 1000.0,
        matrix.len() * 8
    )?;
    out.flush()?;
    for (index, query) in query_vectors.chunks_exact(dimensions).enumerate() {
        let begin = Instant::now();
        let hits = search(&matrix, dimensions, query, k, 0.0);
        let ms = begin.elapsed().as_secs_f64() * 1000.0;
        write!(out, "{{\"query\":{index},\"ms\":{ms},\"hits\":[")?;
        for (i, hit) in hits.iter().enumerate() {
            if i != 0 {
                write!(out, ",")?;
            }
            write!(out, "{{\"index\":{},\"score\":{}}}", hit.index, hit.score)?;
        }
        writeln!(out, "]}}")?;
        out.flush()?;
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_handles_zero_dimension_mismatch_and_sign() {
        assert_eq!(cosine(&[0.0, 0.0], &[1.0, 0.0]), 0.0);
        assert_eq!(cosine(&[1.0], &[1.0, 2.0]), 0.0);
        assert_eq!(cosine(&[1.0, 0.0], &[-1.0, 0.0]), -1.0);
        assert!((cosine(&[1.0, 0.0], &[1.0, 1.0]) - 0.5_f64.sqrt()).abs() < 1e-12);
    }

    #[test]
    fn stable_top_k_matches_full_sort_and_threshold() {
        let matrix: Vec<f64> = (0..3000).map(|i| ((i * 13) % 37) as f64 - 18.0).collect();
        let query = [1.0, 2.0, -1.0];
        for k in [0, 1, 7, 200, 1001] {
            for threshold in [-1.0, 0.0, 0.9] {
                let mut expected: Vec<Hit> = matrix
                    .chunks_exact(3)
                    .enumerate()
                    .map(|(index, row)| Hit {
                        index,
                        score: cosine(&query, row),
                    })
                    .filter(|hit| hit.score >= threshold)
                    .collect();
                expected.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.index.cmp(&b.index)));
                expected.truncate(k);
                assert_eq!(search(&matrix, 3, &query, k, threshold), expected);
            }
        }
    }

    #[test]
    fn rejects_non_finite_and_truncated_values() {
        assert!(read_floats(&mut &f64::NAN.to_le_bytes()[..], 1).is_err());
        assert!(read_floats(&mut &[0_u8; 7][..], 1).is_err());
    }
}
