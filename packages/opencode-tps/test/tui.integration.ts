import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"

const source = process.env.OPENCODE_SOURCE_DIR
if (!source) throw new Error("Set OPENCODE_SOURCE_DIR to an OpenCode 2.2.x checkout")
const { createAppFixture } = await import(pathToFileURL(path.join(source, "packages/tui/test/fixture/app.ts")).href)
const plugin = path.resolve(import.meta.dirname, "..")

test("renders real-time streaming tok/s in prompt footer and settles to exact tok/s on step completion", async () => {
  const sessionID = "ses_tps_ui"
  const directory = "/project"
  let currentMessages: unknown[] = [
    { id: "msg_u1", type: "user", text: "Hello", time: { created: 1_000 } },
  ]
  const session = {
    id: sessionID,
    title: "TPS UI test",
    projectID: "proj_test",
    location: { directory },
    cost: 0.01,
    tokens: { input: 100, output: 120, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_000, updated: 3_000 },
  }

  await using setup = await createAppFixture({
    width: 110,
    height: 32,
    args: { sessionID },
    config: { animations: false, tabs: { enabled: false }, plugins: [plugin] },
    fetch: async (url: URL) => {
      if (url.pathname === "/api/session") return Response.json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return Response.json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/inbox`) return Response.json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/message`) {
        return Response.json({ data: currentMessages, cursor: {} })
      }
    },
  })

  await setup.ready
  await setup.waitForFrame((frame: string) => frame.includes("Hello"))

  // 1. Emit step.started + text.delta for live streaming estimation
  setup.events.emit({
    id: "evt_000001",
    type: "session.execution.started",
    created: 1_000,
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID },
  } as any)

  setup.events.emit({
    id: "evt_000002",
    type: "session.step.started",
    created: 1_000,
    durable: { aggregateID: sessionID, seq: 2, version: 1 },
    data: {
      sessionID,
      assistantMessageID: "msg_a1",
      agent: "build",
      model: { providerID: "openai", id: "gpt-5" },
      started: 1_000,
    },
  } as any)

  setup.events.emit({
    id: "evt_000003",
    type: "session.text.delta",
    created: 3_000,
    data: {
      sessionID,
      assistantMessageID: "msg_a1",
      ordinal: 0,
      delta: "a".repeat(380),
    },
  } as any)

  await setup.waitForFrame((frame: string) => frame.includes("⚡ ~50.0 tok/s"))

  // 2. Complete the step and execution with exact 150 tokens over 2000ms -> 75.0 tok/s
  currentMessages = [
    { id: "msg_u1", type: "user", text: "Hello", time: { created: 1_000 } },
    {
      id: "msg_a1",
      type: "assistant",
      agent: "build",
      model: { providerID: "openai", id: "gpt-5" },
      finish: "stop",
      cost: 0.01,
      tokens: { input: 100, output: 120, reasoning: 30, cache: { read: 0, write: 0 } },
      time: { created: 1_000, streamed: 3_000, completed: 3_000 },
      content: [{ type: "text", text: "a".repeat(380) }],
    },
    { id: "msg_idle1", type: "idle", outcome: "succeeded", time: { created: 3_000 } },
  ]

  setup.events.emit({
    id: "evt_000004",
    type: "session.step.streamed",
    created: 3_000,
    durable: { aggregateID: sessionID, seq: 3, version: 1 },
    data: {
      sessionID,
      assistantMessageID: "msg_a1",
    },
  } as any)

  setup.events.emit({
    id: "evt_000005",
    type: "session.step.ended",
    created: 3_000,
    durable: { aggregateID: sessionID, seq: 4, version: 1 },
    data: {
      sessionID,
      assistantMessageID: "msg_a1",
      finish: "stop",
      cost: 0.01,
      tokens: { input: 100, output: 120, reasoning: 30, cache: { read: 0, write: 0 } },
    },
  } as any)

  setup.events.emit({
    id: "evt_000006",
    type: "session.execution.succeeded",
    created: 3_000,
    durable: { aggregateID: sessionID, seq: 5, version: 1 },
    data: { sessionID },
  } as any)

  await setup.waitForFrame((frame: string) => frame.includes("75.0 tok/s") && !frame.includes("~50.0 tok/s"))

  // 3. Manual compaction started with inputID at t=4000, delta at t=5000, ended at t=6000 with 100 tokens -> 50.0 tok/s
  setup.events.emit({
    id: "evt_000007",
    type: "session.execution.started",
    created: 4_000,
    durable: { aggregateID: sessionID, seq: 6, version: 1 },
    data: { sessionID },
  } as any)

  setup.events.emit({
    id: "evt_000008",
    type: "session.compaction.started",
    created: 4_000,
    durable: { aggregateID: sessionID, seq: 7, version: 1 },
    data: {
      sessionID,
      reason: "manual",
      inputID: "msg_u1",
    },
  } as any)

  setup.events.emit({
    id: "evt_000009",
    type: "session.compaction.delta",
    created: 5_000,
    data: {
      sessionID,
      text: "b".repeat(190),
    },
  } as any)

  setup.events.emit({
    id: "evt_000010",
    type: "session.compaction.ended",
    created: 6_000,
    durable: { aggregateID: sessionID, seq: 8, version: 1 },
    data: {
      sessionID,
      reason: "manual",
      model: { providerID: "openai", id: "gpt-5" },
      native: false,
      text: "b".repeat(380),
      cost: 0.01,
      tokens: { input: 200, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  } as any)

  setup.events.emit({
    id: "evt_000011",
    type: "session.execution.succeeded",
    created: 6_000,
    durable: { aggregateID: sessionID, seq: 9, version: 1 },
    data: { sessionID },
  } as any)

  await setup.waitForFrame((frame: string) => frame.includes("50.0 tok/s") && !frame.includes("75.0 tok/s"))

  // 4. OpenCode 2.3.0 session.step.first-token & time.firstToken exclude TTFT (10s TTFT, 2s stream -> 100.0 tok/s)
  setup.events.emit({
    id: "evt_000012",
    type: "session.execution.started",
    created: 10_000,
    durable: { aggregateID: sessionID, seq: 10, version: 1 },
    data: { sessionID },
  } as any)

  setup.events.emit({
    id: "evt_000013",
    type: "session.step.started",
    created: 10_000,
    durable: { aggregateID: sessionID, seq: 11, version: 1 },
    data: {
      sessionID,
      assistantMessageID: "msg_a2",
      agent: "build",
      model: { providerID: "openai", id: "gpt-5" },
      started: 10_000,
    },
  } as any)

  setup.events.emit({
    id: "evt_000014",
    type: "session.step.first-token",
    created: 20_000,
    durable: { aggregateID: sessionID, seq: 12, version: 1 },
    data: {
      sessionID,
      assistantMessageID: "msg_a2",
    },
  } as any)

  setup.events.emit({
    id: "evt_000015",
    type: "session.text.delta",
    created: 21_000,
    data: {
      sessionID,
      assistantMessageID: "msg_a2",
      ordinal: 0,
      delta: "c".repeat(380),
    },
  } as any)

  await setup.waitForFrame((frame: string) => frame.includes("⚡") && frame.includes("tok/s"))

  currentMessages = [
    ...currentMessages,
    { id: "msg_u2", type: "user", text: "Second", time: { created: 10_000 } },
    {
      id: "msg_a2",
      type: "assistant",
      agent: "build",
      model: { providerID: "openai", id: "gpt-5" },
      finish: "stop",
      cost: 0.01,
      tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 10_000, firstToken: 20_000, streamed: 22_000, completed: 22_000 },
      content: [{ type: "text", text: "c".repeat(380) }],
    },
    { id: "msg_idle2", type: "idle", outcome: "succeeded", time: { created: 22_000 } },
  ]

  setup.events.emit({
    id: "evt_000016",
    type: "session.step.streamed",
    created: 22_000,
    durable: { aggregateID: sessionID, seq: 13, version: 1 },
    data: { sessionID, assistantMessageID: "msg_a2" },
  } as any)

  setup.events.emit({
    id: "evt_000017",
    type: "session.step.ended",
    created: 22_000,
    durable: { aggregateID: sessionID, seq: 14, version: 1 },
    data: {
      sessionID,
      assistantMessageID: "msg_a2",
      finish: "stop",
      cost: 0.01,
      tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  } as any)

  setup.events.emit({
    id: "evt_000018",
    type: "session.execution.succeeded",
    created: 22_000,
    durable: { aggregateID: sessionID, seq: 15, version: 1 },
    data: { sessionID },
  } as any)

  await setup.waitForFrame((frame: string) => frame.includes("100.0 tok/s"))
})
