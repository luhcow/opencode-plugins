/**
 * Synchronous Guardian reviewer output schema and tolerant JSON parser
 * ported directly from OpenAI Codex (`codex-rs/ext/guardian-reviewer/src/assessment.rs`).
 */

export type GuardianRiskLevel = "low" | "medium" | "high" | "critical"
export type GuardianUserAuthorization = "unknown" | "low" | "medium" | "high"
export type GuardianAssessmentOutcome = "allow" | "deny"

export interface GuardianAssessment {
  readonly risk_level: GuardianRiskLevel
  readonly user_authorization: GuardianUserAuthorization
  readonly outcome: GuardianAssessmentOutcome
  readonly rationale: string
}

const VALID_RISK_LEVELS = new Set<GuardianRiskLevel>(["low", "medium", "high", "critical"])
const VALID_AUTHORIZATIONS = new Set<GuardianUserAuthorization>(["unknown", "low", "medium", "high"])
const VALID_OUTCOMES = new Set<GuardianAssessmentOutcome>(["allow", "deny"])

export type ParsedAssessmentResult =
  | { readonly ok: true; readonly assessment: GuardianAssessment }
  | { readonly ok: false; readonly error: string }

/**
 * Tolerant JSON parser for Guardian synchronous assessment (`parse_guardian_assessment`
 * in `codex-rs/ext/guardian-reviewer/src/assessment.rs:24-62`).
 *
 * Accepts strict JSON or extracts the outermost `{ ... }` object if wrapped in prose.
 * Only `outcome` (`"allow" | "deny"`) is required; `risk_level`, `user_authorization`,
 * and `rationale` are optional with Codex's standard defaults.
 */
export function parseGuardianAssessment(text: string): ParsedAssessmentResult {
  const payload = parseJsonPayload(text)
  if (!isRecord(payload)) {
    return { ok: false, error: "guardian assessment was not valid JSON" }
  }

  const outcome = payload.outcome
  if (typeof outcome !== "string" || !VALID_OUTCOMES.has(outcome as GuardianAssessmentOutcome)) {
    return { ok: false, error: "guardian assessment missing valid outcome" }
  }
  const typedOutcome = outcome as GuardianAssessmentOutcome

  let riskLevel: GuardianRiskLevel
  if (payload.risk_level === undefined || payload.risk_level === null) {
    riskLevel = typedOutcome === "allow" ? "low" : "high"
  } else if (
    typeof payload.risk_level === "string" &&
    VALID_RISK_LEVELS.has(payload.risk_level as GuardianRiskLevel)
  ) {
    riskLevel = payload.risk_level as GuardianRiskLevel
  } else {
    return { ok: false, error: "guardian assessment has invalid risk_level" }
  }

  let userAuthorization: GuardianUserAuthorization
  if (payload.user_authorization === undefined || payload.user_authorization === null) {
    userAuthorization = "unknown"
  } else if (
    typeof payload.user_authorization === "string" &&
    VALID_AUTHORIZATIONS.has(payload.user_authorization as GuardianUserAuthorization)
  ) {
    userAuthorization = payload.user_authorization as GuardianUserAuthorization
  } else {
    return { ok: false, error: "guardian assessment has invalid user_authorization" }
  }

  const rawRationale = typeof payload.rationale === "string" ? payload.rationale.trim() : ""
  const rationale =
    rawRationale ||
    (typedOutcome === "allow"
      ? "Auto-review returned a low-risk allow decision."
      : "Auto-review returned a deny decision without a rationale.")

  return {
    ok: true,
    assessment: {
      risk_level: riskLevel,
      user_authorization: userAuthorization,
      outcome: typedOutcome,
      rationale,
    },
  }
}

function parseJsonPayload(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start >= 0 && start < end) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
