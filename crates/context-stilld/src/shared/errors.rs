use std::{error::Error, fmt};

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum CliErrorCategory {
    InvalidArguments,
    Runtime,
    Io,
}

impl CliErrorCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::InvalidArguments => "invalid_arguments",
            Self::Runtime => "runtime",
            Self::Io => "io",
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CliError {
    category: CliErrorCategory,
    exit_code: i32,
    message: String,
}

impl CliError {
    pub fn new(message: impl Into<String>) -> Self {
        Self::runtime(message)
    }

    pub fn invalid_arguments(message: impl Into<String>) -> Self {
        Self {
            category: CliErrorCategory::InvalidArguments,
            exit_code: 2,
            message: message.into(),
        }
    }

    pub fn runtime(message: impl Into<String>) -> Self {
        Self {
            category: CliErrorCategory::Runtime,
            exit_code: 1,
            message: message.into(),
        }
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self {
            category: CliErrorCategory::Io,
            exit_code: 1,
            message: message.into(),
        }
    }

    pub fn category(&self) -> &CliErrorCategory {
        &self.category
    }

    pub fn category_code(&self) -> &'static str {
        self.category.as_str()
    }

    pub fn exit_code(&self) -> i32 {
        self.exit_code
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for CliError {}

#[cfg(test)]
mod tests {
    use super::{CliError, CliErrorCategory};

    #[test]
    fn invalid_arguments_have_stable_category_and_exit_code() {
        let error = CliError::invalid_arguments("unknown command");

        assert_eq!(error.category(), &CliErrorCategory::InvalidArguments);
        assert_eq!(error.category_code(), "invalid_arguments");
        assert_eq!(error.exit_code(), 2);
        assert_eq!(error.to_string(), "unknown command");
    }

    #[test]
    fn runtime_and_io_errors_exit_as_runtime_failures() {
        let runtime = CliError::new("runtime failed");
        let io = CliError::io("io failed");

        assert_eq!(runtime.category(), &CliErrorCategory::Runtime);
        assert_eq!(runtime.exit_code(), 1);
        assert_eq!(io.category(), &CliErrorCategory::Io);
        assert_eq!(io.category_code(), "io");
        assert_eq!(io.exit_code(), 1);
    }
}
