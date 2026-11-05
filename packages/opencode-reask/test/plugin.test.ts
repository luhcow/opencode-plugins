import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../src/index.ts"

function host(answer: string) {
  const calls: string[] = []
  let rpc: any
  const question = { header: "Choice", question: "Pick a value", options: [{ label: "A", description: "Example" }] }
  const ctx: any = {
    storage: {
      get: async () => ({ session: { "message:call": { messageID: "message", toolCallID: "call", questions: [question], answers: [[answer]] } } }),
      set: async () => {},
    },
    rpc: { register: async (_: unknown, handlers: unknown) => { rpc = handlers; return { events: { emit: async () => {} } } } },
    command: { transform: async () => {} },
    event: { subscribe: async function* () {} },
    session: {
      hook: async () => {}, interrupt: async () => {}, wait: async () => {},
      context: async () => [
        { id: "message", type: "assistant", content: [{ type: "tool", name: "question", id: "call", state: { status: "completed", input: { questions: [question] } } }] },
        { id: "next", type: "user", text: "Continue" },
      ],
      revert: { stage: async () => calls.push("stage"), clear: async () => calls.push("clear"), commit: async () => calls.push("commit") },
      form: { create: async () => { calls.push("form"); return { id: "form" } }, cancel: async () => calls.push("cancel") },
    },
  }
  return { ctx, calls, rpc: () => rpc }
}

test("reask uses the supplied host and keeps answers isolated across plugin instances", async () => {
  const first = host("first")
  const second = host("second")
  const cleanFirst = await plugin.setup(first.ctx)
  const cleanSecond = await plugin.setup(second.ctx)
  try {
    assert.deepEqual((await first.rpc().list({ sessionID: "session" })).items[0].answers, [["first"]])
    assert.deepEqual((await second.rpc().list({ sessionID: "session" })).items[0].answers, [["second"]])
    assert.equal((await second.rpc().start({ sessionID: "session" })).ok, true)
    assert.deepEqual(second.calls, ["stage", "form"])
    assert.deepEqual(first.calls, [])
    await second.rpc().cancel({ sessionID: "session" })
    assert.deepEqual(second.calls, ["stage", "form", "cancel", "clear"])
  } finally {
    await cleanFirst?.()
    await cleanSecond?.()
  }
})

test("missing host APIs return a compatibility error instead of probing another server", async () => {
  const mock = host("answer")
  delete mock.ctx.session.revert
  const cleanup = await plugin.setup(mock.ctx)
  try {
    const result = await mock.rpc().revertOnly({ sessionID: "session" })
    assert.equal(result.ok, false)
    assert.match(result.error, /host with session.revert.stage/)
  } finally {
    await cleanup?.()
  }
})
