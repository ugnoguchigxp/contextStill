use super::transport::Usage;
use serde::{Deserialize, Serialize};

pub(crate) const MAX_CALLS: u64 = 8;
pub(crate) const EXPLORATION_CALLS: u64 = 6;
pub(crate) const RESEARCH_TARGET: u64 = 262_144;
pub(crate) const RESEARCH_HARD: u64 = 393_216;
pub(crate) const SOFT_WINDOW: u64 = 32_768;
pub(crate) const HARD_WINDOW: u64 = 36_864;
pub(crate) const FINAL_RESERVE: u64 = 32_768;
pub(crate) const AGENT_OUTPUT_TOKENS: u64 = 8_192;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Window {
    pub max_tokens: u64,
    pub output_reserve_tokens: u64,
    pub safety_margin_tokens: u64,
}

impl Window {
    pub fn admit(&self, input: u64, output: u64) -> Result<u64, String> {
        let total = input
            .checked_add(output.max(self.output_reserve_tokens))
            .and_then(|v| v.checked_add(self.safety_margin_tokens.max(1_024)))
            .ok_or("context_limit")?;
        if output == 0 || total > self.max_tokens.min(HARD_WINDOW) {
            return Err("context_limit".into());
        }
        Ok(total)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Budget {
    pub used: u64,
    pub reserved: u64,
    pub target: u64,
    pub hard: u64,
    pub calls: u64,
    pub research: bool,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            used: 0,
            reserved: 0,
            target: 98_304,
            hard: 131_072,
            calls: 0,
            research: false,
        }
    }
}

impl Budget {
    pub fn reserve(&mut self, upper_bound: u64, finalizing: bool) -> Result<(), String> {
        let hold = if finalizing { 0 } else { FINAL_RESERVE };
        if self.calls >= MAX_CALLS
            || (!finalizing && self.used.saturating_add(self.reserved) >= self.target)
            || self
                .used
                .checked_add(self.reserved)
                .and_then(|v| v.checked_add(upper_bound))
                .and_then(|v| v.checked_add(hold))
                .is_none_or(|v| v > self.hard)
        {
            return Err("budget_exhausted".into());
        }
        self.reserved += upper_bound;
        self.calls += 1;
        Ok(())
    }
    pub fn settle(&mut self, upper_bound: u64, usage: Option<&Usage>) -> Result<(), String> {
        let Some(usage) = usage else {
            return Ok(());
        };
        let actual = usage
            .input
            .checked_add(usage.output)
            .ok_or("usage_overflow")?;
        if upper_bound > self.reserved {
            return Err("reservation_missing".into());
        }
        let used = self.used.checked_add(actual).ok_or("usage_overflow")?;
        self.reserved -= upper_bound;
        self.used = used;
        if self.used.saturating_add(self.reserved) > self.hard {
            return Err("provider_budget_violation".into());
        }
        Ok(())
    }
    pub fn research_remaining(&mut self) -> Result<u64, String> {
        self.research = true;
        self.target = RESEARCH_TARGET;
        self.hard = RESEARCH_HARD;
        self.hard
            .checked_sub(
                self.used
                    .saturating_add(self.reserved)
                    .saturating_add(FINAL_RESERVE),
            )
            .filter(|v| *v > 0)
            .ok_or_else(|| "budget_exhausted".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_window_includes_output_and_template_margin() {
        let w = Window {
            max_tokens: 36_864,
            output_reserve_tokens: 4_096,
            safety_margin_tokens: 1_024,
        };
        assert_eq!(w.admit(31_744, 4_096), Ok(36_864));
        assert!(w.admit(31_745, 4_096).is_err());
        let w = Window {
            max_tokens: 32_768,
            ..w
        };
        assert!(w.admit(28_000, 1_536).is_err());
        assert!(w.admit(u64::MAX, 4_096).is_err());
    }
    #[test]
    fn missing_usage_keeps_reservation_and_restart_does_not_reset_budget() {
        let mut b = Budget::default();
        b.reserve(30_000, false).unwrap();
        b.settle(30_000, None).unwrap();
        let raw = serde_json::to_string(&b).unwrap();
        let mut restored: Budget = serde_json::from_str(&raw).unwrap();
        assert_eq!(restored.reserved, 30_000);
        restored.reserve(30_000, false).unwrap();
        restored.reserve(30_000, false).unwrap();
        assert!(restored.reserve(30_000, false).is_err());
        restored
            .settle(
                30_000,
                Some(&Usage {
                    input: 10_000,
                    output: 1_000,
                    cached_input: 8_000,
                }),
            )
            .unwrap();
        assert_eq!(restored.used, 11_000);
        assert_eq!(restored.reserved, 60_000);
        assert_eq!(restored.research_remaining().unwrap(), 289_448);
    }
}
