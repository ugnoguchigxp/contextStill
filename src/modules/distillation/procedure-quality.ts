export const PROCEDURE_BODY_NOT_ACTIONABLE_REASON = "procedure_body_not_actionable";

function sectionIndex(body: string, heading: string): number {
  return body.search(new RegExp(`^${heading}:`, "im"));
}

function workflowSection(body: string): string {
  const workflowStart = sectionIndex(body, "Workflow");
  const verificationStart = sectionIndex(body, "Verification");
  if (workflowStart < 0 || verificationStart <= workflowStart) return "";
  return body.slice(workflowStart, verificationStart);
}

function countWorkflowSteps(body: string): number {
  return workflowSection(body)
    .split("\n")
    .filter((line) => /^\s*(?:\d+[.)]|-)\s+\S/.test(line)).length;
}

export function hasSkillLikeProcedureBody(body: string): boolean {
  const useWhen = sectionIndex(body, "Use when");
  const workflow = sectionIndex(body, "Workflow");
  const verification = sectionIndex(body, "Verification");
  const avoid = sectionIndex(body, "Avoid");
  return (
    useWhen >= 0 &&
    workflow > useWhen &&
    verification > workflow &&
    avoid > verification &&
    countWorkflowSteps(body) >= 2
  );
}

export function hasProcedureWorkflowSignal(title: string, body: string): boolean {
  const text = `${title}\n${body}`.toLowerCase();
  const hasSequenceMarker =
    /(\bstep\b|\bsteps\b|\bthen\b|\bafter\b|\bfirst\b|\bfinally\b|まず|次に|その後|最後に|してから|順に|順序|1[.)]|2[.)])/i.test(
      text,
    );
  const hasWorkflowMarker =
    /(\bworkflow\b|\brunbook\b|\bplaybook\b|\bprocedure\b|手順|運用|復旧|再実行|レビュー手順|検証手順|確認手順|ワークフロー)/i.test(
      text,
    );
  const hasCommandMarker =
    /(`[^`]+`|\b(?:bun|bunx|pnpm|npm|yarn|git|docker|terraform|kubectl|psql|curl|aws)\b|\bcli\b|コマンド)/i.test(
      text,
    );
  const hasVerificationMarker =
    /(\bverify\b|\bsmoke\b|\bdoctor\b|\btest\b|\blint\b|\btypecheck\b|\bformat\b|\bbuild\b|\bmigrate\b|\bdeploy\b|検証|確認|起動|実行)/i.test(
      text,
    );

  return (
    hasSkillLikeProcedureBody(body) ||
    (hasWorkflowMarker && (hasSequenceMarker || hasCommandMarker || hasVerificationMarker)) ||
    (hasSequenceMarker && hasCommandMarker) ||
    (hasSequenceMarker && hasVerificationMarker)
  );
}

export function shouldDemoteProcedureToRule(params: { title: string; body: string }): boolean {
  return (
    !hasSkillLikeProcedureBody(params.body) &&
    !hasProcedureWorkflowSignal(params.title, params.body)
  );
}
