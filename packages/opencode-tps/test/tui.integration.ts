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
})
