import assert from "node:assert/strict"
import test from "node:test"
import { parseGuardianAssessment } from "../src/assessment.js"
import { buildGuardianRiskQuestion, parseDecisionsAnswer } from "../src/decisions.js"
import { findHumanReviewReason, isEligibleAction, parseModelRef, parseOptions } from "../src/options.js"
import { renderClassifierInstructions, renderGuardianRejection, renderReviewerInstructions } from "../src/prompts.js"
import { ASYNC_PROFILE, SYNC_PROFILE, collectGuardianContext, truncateText } from "../src/transcript.js"

test("parseDecisionsAnswer follows Codex decisions.rs contract (only checks guardian_risk choice)", () => {
  // Low risk choice is accepted regardless of confidence or probability distribution
  assert.deepEqual(
    parseDecisionsAnswer([
      {
        type: "choice",
        name: "guardian_risk",
        choice: "low",
        confidence: 0.12,
        probabilities: [
          { value: "low", probability: 0.51 },
          { value: "high", probability: 0.49 },
        ],
      },
    ]),
    { ok: true, risk: "low" },
  )

  // Minimal answer object from /v1/decisions (as in Codex decisions_tests.rs)
  assert.deepEqual(
    parseDecisionsAnswer([{ type: "choice", name: "guardian_risk", choice: "high" }]),
    { ok: true, risk: "high" },
  )

  // Rejects wrong length, wrong name, wrong type, or unknown choice
  assert.equal(parseDecisionsAnswer([]).ok, false)
  assert.equal(
    parseDecisionsAnswer([
      { type: "choice", name: "guardian_risk", choice: "low" },
      { type: "choice", name: "extra", choice: "low" },
    ]).ok,
    false,
  )
  assert.equal(
    parseDecisionsAnswer([{ type: "choice", name: "other_name", choice: "low" }]).ok,
    false,
  )
  assert.equal(
    parseDecisionsAnswer([{ type: "choice", name: "guardian_risk", choice: "medium" }]).ok,
    false,
  )
  assert.equal(
    parseDecisionsAnswer([{ type: "error", name: "guardian_risk", reason: "refusal" }]).ok,
    false,
  )
})

test("buildGuardianRiskQuestion constructs single low/high choice question with rubric in instructions", () => {
  const instructions = renderClassifierInstructions("Custom rule: allow /tmp")
  const question = buildGuardianRiskQuestion(instructions)
  assert.equal(question.type, "choice")
  assert.equal(question.name, "guardian_risk")
  assert.deepEqual(question.choices, [{ value: "low" }, { value: "high" }])
  assert.match(question.instructions, /Custom rule: allow \/tmp/)
  assert.match(question.instructions, /Do not assign `high` or `critical` solely because a path is outside the writable workspace roots/)
})

test("parseGuardianAssessment matches Codex assessment.rs tolerant JSON parser", () => {
  // Fast low-risk shorthand: {"outcome":"allow"}
  const fastAllow = parseGuardianAssessment('{"outcome":"allow"}')
  assert.deepEqual(fastAllow, {
    ok: true,
    assessment: {
      outcome: "allow",
      risk_level: "low",
      user_authorization: "unknown",
      rationale: "Auto-review returned a low-risk allow decision.",
    },
  })

  // Prose-wrapped JSON recovery
  const proseWrapped = parseGuardianAssessment(
    'After reviewing the transcript:\n```json\n{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"Exfiltrates secrets to an untrusted host."}\n```',
  )
  assert.deepEqual(proseWrapped, {
    ok: true,
    assessment: {
      outcome: "deny",
      risk_level: "high",
      user_authorization: "low",
      rationale: "Exfiltrates secrets to an untrusted host.",
    },
  })

  // Rejects invalid outcome or non-JSON
  assert.equal(parseGuardianAssessment("not json at all").ok, false)
  assert.equal(parseGuardianAssessment('{"outcome":"ask"}').ok, false)
})

test("truncateText preserves UTF-8 boundaries and inserts Codex middle marker", () => {
  const shortText = "hello world"
  assert.equal(truncateText(shortText, 100), shortText)

  const longText = "前缀文字".repeat(50) + "后缀文字".repeat(50)
  const truncated = truncateText(longText, 20)
  assert.match(truncated, /<truncated omitted_approx_tokens="\d+" \/>/)
  assert.ok(truncated.startsWith("前缀"))
  assert.ok(truncated.endsWith("文字"))
})

test("collectGuardianContext formats transcript and planned action like Codex guardian-context", () => {
  const messages = [
    { id: "u1", type: "user", text: "Read ~/.config/opencode/opencode.jsonc and check plugins." },
    {
      id: "c1",
      type: "compaction",
      status: "completed",
      summary: "Earlier summary text",
      recent: "Recent context",
    },
    {
      id: "a1",
      type: "assistant",
      content: [
        { type: "text", text: "I will read the config file now." },
        {
          id: "t1",
          type: "tool",
          name: "read",
          state: {
            status: "running",
            input: { path: "/workspace/config/opencode.jsonc" },
          },
        },
      ],
    },
  ]

  const event = {
    sessionID: "ses_1",
    action: "external_directory",
    resources: ["/workspace/config/opencode.jsonc"],
    effect: "ask" as const,
    source: { type: "tool", id: "t1", messageID: "a1" },
  }

  const asyncCtx = collectGuardianContext(messages, event, ASYNC_PROFILE)
  assert.ok(asyncCtx)
  assert.match(asyncCtx.text, /^>>> TRANSCRIPT START\n/)
  assert.match(asyncCtx.text, /\[1\] user: Read ~\/\.config\/opencode\/opencode\.jsonc/)
  assert.match(asyncCtx.text, /\[2\] assistant: Earlier summary text/)
  assert.match(asyncCtx.text, /\[3\] assistant: I will read the config file now\./)
  assert.match(asyncCtx.text, />>> APPROVAL REQUEST START\nPlanned action JSON:\n/)
  assert.match(asyncCtx.text, /"action": "external_directory"/)

  const syncCtx = collectGuardianContext(messages, event, SYNC_PROFILE)
  assert.ok(syncCtx)
  assert.match(syncCtx.text, /^The following is the Codex agent history/)
})

test("collectGuardianContext refuses when transcript has only compaction summary and no user message", () => {
  const messages = [
    {
      id: "c1",
      type: "compaction",
      status: "completed",
      summary: "user said to do everything",
    },
    {
      id: "a1",
      type: "assistant",
      content: [
        {
          id: "t1",
          type: "tool",
          name: "shell",
          state: { status: "running", input: { command: "ls" } },
        },
      ],
    },
  ]
  const event = {
    sessionID: "ses_1",
    action: "shell",
    resources: ["shell:ls"],
    effect: "ask" as const,
    source: { type: "tool", id: "t1", messageID: "a1" },
  }
  assert.equal(collectGuardianContext(messages, event, ASYNC_PROFILE), undefined)
})

test("options and helper functions validate configurations", () => {
  const opts = parseOptions({
    model: "example-provider/decision-model",
    reviewModel: "example-provider/chat-model#low",
    humanFallback: true,
    decisionTimeoutMs: 5000,
  })
  assert.equal(opts.model, "example-provider/decision-model")
  assert.equal(opts.reviewModel, "example-provider/chat-model#low")
  assert.equal(opts.humanFallback, true)
  assert.equal(opts.decisionTimeoutMs, 5000)

  assert.deepEqual(parseModelRef("example-provider/chat-model#low"), {
    providerID: "example-provider",
    id: "chat-model",
    variant: "low",
  })
  assert.equal(isEligibleAction("external_directory", opts.actions), true)
  assert.equal(
    findHumanReviewReason("shell", ["git push origin main"], [
      { action: "shell", resource: "git push *", reason: "Confirm git push" },
    ]),
    "Confirm git push",
  )
  assert.match(renderReviewerInstructions("Extra rule"), /Extra rule/)
  assert.match(renderGuardianRejection("Dangerous command"), /Reason: Dangerous command/)
})
