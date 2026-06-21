# Internal Design Documents

この directory には、internal implementation plans、design notes、engineering decision records を置く。

これらの文書では、unfinished work、implementation constraints、rejected alternatives、local operational details を扱ってよい。public user/operator documentation は `../pub/` に置く。

| Document | 目的 |
|---|---|
| [Decision Evidence Optimization 実装計画](decision-evidence-optimization-implementation-plan.md) | `context_decision` の Primary Evidence、EpisodeCard precedent、evidence relevance、confidence calibration、agent message を優先順付きで改善する実装計画 |
| [Decision Signal Integration 実装計画](decision-signal-integration-implementation-plan.md) | `context_decision` を 90 点以上の品質へ引き上げるため、compile、graph、community、landscape、attractor 指標を統合する実装計画 |
| [Desktop Readiness And Doctor States](desktop-readiness-and-doctor-states.md) | Tauri shell 実装前に固定する desktop data path、first-run state、doctor 表示、desktop readiness smoke の設計メモ |
| [Rust Daemon Replacement Readiness Implementation Plan](rust-daemon-replacement-readiness-plan.md) | Rust daemon を lifecycle host から boundary ごとに置き換え可能な runtime へ進めるための実装順序、検証ゲート、default switch 条件 |
