use crate::shared::errors::CliError;

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum McpAction {
    Start,
    Stop,
    Status,
    Endpoint,
    Sessions,
    Smoke,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum QueueAction {
    Start,
    Stop,
    Status,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum AgentLogSyncAction {
    Run,
    Stop,
    Status,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum AdminApiAction {
    Start,
    Stop,
    Status,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum BootstrapAction {
    Preflight,
    Init,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum DoctorAction {
    Summary,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum BackupAction {
    Preflight,
}

#[derive(Debug, Eq, PartialEq)]
pub enum CliCommand {
    Help,
    Version,
    Paths {
        json: bool,
    },
    Status {
        json: bool,
    },
    Mcp {
        action: McpAction,
        json: bool,
    },
    Queue {
        action: QueueAction,
        json: bool,
    },
    AgentLogSync {
        action: AgentLogSyncAction,
        json: bool,
    },
    AdminApi {
        action: AdminApiAction,
        json: bool,
    },
    Bootstrap {
        action: BootstrapAction,
        json: bool,
    },
    Doctor {
        action: DoctorAction,
        json: bool,
    },
    Backup {
        action: BackupAction,
        json: bool,
    },
}

pub fn parse_args<I, S>(args: I) -> Result<CliCommand, CliError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut args = args.into_iter().map(Into::into);
    let Some(command) = args.next() else {
        return Ok(CliCommand::Help);
    };

    match command.as_str() {
        "-h" | "--help" | "help" => Ok(CliCommand::Help),
        "-V" | "--version" | "version" => Ok(CliCommand::Version),
        "paths" => Ok(CliCommand::Paths {
            json: parse_json_flag(args)?,
        }),
        "status" => Ok(CliCommand::Status {
            json: parse_json_flag(args)?,
        }),
        "mcp" => {
            let action_str = args.next().ok_or_else(|| {
                CliError::invalid_arguments(
                    "mcp requires an action: start, stop, status, endpoint, sessions, or smoke",
                )
            })?;
            let action = match action_str.as_str() {
                "start" => McpAction::Start,
                "stop" => McpAction::Stop,
                "status" => McpAction::Status,
                "endpoint" => McpAction::Endpoint,
                "sessions" => McpAction::Sessions,
                "smoke" => McpAction::Smoke,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown mcp action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::Mcp {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "queue" => {
            let action_str = required_action(&mut args, "queue", "start, stop, or status")?;
            let action = match action_str.as_str() {
                "start" => QueueAction::Start,
                "stop" => QueueAction::Stop,
                "status" => QueueAction::Status,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown queue action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::Queue {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "agent-log-sync" => {
            let action_str = required_action(&mut args, "agent-log-sync", "run, stop, or status")?;
            let action = match action_str.as_str() {
                "run" => AgentLogSyncAction::Run,
                "stop" => AgentLogSyncAction::Stop,
                "status" => AgentLogSyncAction::Status,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown agent-log-sync action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::AgentLogSync {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "admin-api" => {
            let action_str = required_action(&mut args, "admin-api", "start, stop, or status")?;
            let action = match action_str.as_str() {
                "start" => AdminApiAction::Start,
                "stop" => AdminApiAction::Stop,
                "status" => AdminApiAction::Status,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown admin-api action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::AdminApi {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "bootstrap" => {
            let action_str = required_action(&mut args, "bootstrap", "preflight or init")?;
            let action = match action_str.as_str() {
                "preflight" => BootstrapAction::Preflight,
                "init" => BootstrapAction::Init,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown bootstrap action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::Bootstrap {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "doctor" => {
            let Some(action_str) = args.next() else {
                return Ok(CliCommand::Doctor {
                    action: DoctorAction::Summary,
                    json: false,
                });
            };
            if action_str == "--json" {
                let json = parse_json_flag(std::iter::once(action_str).chain(args))?;
                return Ok(CliCommand::Doctor {
                    action: DoctorAction::Summary,
                    json,
                });
            }
            let action = match action_str.as_str() {
                "summary" => DoctorAction::Summary,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown doctor action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::Doctor {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "backup" => {
            let action_str = required_action(&mut args, "backup", "preflight")?;
            let action = match action_str.as_str() {
                "preflight" => BackupAction::Preflight,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown backup action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::Backup {
                action,
                json: parse_json_flag(args)?,
            })
        }
        _ => Err(CliError::invalid_arguments(format!(
            "unknown command: {command}"
        ))),
    }
}

fn required_action<I>(args: &mut I, command: &str, expected: &str) -> Result<String, CliError>
where
    I: Iterator<Item = String>,
{
    args.next().ok_or_else(|| {
        CliError::invalid_arguments(format!("{command} requires an action: {expected}"))
    })
}

fn parse_json_flag<I>(args: I) -> Result<bool, CliError>
where
    I: IntoIterator<Item = String>,
{
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            "-h" | "--help" => {
                return Err(CliError::invalid_arguments(
                    "help is only available at top level",
                ))
            }
            _ => {
                return Err(CliError::invalid_arguments(format!(
                    "unknown argument: {arg}"
                )))
            }
        }
    }
    Ok(json)
}

#[cfg(test)]
mod tests {
    use super::{parse_args, CliCommand};
    use crate::shared::errors::CliErrorCategory;

    #[test]
    fn parses_status_json() {
        assert_eq!(
            parse_args(["status", "--json"]).expect("parsed"),
            CliCommand::Status { json: true },
        );
    }

    #[test]
    fn parses_mcp_commands() {
        use super::McpAction;
        assert_eq!(
            parse_args(["mcp", "start"]).expect("parsed"),
            CliCommand::Mcp {
                action: McpAction::Start,
                json: false,
            },
        );
        assert_eq!(
            parse_args(["mcp", "stop"]).expect("parsed"),
            CliCommand::Mcp {
                action: McpAction::Stop,
                json: false,
            },
        );
        assert_eq!(
            parse_args(["mcp", "status", "--json"]).expect("parsed"),
            CliCommand::Mcp {
                action: McpAction::Status,
                json: true,
            },
        );
    }

    #[test]
    fn unknown_commands_are_invalid_arguments() {
        let error = parse_args(["unknown"]).expect_err("unknown command should fail");

        assert_eq!(error.category(), &CliErrorCategory::InvalidArguments);
        assert_eq!(error.category_code(), "invalid_arguments");
        assert_ne!(error.exit_code(), 0);
        assert!(error.to_string().contains("unknown command"));
    }

    #[test]
    fn json_commands_fail_before_output_on_invalid_arguments() {
        let error = parse_args(["paths", "--json", "--unexpected"])
            .expect_err("invalid json command arguments should fail");

        assert_eq!(error.category(), &CliErrorCategory::InvalidArguments);
        assert_eq!(error.exit_code(), 2);
        assert!(error.to_string().contains("unknown argument"));
    }
}
