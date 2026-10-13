use super::{Store, cache::Matrix};
use rusqlite::{Connection, OpenFlags};
use std::time::Duration;

pub(super) fn identity(path: &std::path::Path) -> Result<u128, String> {
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
    pub(super) fn version(&self) -> Result<i64, String> {
        self.db
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .map_err(|_| "vector_watermark_failed".into())
    }
    pub(super) fn load(&mut self, model: &str, version: i64) -> Result<(), String> {
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
}
