import { test } from "node:test"
import assert from "node:assert/strict"
import { createEngine, type Host } from "../src/engine.ts"
import { summaryPrompt, type Message } from "../src/core.ts"

const model = { providerID: "native", id: "selected-by-opencode" }

function fixture() {
  const storage = new Map<string, unknown>()
  const state = {
    messages: [{ id: "msg_user", type: "user", text: "Current conversation" }] as Message[],
    admitted: [] as string[],
    prompts: [] as string[],
    output: "## Objective\nCheckpoint",
    coalesce: false,
  }
  const host: Host = {
    get: async (key) => structuredClone(storage.get(key)),
    put: async (key, value) => {
      storage.set(key, structuredClone(value))
    },
    remove: async (key) => {
      storage.delete(key)
    },
    context: async () => structuredClone(state.messages),
    compact: async (_, id) => {
      if (state.coalesce && state.admitted.length) return { id: state.admitted[0] }
      state.admitted.push(id)
      state.messages.push({ id, type: "compaction", status: "running" })
      return { id }
    },
    generate: async (prompt, selected) => {
      assert.deepEqual(selected, model)
      state.prompts.push(prompt)
      return state.output
    },
  }
  return { storage, state, host, engine: createEngine(host) }
}

test("passes a complete large prefix to one generation and keeps the full large response", async () => {
  const f = fixture()
  const transcript = "BEGIN\n" + "中文😀 history\n".repeat(30_000) + "\nEND"
  f.state.output = "  " + "long summary\n".repeat(30_000) + "  "
  const admitted = await f.engine.start({ sessionID: "ses_test", beforeID: "msg_user", transcript })
  const event: Parameters<typeof f.engine.hook>[0] = { sessionID: "ses_test", model }
  await f.engine.hook(event)
  assert.deepEqual(f.state.prompts, [summaryPrompt(transcript)])
  assert.equal(event.result?.summary, f.state.output)
  assert.equal(event.result?.metadata?.keepID, "msg_user")
  assert.deepEqual(f.state.admitted, [admitted.requestID])
})

test("native admission coalescing keeps the first request without a plugin conflict error", async () => {
  const f = fixture()
  f.state.coalesce = true
  const first = await f.engine.start({ sessionID: "ses_test", beforeID: "msg_first", transcript: "first" })
  const second = await f.engine.start({ sessionID: "ses_test", beforeID: "msg_second", transcript: "second" })
  assert.equal(first.requestID, second.requestID)
  assert.equal(f.storage.size, 1)
  const event: Parameters<typeof f.engine.hook>[0] = { sessionID: "ses_test", model }
  await f.engine.hook(event)
  assert.equal(event.result?.metadata?.keepID, "msg_first")
  assert.deepEqual(f.state.prompts, [summaryPrompt("first")])
})

test("unselected native compactions are not handled by the plugin", async () => {
  const f = fixture()
  f.state.messages.push({ id: "msg_native", type: "compaction", status: "running" })
  const event: Parameters<typeof f.engine.hook>[0] = { sessionID: "ses_test", model }
  await f.engine.hook(event)
  assert.equal(event.result, undefined)
  assert.equal(f.state.prompts.length, 0)
})

test("native admission and generation errors propagate without plugin retries", async () => {
  const f = fixture()
  const error = new Error("Native model error")
  await f.engine.start({ sessionID: "ses_test", beforeID: "msg_user", transcript: "history" })
  let calls = 0
  f.host.generate = async () => {
    calls++
    throw error
  }
  await assert.rejects(f.engine.hook({ sessionID: "ses_test", model }), (actual) => actual === error)
  assert.equal(calls, 1)
  f.host.compact = async () => {
    throw error
  }
  await assert.rejects(
    f.engine.start({ sessionID: "ses_test", beforeID: "msg_user", transcript: "history" }),
    (actual) => actual === error,
  )
})

test("checkpoint-only context and empty prefixes are passed to native admission", async () => {
  const f = fixture()
  f.state.messages = [{ id: "msg_checkpoint", type: "compaction", status: "completed" }]
  await f.engine.start({ sessionID: "ses_test", beforeID: "msg_first", transcript: "" })
  assert.equal(f.state.admitted.length, 1)
  f.state.output = ""
  const event: Parameters<typeof f.engine.hook>[0] = { sessionID: "ses_test", model }
  await f.engine.hook(event)
  assert.equal(event.result?.summary, "")
  assert.deepEqual(f.state.prompts, [summaryPrompt("")])
})

test("saved selections survive reload and are removed after native completion or cancellation", async () => {
  const f = fixture()
  const first = await f.engine.start({ sessionID: "ses_test", beforeID: "msg_user", transcript: "history" })
  const reloaded = createEngine(f.host)
  const event: Parameters<typeof reloaded.hook>[0] = { sessionID: "ses_test", model }
  await reloaded.hook(event)
  assert.equal(event.result?.metadata?.keepID, "msg_user")
  f.state.messages = [{ id: first.requestID, type: "compaction", status: "completed" }]
  await reloaded.reconcile("ses_test")
  assert.equal(f.storage.size, 0)
  const second = await reloaded.start({ sessionID: "ses_test", beforeID: "msg_user", transcript: "history" })
  await reloaded.reconcile("ses_test", second.requestID)
  assert.equal(f.storage.size, 0)
})
