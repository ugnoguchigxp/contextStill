# Internal Design Documents

この directory には、internal implementation plans、design notes、engineering decision records を置く。

これらの文書では、unfinished work、implementation constraints、rejected alternatives、local operational details を扱ってよい。public user/operator documentation は `../pub/` に置く。

| Document | 目的 |
|---|---|
| [Daemon-Owned MCP Runtime Plan](daemon-owned-mcp-runtime-plan.md) | stdio MCP を legacy path として削除し、常駐 `context-stilld` が MCP endpoint、session、tool worker、cleanup を所有するための仕様変更計画 |
| [Cover Evidence External Evidence リファクタリング計画](cover-evidence-external-evidence-refactor-plan.md) | source-first gate、最大 5 URL x 3000 token の fetch excerpt、prompt injection guard により coverEvidence の外部 evidence path を縮小する実装計画 |
| [context_compile Negative Knowledge / EpisodeCard 改善 実装計画](context-compile-negative-episode-improvement-plan.md) | negative knowledge を agentic refine でも guardrail として扱い、EpisodeCard precedent の利用実態を diagnostics / detail で追えるようにする小規模改善計画 |
| [Decision Signal Integration 実装計画](decision-signal-integration-implementation-plan.md) | `context_decision` を 90 点以上の品質へ引き上げるため、compile、graph、community、landscape、attractor 指標を統合する実装計画 |
| [Desktop Readiness And Doctor States](desktop-readiness-and-doctor-states.md) | Tauri shell 実装前に固定する desktop data path、first-run state、doctor 表示、desktop readiness smoke の設計メモ |
| [EpisodeCard 品質改善 実装計画](episode-card-quality-improvement-implementation-plan.md) | `episodeDistiller` の保存マッピング、canonical schema、スコア校正、既存データ補正により EpisodeCard の読みやすさとフィールド責務を改善する実装計画 |
| Episode Distiller Queue 実装計画 (未配置) | `vibe memory` を共通ソースに、`findCandidate` の knowledge 候補抽出と `episodeDistiller` の複数 Episode 生成を分離する実装計画 |
| [Rust Daemon Replacement Readiness Implementation Plan](rust-daemon-replacement-readiness-plan.md) | Rust daemon を lifecycle host から boundary ごとに置き換え可能な runtime へ進めるための実装順序、検証ゲート、default switch 条件 |
| Shared LLM Provider Pool Queue Scheduling 実装計画 (未配置) | 複数 queue が少数の共有 LLM endpoint を非プリエンプティブ優先度つきで使うための Provider Pool、lease、scheduler リファクタリング計画 |
