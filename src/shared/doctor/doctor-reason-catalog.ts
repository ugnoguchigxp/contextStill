export type DoctorReasonSeverity = "critical" | "warning" | "info";
export type DoctorReasonArea = "Knowledge" | "Distillation" | "Sync" | "Runtime" | "MCP" | "Other";
export type DoctorReasonImpactLevel = "blocking" | "degraded" | "maintenance" | "skipped";
export type DoctorReasonEnvironmentScope =
  | "all"
  | "configured_only"
  | "non_empty_db"
  | "strict_only";

export type DoctorReasonCommands = {
  inspect: string | null;
  repairDryRun: string | null;
  repairApply: string | null;
};

export type DoctorReasonDetail = {
  code: string;
  label: string;
  severity: DoctorReasonSeverity;
  area: DoctorReasonArea;
  description: string;
  impact: string;
  action: string;
  impactLevel?: DoctorReasonImpactLevel;
  environmentScope?: DoctorReasonEnvironmentScope;
  commands?: DoctorReasonCommands;
  evidence?: Record<string, unknown> | null;
};

export type DoctorReasonCatalogEntry = Omit<DoctorReasonDetail, "code">;

export const doctorReasonCatalog: Record<string, DoctorReasonCatalogEntry> = {
  DB_UNREACHABLE: {
    label: "データベースに接続できない",
    severity: "critical",
    area: "Runtime",
    description: "Doctor 実行時に DB 接続が失敗しています。",
    impact: "主要診断の多くが実行できず、状態判定の信頼性が失われます。",
    action: "DATABASE_URL と DB プロセス状態を確認し、疎通を回復してください。",
  },
  MISSING_REQUIRED_TABLES: {
    label: "必須テーブルが不足",
    severity: "critical",
    area: "Runtime",
    description: "Doctor が要求するテーブルが DB に存在しません。",
    impact: "診断と通常機能の両方で欠落データが発生します。",
    action: "migration 状態を確認し、必要なテーブルを作成してください。",
  },
  REQUIRED_TABLES_CHECK_FAILED: {
    label: "必須テーブル確認に失敗",
    severity: "critical",
    area: "Runtime",
    description: "情報スキーマ参照またはテーブル検証処理に失敗しました。",
    impact: "テーブル不足の検知ができず、診断結果が不完全になります。",
    action: "DB 権限と information_schema 参照可否を確認してください。",
  },
  VECTOR_EXTENSION_MISSING: {
    label: "pgvector が未導入",
    severity: "warning",
    area: "Runtime",
    description: "vector extension が有効化されていません。",
    impact: "埋め込み検索品質と速度が低下します。",
    action: "DB に vector extension を導入してください。",
  },
  VECTOR_EXTENSION_CHECK_FAILED: {
    label: "pgvector 状態確認に失敗",
    severity: "warning",
    area: "Runtime",
    description: "extension 状態確認クエリが失敗しました。",
    impact: "vector 機能の可用性を正確に判断できません。",
    action: "DB 権限と接続状態を確認してください。",
  },
  EMBEDDING_PROVIDER_UNAVAILABLE: {
    label: "Embedding provider が利用不能",
    severity: "warning",
    area: "Runtime",
    description: "daemon と CLI の両方が到達不能/利用不能です。",
    impact: "埋め込み生成が停止し、検索品質が大きく低下します。",
    action: "daemon 起動状態と CLI 実行環境を確認してください。",
  },
  AGENTIC_LLM_NOT_CONFIGURED: {
    label: "Agentic LLM が未設定",
    severity: "warning",
    area: "Runtime",
    description: "agenticCompile が有効なのに LLM 設定が不足しています。",
    impact: "agentic compile 経路が利用できません。",
    action: "provider 設定と資格情報を見直してください。",
  },
  AGENTIC_LLM_UNREACHABLE: {
    label: "Agentic LLM に到達できない",
    severity: "warning",
    area: "Runtime",
    description: "Agentic LLM の疎通確認が失敗しています。",
    impact: "compile 品質や自動処理が劣化します。",
    action: "endpoint、モデル名、認証情報、ネットワーク到達性を確認してください。",
  },
  MCP_PRIMARY_TOOLS_MISSING: {
    label: "MCP primary tool が不足",
    severity: "warning",
    area: "MCP",
    description: "必須 MCP tool が公開 surface から欠落しています。",
    impact: "外部呼び出しが失敗し、主要ワークフローが破綻します。",
    action: "tool 登録と起動設定を確認してください。",
  },
  NO_COMPILE_RUN_HISTORY: {
    label: "Compile 実行履歴がない",
    severity: "info",
    area: "Runtime",
    description: "compile run の記録がまだ存在しません。",
    impact: "品質劣化の早期検知ができません。",
    action: "compile を実行して baseline を作成してください。",
  },
  CONTEXT_COMPILE_STALE: {
    label: "Compile 実行が古い",
    severity: "warning",
    area: "Runtime",
    description: "最新 compile run が freshness threshold を超過しています。",
    impact: "現状を反映しない診断が表示される可能性があります。",
    action: "compile を再実行して状態を更新してください。",
  },
  DEGRADED_RATE_HIGH: {
    label: "Degraded rate が高い",
    severity: "warning",
    area: "Runtime",
    description: "直近 run における degraded/failed 比率が閾値を超えています。",
    impact: "利用体験の不安定化と誤回答リスクが上がります。",
    action: "degraded reasons を上位から解消してください。",
  },
  USABLE_PACK_RATE_LOW: {
    label: "Usable pack rate が低い",
    severity: "warning",
    area: "Runtime",
    description: "直近 run で usable 判定の割合が低下しています。",
    impact: "実用可能な context pack が得られにくくなります。",
    action: "blocking/warning reasons の分布を確認し優先修正してください。",
  },
  RUN_HEALTH_QUERY_FAILED: {
    label: "Run health 取得失敗",
    severity: "warning",
    area: "Runtime",
    description: "compile run health クエリに失敗しました。",
    impact: "実行品質の傾向分析ができません。",
    action: "context_compile_runs テーブルとクエリ経路を確認してください。",
  },
  RUN_HEALTH_SKIPPED_TABLE_MISSING: {
    label: "Run health 検証をスキップ",
    severity: "warning",
    area: "Runtime",
    description: "必要テーブル欠損により run health 検証を実行できませんでした。",
    impact: "compile 品質指標が欠落します。",
    action: "必要テーブル作成後に再実行してください。",
  },
  STALE_KNOWLEDGE_COUNT_QUERY_FAILED: {
    label: "stale knowledge 集計失敗",
    severity: "warning",
    area: "Knowledge",
    description: "deprecated knowledge の集計に失敗しました。",
    impact: "整理対象の見積もり精度が下がります。",
    action: "knowledge_items クエリ経路を確認してください。",
  },
  STALE_SOURCE_COUNT_QUERY_FAILED: {
    label: "stale source 集計失敗",
    severity: "warning",
    area: "Knowledge",
    description: "stale source 数の集計に失敗しました。",
    impact: "source 側のメンテ対象を正確に把握できません。",
    action: "sources テーブルの状態とクエリを確認してください。",
  },
  KNOWLEDGE_VALUE_QUERY_FAILED: {
    label: "Knowledge value 集計失敗",
    severity: "warning",
    area: "Knowledge",
    description: "knowledge lifecycle/value 集計クエリに失敗しました。",
    impact: "活用状況や劣化傾向を把握できません。",
    action: "knowledge_items クエリと関連カラムを確認してください。",
  },
  KNOWLEDGE_VALUE_UPDATE_FAILED: {
    label: "Knowledge value 更新失敗",
    severity: "warning",
    area: "Knowledge",
    description: "直近で KNOWLEDGE_VALUE_UPDATE_FAILED 監査ログが記録されています。",
    impact: "dynamic score が更新されず評価が古くなる可能性があります。",
    action: "監査ログ詳細を確認し、更新失敗の根本原因を修正してください。",
  },
  HITL_BACKLOG_QUERY_FAILED: {
    label: "HITL backlog 集計失敗",
    severity: "warning",
    area: "Knowledge",
    description: "draft backlog の集計クエリに失敗しました。",
    impact: "レビュー遅延の可視化ができません。",
    action: "knowledge_items 集計クエリと接続状態を確認してください。",
  },
  HITL_DRAFT_BACKLOG_HIGH: {
    label: "HITL draft backlog が多い",
    severity: "warning",
    area: "Knowledge",
    description: "draft 件数がしきい値を超えています。",
    impact: "レビュー待ちが滞留し、品質改善サイクルが遅延します。",
    action: "Knowledge UI で draft を優先レビューしてください。",
  },
  HITL_DRAFT_REVIEW_STALE: {
    label: "HITL draft レビューが古い",
    severity: "warning",
    area: "Knowledge",
    description: "最古の draft が長期間放置されています。",
    impact: "古い未確定知識が蓄積し、運用負荷が増えます。",
    action: "最古 draft から順にレビューしてください。",
  },
  KNOWLEDGE_ZERO_USE_HIGH: {
    label: "未使用の active knowledge が多い",
    severity: "warning",
    area: "Knowledge",
    description:
      "active knowledge の多くが compile で選択されていません。スコープやタグが広すぎる可能性があります。",
    impact: "コンテキスト品質が下がり、必要な知識が選ばれにくくなります。",
    action:
      "Knowledge 画面で未使用 active を確認し、不要な項目を deprecated にするか、appliesTo を見直してください。",
  },
  KNOWLEDGE_DECAY_STALE_HIGH: {
    label: "Decay 低下 knowledge が多い",
    severity: "warning",
    area: "Knowledge",
    description: "decay factor がしきい値未満の active knowledge が多数あります。",
    impact: "鮮度の低い知識が検索結果へ混入しやすくなります。",
    action: "対象 knowledge を再検証し、更新または整理してください。",
  },
  CODEX_SESSION_DIR_MISSING: {
    label: "Codex session dir が見つからない",
    severity: "warning",
    area: "Sync",
    description: "設定された Codex session directory が存在しません。",
    impact: "会話ログ同期が実行できません。",
    action: "MEMORY_ROUTER_CODEX_SESSION_DIR のパスを確認してください。",
  },
  ANTIGRAVITY_LOG_DIR_NOT_CONFIGURED: {
    label: "Antigravity log dir が未設定",
    severity: "warning",
    area: "Sync",
    description: "Antigravity log directory 設定が空です。",
    impact: "Antigravity 側ログが同期対象になりません。",
    action: "MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR を設定してください。",
  },
  ANTIGRAVITY_LOG_DIR_MISSING: {
    label: "Antigravity log dir が存在しない",
    severity: "warning",
    area: "Sync",
    description: "設定された Antigravity log directory が存在しません。",
    impact: "Antigravity 側ログ同期が失敗します。",
    action: "設定値とファイルシステム上の実パスを確認してください。",
  },
  AGENT_LOG_SYNC_NEVER_RAN: {
    label: "Agent log sync が未初期化",
    severity: "warning",
    area: "Sync",
    description: "sync_states に codex_logs が存在せず、同期履歴がありません。",
    impact: "vibe memory への取り込みが開始されません。",
    action: "`bun run sync:agent-logs` を実行してください。",
  },
  AGENT_LOG_SYNC_LAUNCH_AGENT_NOT_INSTALLED: {
    label: "Agent log sync launch agent 未配置",
    severity: "warning",
    area: "Sync",
    description: "agent-log-sync の LaunchAgent がインストールされていません。",
    impact: "定期同期が自動実行されません。",
    action: "`bun run automation:agent-log-sync -- install` を実行してください。",
  },
  AGENT_LOG_SYNC_LAUNCH_AGENT_NOT_LOADED: {
    label: "Agent log sync launch agent 未ロード",
    severity: "warning",
    area: "Sync",
    description: "agent-log-sync の LaunchAgent がロードされていません。",
    impact: "定期同期が停止します。",
    action: "`bun run automation:agent-log-sync -- load` を実行してください。",
  },
  CODEX_LOGS_SYNC_STALE: {
    label: "Codex ログ同期が古い",
    severity: "warning",
    area: "Sync",
    description: "codex_logs の最終同期時刻が freshness threshold を超過しています。",
    impact: "最新の会話ログが取り込まれません。",
    action: "launch agent と sync 状態を確認し、必要なら手動同期してください。",
  },
  CODEX_LOGS_SYNC_WARNINGS: {
    label: "Codex ログ同期に警告あり",
    severity: "warning",
    area: "Sync",
    description: "codex_logs 同期で warning が記録されています。",
    impact: "一部ログの取り込み欠落が発生する可能性があります。",
    action: "sync state の warnings とログファイルを確認してください。",
  },
  ANTIGRAVITY_LOGS_SYNC_STALE: {
    label: "Antigravity ログ同期が古い",
    severity: "warning",
    area: "Sync",
    description: "Antigravity log の最終同期から時間が経過しています。",
    impact: "Antigravity 側作業の Vibe Memory 取り込みが遅れます。",
    action:
      "Agent Log Sync の launch agent と sync states を確認し、必要なら手動同期を実行してください。",
  },
  ANTIGRAVITY_LOGS_SYNC_WARNINGS: {
    label: "Antigravity ログ同期に警告あり",
    severity: "warning",
    area: "Sync",
    description: "antigravity_logs 同期で warning が記録されています。",
    impact: "一部セッションの取り込みに欠落が生じる可能性があります。",
    action: "sync state の warnings と同期ログを確認してください。",
  },
  VIBE_DISTILLATION_LAUNCH_AGENT_NOT_INSTALLED: {
    label: "Vibe distillation launch agent 未配置",
    severity: "warning",
    area: "Distillation",
    description: "distillation pipeline の LaunchAgent が配置されていません。",
    impact: "vibe distillation が自動実行されません。",
    action: "`bun run automation:distill-pipeline -- install` を実行してください。",
  },
  VIBE_DISTILLATION_LAUNCH_AGENT_NOT_LOADED: {
    label: "Vibe distillation launch agent 未ロード",
    severity: "warning",
    area: "Distillation",
    description: "distillation pipeline の LaunchAgent が未ロードです。",
    impact: "vibe distillation queue が処理されません。",
    action: "`bun run automation:distill-pipeline -- load` を実行してください。",
  },
  VIBE_DISTILLATION_NEVER_RAN: {
    label: "会話ログ蒸留が未実行",
    severity: "warning",
    area: "Distillation",
    description: "Vibe Memory 由来の distillation が成功していません。",
    impact: "会話ログの知見が knowledge に反映されません。",
    action:
      "`bun run distill:pipeline -- --write --limit 1 --kind vibe` で処理経路が動くか確認してください。",
  },
  VIBE_DISTILLATION_STALE: {
    label: "Vibe distillation 成功実行が古い",
    severity: "warning",
    area: "Distillation",
    description: "Vibe distillation の最新成功 run が freshness threshold を超過しています。",
    impact: "新規会話ログが知識化されにくくなります。",
    action: "run 履歴とキューを確認し、再実行してください。",
  },
  VIBE_DISTILLATION_QUEUE_STALE_RUNNING: {
    label: "Vibe distillation に stale running job",
    severity: "critical",
    area: "Distillation",
    description: "heartbeat が古い running job が残存しています。",
    impact: "queue が停滞し、新規処理が進みません。",
    action: "stale job を release/requeue して worker 状態を確認してください。",
  },
  VIBE_DISTILLATION_PIPELINE_LOCK_STALE: {
    label: "会話ログ蒸留ロックが古い",
    severity: "critical",
    area: "Distillation",
    description: "Vibe distillation の pipeline lock が stale 判定されています。",
    impact: "queue が停滞し、蒸留処理が進まない可能性があります。",
    action:
      "worker log と lock file を確認し、次回実行で解除されない場合は stale lock の原因を調査してください。",
  },
  VIBE_DISTILLATION_QUEUE_STOPPED: {
    label: "Vibe distillation queue が停止",
    severity: "critical",
    area: "Distillation",
    description: "処理可能な queued job があるのに worker が処理していません。",
    impact: "vibe 側知識化が継続的に遅延します。",
    action: "LaunchAgent、lock、worker log を確認し処理再開してください。",
  },
  SOURCE_DISTILLATION_LAUNCH_AGENT_NOT_INSTALLED: {
    label: "Source distillation launch agent 未配置",
    severity: "warning",
    area: "Distillation",
    description: "distillation pipeline の LaunchAgent が配置されていません。",
    impact: "source distillation が自動実行されません。",
    action: "`bun run automation:distill-pipeline -- install` を実行してください。",
  },
  SOURCE_DISTILLATION_LAUNCH_AGENT_NOT_LOADED: {
    label: "Source distillation launch agent 未ロード",
    severity: "warning",
    area: "Distillation",
    description: "distillation pipeline の LaunchAgent が未ロードです。",
    impact: "source distillation queue が処理されません。",
    action: "`bun run automation:distill-pipeline -- load` を実行してください。",
  },
  SOURCE_DISTILLATION_NEVER_RAN: {
    label: "Source distillation が未実行",
    severity: "warning",
    area: "Distillation",
    description: "wiki/source 由来の distillation が成功していません。",
    impact: "source から knowledge への更新が進みません。",
    action:
      "`bun run distill:pipeline -- --write --limit 1 --kind wiki` で処理経路を確認してください。",
  },

  SOURCE_DISTILLATION_QUEUE_STALE_RUNNING: {
    label: "Source distillation に stale running job",
    severity: "critical",
    area: "Distillation",
    description: "heartbeat が古い running job が残存しています。",
    impact: "source queue が停滞します。",
    action: "stale job を release/requeue して worker 状態を確認してください。",
  },
  SOURCE_DISTILLATION_PIPELINE_LOCK_STALE: {
    label: "Source 蒸留ロックが古い",
    severity: "critical",
    area: "Distillation",
    description: "Source distillation の pipeline lock が stale 判定されています。",
    impact: "wiki/source の更新が knowledge に反映されにくくなります。",
    action: "running job と lock 状態を確認し、queue が進むか監視してください。",
  },
  SOURCE_DISTILLATION_QUEUE_STOPPED: {
    label: "Source distillation queue が停止",
    severity: "critical",
    area: "Distillation",
    description: "処理可能な queued job があるのに worker が処理していません。",
    impact: "source 側知識化が滞留します。",
    action: "LaunchAgent、lock、worker log を確認し処理再開してください。",
  },
};
