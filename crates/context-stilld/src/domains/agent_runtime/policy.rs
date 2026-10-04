pub(crate) const NO_GAIN_LIMIT: u32 = 2;
pub(crate) const FETCH_FAILURE_LIMIT: u32 = 3;
pub(crate) const KNOWLEDGE_CALL_LIMIT: u32 = 2;
use super::budget::Budget;
use super::source::{Quote, Snapshot};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Question {
    pub id: String,
    pub candidate_key: String,
    pub question: String,
    pub success_criteria: String,
    pub resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Action {
    ReadSource {
        snapshot_hash: String,
        from_byte: usize,
        to_byte: usize,
        question_id: String,
        expected_gain: String,
    },
    LookupKnowledge {
        query: String,
        question_id: String,
        expected_gain: String,
    },
    DelegateResearch {
        question_ids: Vec<String>,
        expected_gain: String,
    },
    Finish {
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EvidenceDraft {
    pub snapshot_hash: String,
    pub text: String,
    pub role: String,
    pub from_byte: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CandidateDraft {
    pub candidate: Value,
    pub evidence: Vec<EvidenceDraft>,
    pub unresolved_questions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Envelope {
    pub version: u32,
    pub candidates: Vec<CandidateDraft>,
    pub assessment: Option<Value>,
    pub questions: Vec<Question>,
    pub evidence: Vec<EvidenceDraft>,
    pub next: Action,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    pub no_gain: u32,
    pub fetch_failures: u32,
    pub reconsidered: bool,
    pub knowledge_calls: u32,
    pub delegated: bool,
    pub format_repaired: bool,
    pub body_repaired: bool,
}

pub(crate) type ReadRanges = Vec<(String, usize, usize)>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct State {
    pub sources: Vec<Snapshot>,
    pub read_ranges: ReadRanges,
    pub candidates: Vec<CandidateDraft>,
    pub assessment: Option<Value>,
    pub questions: Vec<Question>,
    pub evidence: Vec<Quote>,
    pub history: Vec<Value>,
    pub next: Option<Action>,
    pub budget: Budget,
    pub progress: Progress,
    pub finalizing: bool,
    pub original_candidate: Option<Value>,
    pub final_body_hash: Option<String>,
    #[serde(default)]
    pub final_result: Option<Value>,
    #[serde(default)]
    pub applied_step: i64,
    #[serde(default)]
    pub final_pending_after_step: Option<i64>,
}

impl State {
    pub fn new(primary: Snapshot, original_candidate: Option<Value>) -> Self {
        Self {
            sources: vec![primary],
            read_ranges: Vec::new(),
            candidates: Vec::new(),
            assessment: None,
            questions: Vec::new(),
            evidence: Vec::new(),
            history: Vec::new(),
            next: None,
            budget: Budget::default(),
            progress: Progress::default(),
            finalizing: false,
            original_candidate,
            final_body_hash: None,
            final_result: None,
            applied_step: 0,
            final_pending_after_step: None,
        }
    }
    pub fn locate(&self, draft: &EvidenceDraft) -> Result<Quote, String> {
        if draft.text.trim().is_empty() || draft.text.len() > 16_384 {
            return Err("invalid_quote".into());
        }
        let source = self
            .sources
            .iter()
            .find(|s| s.hash == draft.snapshot_hash)
            .ok_or("unknown_snapshot")?;
        let mut matches = source.text.match_indices(&draft.text).filter(|(from, _)| {
            draft.from_byte.is_none_or(|expected| expected == *from)
                && self.read_ranges.iter().any(|(hash, a, b)| {
                    hash == &source.hash && *a <= *from && from + draft.text.len() <= *b
                })
        });
        let (from, _) = matches.next().ok_or("quote_outside_read_ranges")?;
        if matches.next().is_some() {
            return Err("ambiguous_quote_requires_byte_locator".into());
        }
        let q = Quote {
            snapshot_hash: source.hash.clone(),
            from_byte: from,
            to_byte: from + draft.text.len(),
            text: draft.text.clone(),
            role: draft.role.clone(),
        };
        source.validate(&q)?;
        Ok(q)
    }
    pub fn primary_read_complete(&self) -> bool {
        let primary = self
            .sources
            .iter()
            .filter(|s| s.kind == "primary")
            .collect::<Vec<_>>();
        !primary.is_empty()
            && primary.iter().all(|source| {
                if source.text.is_empty() {
                    return false;
                }
                let mut ranges = self
                    .read_ranges
                    .iter()
                    .filter(|(h, _, _)| h == &source.hash)
                    .map(|(_, a, b)| (*a, *b))
                    .collect::<Vec<_>>();
                ranges.sort_unstable();
                let mut covered = 0;
                for (from, to) in ranges {
                    if from > covered {
                        return false;
                    }
                    covered = covered.max(to);
                }
                covered >= source.text.len()
            })
    }
    pub fn novel_evidence(&self, quote: &Quote) -> bool {
        quote.role != "context"
            && !self.evidence.iter().any(|old| {
                old.snapshot_hash == quote.snapshot_hash
                    && old.from_byte <= quote.from_byte
                    && quote.to_byte <= old.to_byte
            })
    }
    pub fn validate_envelope(
        &self,
        envelope: &Envelope,
        covering: bool,
    ) -> Result<Vec<Quote>, String> {
        if envelope.version != 1
            || envelope.candidates.len() > 20
            || envelope.questions.len() > 12
            || envelope.evidence.len() > 32
        {
            return Err("invalid_agent_output".into());
        }
        if covering && !envelope.candidates.is_empty() || !covering && envelope.assessment.is_some()
        {
            return Err("invalid_policy_output".into());
        }
        let candidate_keys = envelope
            .candidates
            .iter()
            .map(|c| super::source::hash(&c.candidate.to_string()))
            .chain(
                self.original_candidate
                    .iter()
                    .map(|c| super::source::hash(&c.to_string())),
            )
            .collect::<BTreeSet<_>>();
        let mut ids = BTreeSet::new();
        for q in &envelope.questions {
            if q.id.trim().is_empty()
                || !ids.insert(&q.id)
                || q.question.trim().is_empty()
                || q.success_criteria.trim().is_empty()
                || q.candidate_key.trim().is_empty()
                || q.question.len() > 2_000
                || q.success_criteria.len() > 2_000
                || q.id.len() > 128
                || q.candidate_key.len() > 128
                || q.candidate_key != "source" && !candidate_keys.contains(&q.candidate_key)
            {
                return Err("invalid_question".into());
            }
        }
        let mut evidence = Vec::new();
        for draft in envelope
            .evidence
            .iter()
            .chain(envelope.candidates.iter().flat_map(|c| &c.evidence))
        {
            let quote = self.locate(draft)?;
            if !evidence.contains(&quote) {
                evidence.push(quote);
            }
        }
        for old in self.questions.iter().filter(|q| {
            !q.resolved
                && (q.candidate_key == "source" || candidate_keys.contains(&q.candidate_key))
        }) {
            let current = envelope
                .questions
                .iter()
                .find(|q| q.id == old.id)
                .ok_or("material_question_disappeared")?;
            if current.candidate_key != old.candidate_key
                || current.question != old.question
                || current.success_criteria != old.success_criteria
            {
                return Err("material_question_changed".into());
            }
            if current.resolved && !evidence.iter().any(|q| self.novel_evidence(q)) {
                return Err("question_resolution_requires_new_evidence".into());
            }
        }
        if !covering {
            for draft in &envelope.candidates {
                crate::domains::queue_lifecycle::finding_executor::validate_candidate_value(
                    &draft.candidate,
                )?;
                if draft.evidence.is_empty() || !draft.evidence.iter().any(|e| e.role == "supports")
                {
                    return Err("candidate_requires_primary_evidence".into());
                }
                for e in &draft.evidence {
                    let source = self
                        .sources
                        .iter()
                        .find(|s| s.hash == e.snapshot_hash)
                        .ok_or("unknown_snapshot")?;
                    if e.role == "supports" && source.kind != "primary" {
                        return Err("candidate_requires_primary_evidence".into());
                    }
                }
                if draft.unresolved_questions.iter().any(|id| {
                    !envelope
                        .questions
                        .iter()
                        .any(|q| q.id == *id && !q.resolved)
                }) {
                    return Err("unknown_candidate_question".into());
                }
            }
        }
        self.validate_action(&envelope.next, &envelope.questions)?;
        Ok(evidence)
    }
    fn validate_action(&self, action: &Action, questions: &[Question]) -> Result<(), String> {
        let q = |id: &str, gain: &str| -> Result<(), String> {
            if gain.trim().is_empty()
                || gain.len() > 2_000
                || !questions.iter().any(|q| q.id == id && !q.resolved)
            {
                return Err("action_requires_material_question".into());
            }
            Ok(())
        };
        match action {
            Action::ReadSource {
                snapshot_hash,
                from_byte,
                to_byte,
                question_id,
                expected_gain,
            } => {
                q(question_id, expected_gain)?;
                let source = self
                    .sources
                    .iter()
                    .find(|s| &s.hash == snapshot_hash)
                    .ok_or("unknown_snapshot")?;
                source.read(*from_byte, *to_byte)?;
                if to_byte - from_byte > 80_000 {
                    return Err("read_range_limit".into());
                }
            }
            Action::LookupKnowledge {
                query,
                question_id,
                expected_gain,
            } => {
                q(question_id, expected_gain)?;
                if query.trim().is_empty()
                    || query.len() > 1_000
                    || query.split_whitespace().count() > 8
                {
                    return Err("invalid_knowledge_query".into());
                }
            }
            Action::DelegateResearch {
                question_ids,
                expected_gain,
            } => {
                if question_ids.is_empty() || question_ids.len() > 3 {
                    return Err("research_question_limit".into());
                }
                for id in question_ids {
                    q(id, expected_gain)?;
                }
            }
            Action::Finish { reason } => {
                if reason.trim().is_empty() || reason.len() > 256 {
                    return Err("missing_finish_reason".into());
                }
            }
        }
        Ok(())
    }
    pub fn apply(&mut self, envelope: Envelope, evidence: Vec<Quote>) {
        self.candidates = envelope.candidates;
        self.assessment = envelope.assessment;
        self.questions = envelope.questions;
        for quote in evidence {
            if !self.evidence.contains(&quote) {
                self.evidence.push(quote);
            }
        }
        self.next = Some(envelope.next);
    }
    pub fn record_acquisition(
        &mut self,
        key: &str,
        information_added: bool,
        failed: bool,
    ) -> Option<&'static str> {
        if failed {
            self.progress.fetch_failures += 1;
        } else {
            self.progress.fetch_failures = 0;
            if information_added {
                self.progress.no_gain = 0;
            } else {
                self.progress.no_gain += 1;
            }
        }
        self.history
            .push(json!({"key":key,"gain":information_added,"failed":failed}));
        if self.progress.fetch_failures >= FETCH_FAILURE_LIMIT {
            Some("retrieval_failed")
        } else if self.progress.no_gain >= NO_GAIN_LIMIT {
            Some("no_gain")
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn evidence_must_be_from_read_original_ranges_and_duplicates_need_locator() {
        let source = Snapshot::new(
            "vibe://a".into(),
            "primary".into(),
            "同じ根拠。同じ根拠。末尾反証".into(),
        )
        .unwrap();
        let mut state = State::new(source.clone(), None);
        state
            .read_ranges
            .push((source.hash.clone(), 0, source.text.len()));
        let mut draft = EvidenceDraft {
            snapshot_hash: source.hash,
            text: "同じ根拠".into(),
            role: "supports".into(),
            from_byte: None,
        };
        assert!(state.locate(&draft).is_err());
        draft.from_byte = Some(0);
        state.locate(&draft).unwrap();
        state.read_ranges.clear();
        assert!(state.locate(&draft).is_err());
    }
    #[test]
    fn no_gain_and_actual_fetch_failures_survive_serialization() {
        let s = Snapshot::new("vibe://a".into(), "primary".into(), "原資料".into()).unwrap();
        let mut state = State::new(s, None);
        assert_eq!(state.record_acquisition("a", false, false), None);
        let mut restored: State =
            serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        assert_eq!(
            restored.record_acquisition("b", false, false),
            Some("no_gain")
        );
        restored.record_acquisition("c", true, false);
        assert_eq!(restored.progress.no_gain, 0);
        restored.record_acquisition("d", false, true);
        restored.record_acquisition("e", false, true);
        assert_eq!(
            restored.record_acquisition("f", false, true),
            Some("retrieval_failed")
        );
    }
}

#[cfg(test)]
mod carry_tests {
    use super::*;
    #[test]
    fn unresolved_question_cannot_disappear_or_resolve_without_new_evidence() {
        let source = Snapshot::new(
            "vibe://source".into(),
            "primary".into(),
            "重要な条件".into(),
        )
        .unwrap();
        let mut state = State::new(source, None);
        let question = Question {
            id: "q1".into(),
            candidate_key: "source".into(),
            question: "条件は何か".into(),
            success_criteria: "原資料の条件を確認".into(),
            resolved: false,
        };
        state.questions.push(question.clone());
        let mut envelope = Envelope {
            version: 1,
            candidates: vec![],
            assessment: None,
            questions: vec![],
            evidence: vec![],
            next: Action::Finish {
                reason: "enough".into(),
            },
        };
        assert_eq!(
            state.validate_envelope(&envelope, false).unwrap_err(),
            "material_question_disappeared"
        );
        let mut resolved = question;
        resolved.resolved = true;
        envelope.questions.push(resolved);
        assert_eq!(
            state.validate_envelope(&envelope, false).unwrap_err(),
            "question_resolution_requires_new_evidence"
        );
    }
}

#[cfg(test)]
mod novelty_tests {
    use super::*;
    #[test]
    fn relabelling_or_reslicing_the_same_quote_is_not_information_gain() {
        let source = Snapshot::new(
            "vibe://source".into(),
            "primary".into(),
            "条件と反証".into(),
        )
        .unwrap();
        let mut state = State::new(source.clone(), None);
        let quote = Quote {
            snapshot_hash: source.hash,
            from_byte: 0,
            to_byte: source.text.len(),
            text: source.text,
            role: "supports".into(),
        };
        state.evidence.push(quote.clone());
        let mut relabelled = quote;
        relabelled.role = "counterevidence".into();
        assert!(!state.novel_evidence(&relabelled));
        relabelled.to_byte = 6;
        relabelled.text = "条件".into();
        assert!(!state.novel_evidence(&relabelled));
    }
}
