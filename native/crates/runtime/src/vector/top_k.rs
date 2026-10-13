use std::{cmp::Ordering, collections::BinaryHeap};

#[derive(Clone, Debug)]
pub(super) struct Hit {
    pub(super) row: usize,
    pub(super) score: f64,
}
impl PartialEq for Hit {
    fn eq(&self, b: &Self) -> bool {
        self.row == b.row && self.score == b.score
    }
}
impl Eq for Hit {}
impl PartialOrd for Hit {
    fn partial_cmp(&self, b: &Self) -> Option<Ordering> {
        Some(self.cmp(b))
    }
}
impl Ord for Hit {
    fn cmp(&self, b: &Self) -> Ordering {
        b.score.total_cmp(&self.score).then(self.row.cmp(&b.row))
    }
}

pub(super) fn rank(
    ids: &[String],
    offsets: &[usize],
    values: &[f64],
    norms: &[f64],
    query: &[f64],
    k: usize,
    threshold: f64,
) -> Vec<Hit> {
    let norm = query.iter().map(|v| v * v).sum::<f64>().sqrt();
    let mut heap = BinaryHeap::with_capacity(k);
    for row in 0..ids.len() {
        let values = &values[offsets[row]..offsets[row + 1]];
        let score = if query.len() != values.len() || norm == 0.0 || norms[row] == 0.0 {
            0.0
        } else {
            query.iter().zip(values).map(|(a, b)| a * b).sum::<f64>() / (norm * norms[row])
        };
        if !score.is_finite() || score < threshold {
            continue;
        }
        let hit = Hit { row, score };
        if heap.len() < k {
            heap.push(hit);
        } else if heap.peek().is_some_and(|worst| hit < *worst) {
            heap.pop();
            heap.push(hit);
        }
    }
    let mut hits = heap.into_vec();
    hits.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.row.cmp(&b.row)));
    hits
}
