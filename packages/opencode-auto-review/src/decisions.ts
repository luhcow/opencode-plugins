/**
 * `/v1/decisions` Guardian risk classifier contract and response parser
 * ported directly from OpenAI Codex (`codex-rs/ext/guardian-v2/src/async_scorer/decisions.rs`).
 */

export const DECISIONS_DEADLINE_MS = 6_000

export type GuardianRiskClassification = "low" | "high"

export interface GuardianRiskQuestion {
  readonly type: "choice"
  readonly name: "guardian_risk"
  readonly instructions: string
  readonly choices: ReadonlyArray<{ readonly value: GuardianRiskClassification }>
}

/**
 * Builds the single `guardian_risk` choice question sent to `/v1/decisions`
 * (`decisions.rs:277-282`).
 */
export function buildGuardianRiskQuestion(instructions: string): GuardianRiskQuestion {
  return {
    type: "choice",
    name: "guardian_risk",
    instructions,
    choices: [{ value: "low" }, { value: "high" }],
  }
}

export type ParsedDecisionsResult =
  | { readonly ok: true; readonly risk: GuardianRiskClassification }
  | { readonly ok: false; readonly error: string }

/**
 * Validates and extracts the `"low"` or `"high"` choice from `/v1/decisions`
 * answers (`parse_answer` in `decisions.rs:287-302`).
 */
export function parseDecisionsAnswer(answers: unknown): ParsedDecisionsResult {
  if (!Array.isArray(answers) || answers.length !== 1) {
    return { ok: false, error: "Decisions returned an invalid classification" }
  }
  const answer = answers[0]
  if (!isRecord(answer) || answer.type !== "choice" || answer.name !== "guardian_risk") {
    return { ok: false, error: "Decisions returned an invalid classification" }
  }
  if (answer.choice === "low" || answer.choice === "high") {
    return { ok: true, risk: answer.choice }
  }
  return { ok: false, error: "Decisions returned an invalid classification" }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
