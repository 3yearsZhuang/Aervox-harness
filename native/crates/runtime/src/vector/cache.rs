pub(super) struct Matrix {
    pub(super) ids: Vec<String>,
    pub(super) offsets: Vec<usize>,
    pub(super) values: Vec<f64>,
    pub(super) norms: Vec<f64>,
    pub(super) version: i64,
    pub(super) model: String,
}
