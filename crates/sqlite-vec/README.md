# sqlite-vec vendored binding

This crate vendors the official `sqlite-vec` Rust binding shape so `context-stilld`
can statically link sqlite-vec without Bun SQLite dynamic extension loading.

The crates.io `sqlite-vec` tarball available during implementation was missing
the C files included by `sqlite-vec.c`, so the source files are pinned here from
the official upstream repository source `04d28bd21773981e2d266bbf6aa4efbd011eb4f6`
plus the generated header shape from `sqlite-vec` `0.1.10-alpha.4`.
