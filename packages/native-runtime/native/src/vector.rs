use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{cmp::Ordering, collections::BinaryHeap, path::PathBuf, time::Duration};

#[derive(Clone, Debug)]
struct Hit {
    row: usize,
    score: f64,
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
struct Matrix {
    ids: Vec<String>,
    offsets: Vec<usize>,
    values: Vec<f64>,
    norms: Vec<f64>,
    version: i64,
    model: String,
}
pub struct Store {
    path: PathBuf,
    identity: u128,
    db: Connection,
    matrix: Option<Matrix>,
}

fn identity(path: &std::path::Path) -> Result<u128, String> {
    let meta = path.metadata().map_err(|_| "vector_database_missing")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(((meta.dev() as u128) << 64) | meta.ino() as u128)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(meta.creation_time() as u128)
    }
}
impl Store {
    pub fn open(path: &str) -> Result<Self, String> {
        let path = std::fs::canonicalize(path).map_err(|_| "vector_database_missing")?;
        let identity = identity(&path)?;
        let db = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| "vector_database_open_failed")?;
        db.busy_timeout(Duration::from_millis(200))
            .map_err(|_| "vector_database_busy")?;
        db.execute_batch("PRAGMA query_only=ON")
            .map_err(|_| "vector_readonly_failed")?;
        Ok(Self {
            path,
            identity,
            db,
            matrix: None,
        })
    }
    fn version(&self) -> Result<i64, String> {
        self.db
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .map_err(|_| "vector_watermark_failed".into())
    }
    fn load(&mut self, model: &str, version: i64) -> Result<(), String> {
        // Materialise a single read snapshot; never hold a writer connection.
        let tx = self
            .db
            .transaction()
            .map_err(|_| "vector_snapshot_failed")?;
        let (count, bytes): (i64, i64) = tx.query_row("SELECT count(*), coalesce(sum(length(embedding_json)),0) FROM memory_embeddings WHERE model_id=?1", [model], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|_| "vector_schema_unavailable")?;
        if count > 100_000 || bytes > 768 * 1024 * 1024 {
            return Err("vector_capacity_exceeded".into());
        }
        let mut matrix = Matrix {
            ids: Vec::new(),
            offsets: vec![0],
            values: Vec::new(),
            norms: Vec::new(),
            model: model.into(),
            version,
        };
        {
            let mut stmt = tx
                .prepare(
                    "SELECT memory_id, embedding_json FROM memory_embeddings WHERE model_id=?1",
                )
                .map_err(|_| "vector_schema_unavailable")?;
            let mut rows = stmt.query([model]).map_err(|_| "vector_read_failed")?;
            while let Some(row) = rows.next().map_err(|_| "vector_read_failed")? {
                let id: String = row.get(0).map_err(|_| "vector_id_invalid")?;
                let encoded: String = row.get(1).map_err(|_| "vector_data_invalid")?;
                if encoded.len() > 1024 * 1024 || id.len() > 512 {
                    return Err("vector_record_limit".into());
                }
                // Invalid legacy JSON has the same empty-vector score as the TS repository.
                let values: Vec<f64> =
                    serde_json::from_str(&encoded).map_err(|_| "vector_data_invalid")?;
                if values.len() > 1024
                    || matrix.values.len() + values.len() > 32_000_000
                    || values.iter().any(|v| !v.is_finite())
                {
                    return Err("vector_capacity_exceeded".into());
                }
                matrix
                    .norms
                    .push(values.iter().map(|v| v * v).sum::<f64>().sqrt());
                matrix.values.extend(values);
                matrix.offsets.push(matrix.values.len());
                matrix.ids.push(id);
            }
        }
        tx.commit().map_err(|_| "vector_snapshot_failed")?;
        self.matrix = Some(matrix);
        Ok(())
    }
    pub fn search(&mut self, params: &Value) -> Result<Value, String> {
        if identity(&self.path)? != self.identity {
            *self = Self::open(self.path.to_str().ok_or("vector_path_invalid")?)?;
        }
        let model = params["modelId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 512)
            .ok_or("vector_model_invalid")?;
        let query: Vec<f64> =
            serde_json::from_value(params["query"].clone()).map_err(|_| "vector_query_invalid")?;
        let k = params["topK"]
            .as_u64()
            .filter(|k| *k <= 200)
            .ok_or("vector_topk_invalid")? as usize;
        let threshold = params["minScore"]
            .as_f64()
            .filter(|v| v.is_finite())
            .ok_or("vector_threshold_invalid")?;
        if query.len() > 1024 || query.iter().any(|v| !v.is_finite()) {
            return Err("vector_query_invalid".into());
        }
        if k == 0 {
            return Ok(json!({"hits":[], "cacheHit":false}));
        }
        let norm = query.iter().map(|v| v * v).sum::<f64>().sqrt();
        for _ in 0..3 {
            let version = self.version()?;
            let cached = self
                .matrix
                .as_ref()
                .is_some_and(|m| m.model == model && m.version == version);
            if !cached {
                self.load(model, version)?;
            }
            let m = self.matrix.as_ref().ok_or("vector_cache_missing")?;
            let mut heap = BinaryHeap::with_capacity(k);
            for row in 0..m.ids.len() {
                let values = &m.values[m.offsets[row]..m.offsets[row + 1]];
                let score = if query.len() != values.len() || norm == 0.0 || m.norms[row] == 0.0 {
                    0.0
                } else {
                    query.iter().zip(values).map(|(a, b)| a * b).sum::<f64>()
                        / (norm * m.norms[row])
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
            let result = json!({"hits":hits.iter().map(|h| json!({"id":m.ids[h.row],"score":h.score})).collect::<Vec<_>>(), "cacheHit":cached, "rows":m.ids.len()});
            if identity(&self.path)? != self.identity {
                *self = Self::open(self.path.to_str().ok_or("vector_path_invalid")?)?;
                continue;
            }
            if self.version()? == version {
                return Ok(result);
            }
            self.matrix = None;
        }
        Err("vector_snapshot_changed".into())
    }
}
