fn main() {
    match context_stilld::run(
        std::env::args().skip(1),
        &context_stilld::shared::config::OsEnv,
        &context_stilld::shared::process::OsSupervisor,
    ) {
        Ok(output) => {
            if !output.is_empty() {
                println!("{output}");
            }
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(error.exit_code());
        }
    }
}
