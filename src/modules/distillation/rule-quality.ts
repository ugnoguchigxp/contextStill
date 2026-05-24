export const RULE_BODY_NOT_ACTIONABLE_REASON = "rule_body_not_actionable";
export const RULE_UNSUPPORTED_BY_SOURCE_REASON = "rule_unsupported_by_source";

export type RuleQualityDecision =
  | {
      action: "accept_rule";
      reason: "rule_like_body" | "explicit_rule_type";
    }
  | {
      action: "reject_rule";
      reason: typeof RULE_BODY_NOT_ACTIONABLE_REASON | typeof RULE_UNSUPPORTED_BY_SOURCE_REASON;
    };

function normalizedText(title: string, body: string): string {
  return `${title}\n${body}`.replace(/\s+/g, " ").trim();
}

function hasRuleConstraintSignal(text: string): boolean {
  return /(\bmust\b|\bshould\b|\bprefer\b|\bavoid\b|\bnever\b|\brequired\b|\bensure\b|\bdo not\b|必ず|べき|優先|避ける|しない|禁止|例外|境界|条件|確認|検証|保持|限定|分ける|混ぜない|使う|残す|守る)/i.test(
    text,
  );
}

function hasActionableImperativeSignal(text: string): boolean {
  return /(\buse\b|\bkeep\b|\bpreserve\b|\bcheck\b|\bverify\b|\bconfirm\b|\binspect\b|\brun\b|\bcall\b|\broute\b|\bstore\b|\brecord\b|\breturn\b|\breject\b|\bdemote\b|\bretry\b|\breprocess\b|使う|確認する|検証する|保持する|保存する|記録する|分ける|戻す|避ける|止める|登録する|再評価する)/i.test(
    text,
  );
}

function hasPersistentRuleImperativeSignal(text: string): boolean {
  return /(\buse\b|\bkeep\b|\bpreserve\b|\bcheck\b|\bverify\b|\bconfirm\b|\bcall\b|\broute\b|\bstore\b|\brecord\b|\breturn\b|\breject\b|\bdemote\b|\bretry\b|\breprocess\b|使う|確認する|検証する|保持する|保存する|記録する|分ける|戻す|避ける|止める|登録する|再評価する)/i.test(
    text,
  );
}

function isVague(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 24) return true;
  return /(良さそう|重要そう|気をつける|確認すること|some info|rule body|todo|tbd)/i.test(text);
}

export function hasRuleLikeBody(params: {
  title: string;
  body: string;
  explicitRule?: boolean;
}): boolean {
  const text = normalizedText(params.title, params.body);
  if (isVague(text)) return false;
  if (hasRuleConstraintSignal(text)) return true;
  if (hasPersistentRuleImperativeSignal(text)) return true;
  return Boolean(params.explicitRule && hasActionableImperativeSignal(text));
}

export function assessRuleQuality(params: {
  title: string;
  body: string;
  explicitRule?: boolean;
  sourceSupported?: boolean;
}): RuleQualityDecision {
  if (params.sourceSupported === false) {
    return {
      action: "reject_rule",
      reason: RULE_UNSUPPORTED_BY_SOURCE_REASON,
    };
  }
  if (!hasRuleLikeBody(params)) {
    return {
      action: "reject_rule",
      reason: RULE_BODY_NOT_ACTIONABLE_REASON,
    };
  }
  return {
    action: "accept_rule",
    reason: params.explicitRule ? "explicit_rule_type" : "rule_like_body",
  };
}
