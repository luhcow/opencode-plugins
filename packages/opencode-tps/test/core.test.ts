import assert from "node:assert/strict"
import test from "node:test"
import {
  clampCalibration,
  createTpsTracker,
  estimateTokens,
  formatTpsLabel,
  historyTurnTps,
  type HistoryMessageLike,
} from "../src/core.ts"

test("estimateTokens handles ASCII, CJK, and mixed text", () => {
  assert.equal(estimateTokens(""), 0)
  const ascii = estimateTokens("hello world from opencode")
  assert.ok(ascii > 5 && ascii < 10)
  const cjk = estimateTokens("实时显示每秒令牌数")
  assert.ok(cjk > 10 && cjk < 15)
})

test("clampCalibration bounds ratio safely", () => {
  assert.equal(clampCalibration(NaN), 1)
  assert.equal(clampCalibration(-5), 1)
  assert.equal(clampCalibration(0.1), 0.5)
  assert.equal(clampCalibration(1.2), 1.2)
  assert.equal(clampCalibration(9.9), 2.5)
})

test("createTpsTracker estimates live streaming tok/s and calibrates on step end", () => {
  const tracker = createTpsTracker()
  const sessionID = "ses_live"

  tracker.onExecutionStarted(sessionID)
  tracker.onStepStarted(sessionID, "msg_a1", 1_000, 1_000)

  // Before any delta arrives, no snapshot is emitted yet
  assert.equal(tracker.getSnapshot(sessionID, 1_200), undefined)

  // Stream 380 ASCII chars (~100 estimated tokens) over 2 seconds (1000 -> 3000)
  tracker.onDelta(sessionID, "msg_a1", "a".repeat(190), 2_000)
  const mid = tracker.getSnapshot(sessionID, 2_000)
  assert.ok(mid)
  assert.equal(mid.streaming, true)
  assert.equal(mid.exact, false)
  assert.ok(Math.abs(mid.tps - 50) < 1)
  assert.equal(formatTpsLabel(mid), "⚡ ~50.0 tok/s")

  tracker.onDelta(sessionID, "msg_a1", "a".repeat(190), 3_000)
  const mid2 = tracker.getSnapshot(sessionID, 3_000)
  assert.ok(mid2)
  assert.ok(Math.abs(mid2.tps - 50) < 1)

  // Step finishes streaming at t=3000, then tool runs until t=8000
  tracker.onStepStreamed(sessionID, "msg_a1", 3_000)
  const duringTool = tracker.getSnapshot(sessionID, 7_000)
  assert.ok(duringTool)
  // Duration is frozen at 3000 - 1000 = 2000ms, so tool wait does not dilute tok/s
  assert.equal(duringTool.durationMs, 2_000)
  assert.ok(Math.abs(duringTool.tps - 50) < 1)

  // Step ends with exact provider usage: 120 output + 30 reasoning = 150 tokens
  tracker.onStepEnded(sessionID, "msg_a1", { input: 500, output: 120, reasoning: 30 }, 8_000)
  const afterStep1 = tracker.getSnapshot(sessionID, 8_000)
  assert.ok(afterStep1)
  assert.equal(afterStep1.tokens, 150)
  assert.equal(afterStep1.durationMs, 2_000)
  assert.equal(afterStep1.tps, 75)
  assert.equal(afterStep1.exact, true)
  assert.equal(afterStep1.streaming, true)
  assert.equal(formatTpsLabel(afterStep1), "⚡ 75.0 tok/s")

  // Turn finishes
  tracker.onExecutionFinished(sessionID, 8_000)
  const finalSnap = tracker.getSnapshot(sessionID, 8_500)
  assert.ok(finalSnap)
  assert.equal(finalSnap.tps, 75)
  assert.equal(finalSnap.streaming, false)
  assert.equal(finalSnap.exact, true)
  assert.equal(formatTpsLabel(finalSnap), "75.0 tok/s")
})

test("historyTurnTps matches multi-step turn weighting and respects revert boundary", () => {
  const messages: HistoryMessageLike[] = [
    { id: "msg_u1", type: "user", time: { created: 1_000 } },
    {
      id: "msg_a1",
      type: "assistant",
      time: { created: 1_000, streamed: 3_000, completed: 5_000 },
      tokens: { output: 80, reasoning: 20 },
    },
    {
      id: "msg_a2",
      type: "assistant",
      time: { created: 5_000, streamed: 7_000, completed: 7_000 },
      tokens: { output: 100, reasoning: 0 },
    },
    { id: "msg_idle1", type: "idle", time: { created: 7_000 } },
    { id: "msg_u2", type: "user", time: { created: 10_000 } },
    {
      id: "msg_a3",
      type: "assistant",
      time: { created: 10_000, streamed: 12_000, completed: 12_000 },
      tokens: { output: 160, reasoning: 0 },
    },
    { id: "msg_idle2", type: "idle", time: { created: 12_000 } },
  ]

  // Latest turn is msg_u2 -> msg_a3: 160 tokens in 2s = 80 tok/s
  const latest = historyTurnTps(messages)
  assert.ok(latest)
  assert.equal(latest.tps, 80)
  assert.equal(latest.tokens, 160)

  // If msg_u2 is reverted, visible turn is msg_u1 -> msg_a1 + msg_a2: (100 + 100) tokens in (2s + 2s) = 50 tok/s
  const reverted = historyTurnTps(messages, "msg_u2")
  assert.ok(reverted)
  assert.equal(reverted.tps, 50)
  assert.equal(reverted.tokens, 200)
})
