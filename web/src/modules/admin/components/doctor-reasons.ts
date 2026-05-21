export type DoctorReasonSeverity = "critical" | "warning" | "info";
export type DoctorReasonArea = "Knowledge" | "Distillation" | "Sync" | "Runtime" | "MCP" | "Other";

export type DoctorReasonDetail = {
  code: string;
  label: string;
  severity: DoctorReasonSeverity;
  area: DoctorReasonArea;
  description: string;
  impact: string;
  action: string;
};

const reasonCatalog: Record<string, Omit<DoctorReasonDetail, "code">> = {
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
  VIBE_DISTILLATION_NEVER_RAN: {
    label: "会話ログ蒸留が未実行",
    severity: "warning",
    area: "Distillation",
    description: "Vibe Memory 由来の distillation が成功していません。",
    impact: "会話ログの知見が knowledge に反映されません。",
    action:
      "`bun run distill:pipeline -- --write --limit 1 --kind vibe` で処理経路が動くか確認してください。",
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
  SOURCE_DISTILLATION_PIPELINE_LOCK_STALE: {
    label: "Source 蒸留ロックが古い",
    severity: "critical",
    area: "Distillation",
    description: "Source distillation の pipeline lock が stale 判定されています。",
    impact: "wiki/source の更新が knowledge に反映されにくくなります。",
    action: "running job と lock 状態を確認し、queue が進むか監視してください。",
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
};

function titleCaseFromCode(code: string): string {
  return code
    .toLowerCase()
    .split("_")
    .map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

function inferArea(code: string): DoctorReasonArea {
  if (code.startsWith("KNOWLEDGE_")) return "Knowledge";
  if (code.startsWith("VIBE_DISTILLATION_") || code.startsWith("SOURCE_DISTILLATION_")) {
    return "Distillation";
  }
  if (
    code.includes("_SYNC_") ||
    code.startsWith("AGENT_LOG_") ||
    code.startsWith("ANTIGRAVITY_") ||
    code.startsWith("CODEX_SESSION_")
  ) {
    return "Sync";
  }
  if (code.startsWith("MCP_")) return "MCP";
  if (
    code.startsWith("DB_") ||
    code.startsWith("VECTOR_") ||
    code.startsWith("EMBEDDING_") ||
    code.startsWith("AGENTIC_LLM_") ||
    code.startsWith("RUN_HEALTH_") ||
    code.startsWith("CONTEXT_COMPILE_") ||
    code.startsWith("DEGRADED_RATE_") ||
    code.startsWith("USABLE_PACK_") ||
    code.startsWith("NO_COMPILE_RUN_")
  ) {
    return "Runtime";
  }
  return "Other";
}

function inferSeverity(code: string): DoctorReasonSeverity {
  if (
    code === "DB_UNREACHABLE" ||
    code === "MISSING_REQUIRED_TABLES" ||
    code === "REQUIRED_TABLES_CHECK_FAILED" ||
    code.endsWith("_PIPELINE_LOCK_STALE") ||
    code.endsWith("_QUEUE_STOPPED")
  ) {
    return "critical";
  }
  if (
    code.endsWith("_STALE") ||
    code.endsWith("_MISSING") ||
    code.endsWith("_HIGH") ||
    code.endsWith("_UNREACHABLE") ||
    code.endsWith("_NOT_CONFIGURED") ||
    code.endsWith("_NOT_LOADED") ||
    code.endsWith("_FAILED")
  ) {
    return "warning";
  }
  return "info";
}

export function formatDoctorReason(code: string): DoctorReasonDetail {
  const fromCatalog = reasonCatalog[code];
  if (fromCatalog) {
    return { code, ...fromCatalog };
  }
  return {
    code,
    label: titleCaseFromCode(code),
    severity: inferSeverity(code),
    area: inferArea(code),
    description: "Doctor が未定義の診断コードを返しました。",
    impact: "原因の重要度や対応順序を判断しにくくなります。",
    action: "raw code を検索し、doctor.service.ts の reason 生成箇所を確認してください。",
  };
}
