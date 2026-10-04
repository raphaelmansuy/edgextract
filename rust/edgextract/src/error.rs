use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error(transparent)]
    SystemOne(#[from] SystemOneError),
    #[error("{0}")]
    Ontology(String),
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Cache(String),
}

impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Error::Io(value.to_string())
    }
}

#[cfg(feature = "native")]
impl From<rusqlite::Error> for Error {
    fn from(value: rusqlite::Error) -> Self {
        Error::Cache(value.to_string())
    }
}

/// Transport or contract failure. The caller must not invent an answer.
#[derive(Debug, Error, Clone)]
#[error("{0}")]
pub struct SystemOneError(pub String);

impl SystemOneError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self(msg.into())
    }
}
