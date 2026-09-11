use serde_json::{json, Value};

fn object(properties: Value) -> Value {
    let required = properties
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    json!({"type":"object","additionalProperties":false,"required":required,"properties":properties})
}
fn strings() -> Value {
    json!({"type":"array","items":{"type":"string"}})
}

pub(super) fn format(name: &str) -> Value {
    let schema = match name {
        "episode" => {
            let mut fields = serde_json::Map::new();
            for key in [
                "title",
                "context",
                "intent",
                "actionTaken",
                "outcome",
                "failedApproach",
                "reusableLesson",
            ] {
                fields.insert(key.into(), json!({"type":"string"}));
            }
            for key in [
                "keyDecisions",
                "usefulFutureTriggers",
                "openLoops",
                "domains",
                "technologies",
                "changeTypes",
                "tools",
            ] {
                fields.insert(key.into(), strings());
            }
            fields.insert("generationKind".into(),json!({"type":"string","enum":["task_episode","failure_episode","decision_episode"]}));
            fields.insert(
                "outcomeKind".into(),
                json!({"type":"string","enum":["success","failure","mixed","unknown"]}),
            );
            let mut scores = serde_json::Map::new();
            for key in [
                "importance",
                "confidence",
                "reusability",
                "decision_density",
                "failure_value",
                "causal_clarity",
                "project_specificity",
                "evidence_quality",
                "compression_quality",
                "staleness_risk",
            ] {
                scores.insert(
                    key.into(),
                    json!({"type":"integer","minimum":0,"maximum":100}),
                );
            }
            fields.insert("scores".into(), object(Value::Object(scores)));
            json!({"type":"array","maxItems":2,"items":object(Value::Object(fields))})
        }
        "episode_duplicate" => object(
            json!({"publish":{"type":"boolean"},"duplicateOfEpisodeId":{"type":["string","null"]},"confidence":{"type":"integer","minimum":0,"maximum":100},"reason":{"type":"string"}}),
        ),
        "finding" => {
            json!({"type":"array","items":object(json!({"type":{"type":"string","enum":["rule","procedure"]},"polarity":{"type":"string","enum":["positive","negative"]},"title":{"type":"string"},"content":{"type":"string"}}))})
        }
        "curation" => object(
            json!({"schemaVersion":{"type":"integer","enum":[2]},"action":{"type":"string","enum":["merge","deprecate_duplicate","keep_separate","needs_evidence"]},"survivorKnowledgeId":{"type":["string","null"]},"deprecatedKnowledgeIds":strings(),"retainedGroupIds":strings(),"coverage":{"type":"array","items":object(json!({"sourceGroupId":{"type":"string"},"disposition":{"type":"string","enum":["retained","entailed"]},"targetGroupIds":strings()}))},"reasonCodes":strings(),"rationale":{"type":"string","maxLength":1200}}),
        ),
        "curation_verify" => {
            let mut checks = serde_json::Map::new();
            for key in [
                "obligations",
                "conditions",
                "negation",
                "exceptions",
                "numbersAndUnits",
                "identifiers",
                "ordering",
                "provenance",
            ] {
                checks.insert(
                    key.into(),
                    json!({"type":"string","enum":["preserved","not_preserved","unknown"]}),
                );
            }
            object(
                json!({"schemaVersion":{"type":"integer","enum":[2]},"verdict":{"type":"string","enum":["supported","rejected","unknown"]},"inputHash":{"type":"string"},"findings":{"type":"array","items":object(json!({"sourceGroupId":{"type":"string"},"targetGroupIds":strings(),"checks":object(Value::Object(checks))}))},"noNewMeaning":{"type":"string","enum":["preserved","not_preserved","unknown"]},"noUnresolvedContradiction":{"type":"string","enum":["preserved","not_preserved","unknown"]},"rationale":{"type":"string"}}),
            )
        }
        _ => unreachable!("unknown structured output contract"),
    };
    json!({"type":"json_schema","json_schema":{"name":name,"strict":true,"schema":schema}})
}

/// Never extract a valid prefix from a truncated generation. Missing finish_reason is also
/// incomplete on the OpenAI-compatible HTTP boundary; agent-session has its own terminal event.
pub(super) fn content(payload: &Value) -> Result<&str, String> {
    let choice = payload
        .pointer("/choices/0")
        .ok_or("structured_output_missing_choice")?;
    if choice["finish_reason"] != "stop" {
        return Err(format!(
            "structured_output_incomplete finish_reason={}",
            choice["finish_reason"]
        ));
    }
    if choice
        .pointer("/message/refusal")
        .is_some_and(|v| !v.is_null())
    {
        return Err("structured_output_refused".into());
    }
    let text = choice
        .pointer("/message/content")
        .and_then(Value::as_str)
        .ok_or("structured_output_missing_content")?;
    serde_json::from_str::<Value>(text).map_err(|_| "structured_output_invalid_json")?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_truncation_even_if_content_is_valid_json() {
        for reason in [
            json!("length"),
            json!("content_filter"),
            json!("tool_calls"),
            Value::Null,
        ] {
            assert!(content(
                &json!({"choices":[{"finish_reason":reason,"message":{"content":"[]"}}]})
            )
            .is_err());
        }
        assert!(content(
            &json!({"choices":[{"finish_reason":"stop","message":{"content":"[] trailing"}}]})
        )
        .is_err());
        assert_eq!(
            content(&json!({"choices":[{"finish_reason":"stop","message":{"content":"[]"}}]}))
                .unwrap(),
            "[]"
        );
    }
}
