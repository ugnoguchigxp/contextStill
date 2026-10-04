use crate::shared::errors::CliError;
use serde_json::Value;
const SYSTEM_CONTEXT_CATALOG: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../.s11tnext/catalog.json"
));

pub(crate) fn render_catalog_prompt(key: &str, variables: &Value) -> Result<String, CliError> {
    let catalog: Value = serde_json::from_str(SYSTEM_CONTEXT_CATALOG).map_err(|error| {
        CliError::io(format!("invalid embedded system context catalog: {error}"))
    })?;
    let sections = catalog
        .pointer(&format!(
            "/contexts/{}/locales/ja-JP/sections",
            key.replace('~', "~0").replace('/', "~1")
        ))
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::io(format!("system context catalog omitted {key}")))?;
    let mut rendered_sections = Vec::new();
    for section in sections {
        let mut rendered = String::new();
        for segment in section
            .get("segments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match segment.get("type").and_then(Value::as_str) {
                Some("literal") => rendered.push_str(
                    segment
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ),
                Some("variable") => {
                    let name = segment
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| CliError::io("system context variable omitted name"))?;
                    let value = variables.get(name).ok_or_else(|| {
                        CliError::io(format!("system context variable missing: {name}"))
                    })?;
                    match value {
                        Value::String(text) => rendered.push_str(text),
                        other => rendered.push_str(&other.to_string()),
                    }
                }
                _ => {}
            }
        }
        if !rendered.trim().is_empty() {
            rendered_sections.push(rendered);
        }
    }
    Ok(rendered_sections.join("\n\n"))
}
