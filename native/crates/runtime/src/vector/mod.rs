mod cache;
mod sqlite_reader;
mod top_k;

use cache::Matrix;
use rusqlite::Connection;
use serde_json::{Value, json};
use sqlite_reader::identity;
use std::path::PathBuf;

pub struct Store {
    path: PathBuf,
    identity: u128,
    db: Connection,
    matrix: Option<Matrix>,
}

impl Store {
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
            let hits = top_k::rank(
                &m.ids, &m.offsets, &m.values, &m.norms, &query, k, threshold,
            );
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
