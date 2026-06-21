# Internal Design Documents

この directory には、internal implementation plans、design notes、engineering decision records を置く。

これらの文書では、unfinished work、implementation constraints、rejected alternatives、local operational details を扱ってよい。public user/operator documentation は `../pub/` に置く。

| Document | 目的 |
|---|---|
| [Decision Signal Integration 実装計画](decision-signal-integration-implementation-plan.md) | `context_decision` を 90 点以上の品質へ引き上げるため、compile、graph、community、landscape、attractor 指標を統合する実装計画 |
| [Desktop Readiness And Doctor States](desktop-readiness-and-doctor-states.md) | Tauri shell 実装前に固定する desktop data path、first-run state、doctor 表示、desktop readiness smoke の設計メモ |
| [Negative Knowledge Registration 実装計画](negative-knowledge-registration-implementation-plan.md) | `register_review_corrections` を削除し、`register_candidate(s)` の `polarity: "negative"` と必須 applicability で negative knowledge を登録する実装計画 |
| [Rust Daemon Replacement Readiness Implementation Plan](rust-daemon-replacement-readiness-plan.md) | Rust daemon を lifecycle host から boundary ごとに置き換え可能な runtime へ進めるための実装順序、検証ゲート、default switch 条件 |
