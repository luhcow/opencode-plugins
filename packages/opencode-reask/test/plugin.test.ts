import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../src/index.ts"
import tuiPlugin from "../src/tui.ts"

const tick = () => new Promise((resolve) => setImmediate(resolve))

function host(answer: string) {
  const calls: string[] = []
  const storage = new Map<string, unknown>()
  storage.set("overrides", {
    session: {
      "message:call": {
        messageID: "message",
        toolCallID: "call",
        questions: [{ header: "Choice", question: "Pick a value", options: [{ label: "A", description: "Example" }] }],
        answers: [[answer]],
        formatted: `User has answered your questions: "Pick a value"="${answer}". You can now continue with the user's answers in mind.`,
        updatedAt: 1,
      },
    },
  })
  let rpc: any
  const emittedEvents: Array<{ name: string; data: unknown }> = []
  const hooks = new Map<string, (event: { sessionID: string; messages: unknown[] }) => Promise<void>>()
  const question = { header: "Choice", question: "Pick a value", options: [{ label: "A", description: "Example" }] }
  const ctx: any = {
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => { storage.set(key, value) },
    },
    rpc: {
      register: async (_: unknown, handlers: unknown) => {
        rpc = handlers
        return {
          events: {
            emit: async (name: string, data: unknown) => {
              emittedEvents.push({ name, data })
            },
          },
        }
      },
    },
    command: { transform: async () => {} },
    event: { subscribe: async function* () {} },
    session: {
      hook: async (name: string, handler: (event: { sessionID: string; messages: unknown[] }) => Promise<void>) => {
        hooks.set(name, handler)
      },
      interrupt: async () => { calls.push("interrupt") },
      wait: async () => { calls.push("wait") },
      synthetic: async (input: unknown) => { calls.push(`synthetic:${JSON.stringify(input)}`) },
      context: async () => [
        { id: "message", type: "assistant", content: [{ type: "tool", name: "question", id: "call", state: { status: "completed", input: { questions: [question] } } }] },
        { id: "next", type: "user", text: "Continue" },
      ],
    },
  }
  return { ctx, calls, emittedEvents, hooks, rpc: () => rpc }
}

test("reask uses the supplied host and keeps answers isolated across plugin instances", async () => {
  const first = host("first")
  const second = host("second")
  const cleanFirst = await plugin.setup(first.ctx)
  const cleanSecond = await plugin.setup(second.ctx)
  try {
    assert.deepEqual((await first.rpc().list({ sessionID: "session" })).items[0].answers, [["first"]])
    assert.deepEqual((await second.rpc().list({ sessionID: "session" })).items[0].answers, [["second"]])

    const prepared = await second.rpc().prepare({ sessionID: "session" })
    assert.equal(prepared.ok, true)
    assert.ok(prepared.formID?.startsWith("frm_reask_"))
    assert.equal(prepared.revertedFromMessageID, "next")
    assert.deepEqual(second.calls, ["interrupt", "wait"])
    assert.deepEqual(first.calls, [])

    const pending = await second.rpc().pending({ formID: prepared.formID })
    assert.deepEqual(pending, { exists: true, sessionID: "session", revertStaged: true })

    const aborted = await second.rpc().abort({ sessionID: "session", formID: prepared.formID })
    assert.deepEqual(aborted, { ok: true, clearedFormID: prepared.formID, revertStaged: true })
    assert.deepEqual(await second.rpc().pending({ formID: prepared.formID }), { exists: false })
  } finally {
    await cleanFirst?.()
    await cleanSecond?.()
  }
})

test("TUI drives client revert.stage, form.create, revert.commit, and rpc.complete end-to-end", async () => {
  const server = host("initial")
  const cleanServer = await plugin.setup(server.ctx)

  const clientCalls: Array<{ op: string; input: unknown; options: unknown }> = []
  const dataHandlers = new Map<string, Array<(event: any) => void>>()
  const rpcEventHandlers = new Map<string, Array<(event: any) => void>>()
  const commands: any[] = []
  const toasts: any[] = []

  const tuiCtx: any = {
    location: { directory: "/repo" },
    client: {
      rpc: () => ({
        list: (input: unknown) => server.rpc().list(input),
        prepare: (input: unknown) => server.rpc().prepare(input),
        revertTarget: (input: unknown) => server.rpc().revertTarget(input),
        pending: (input: unknown) => server.rpc().pending(input),
        complete: async (input: unknown) => {
          const res = await server.rpc().complete(input)
          for (const evt of server.emittedEvents.splice(0)) {
            rpcEventHandlers.get(evt.name)?.forEach((h) => h({ data: evt.data }))
          }
          return res
        },
        abort: (input: unknown) => server.rpc().abort(input),
        events: {
          on: (name: string, handler: (event: any) => void) => {
            const list = rpcEventHandlers.get(name) ?? []
            list.push(handler)
            rpcEventHandlers.set(name, list)
            return () => {}
          },
        },
      }),
      session: {
        revert: {
          stage: async (input: unknown, options: unknown) => {
            clientCalls.push({ op: "revert.stage", input, options })
            return {}
          },
          commit: async (input: unknown, options: unknown) => {
            clientCalls.push({ op: "revert.commit", input, options })
          },
          clear: async (input: unknown, options: unknown) => {
            clientCalls.push({ op: "revert.clear", input, options })
          },
        },
        form: {
          create: async (input: unknown, options: unknown) => {
            clientCalls.push({ op: "form.create", input, options })
            return input
          },
          cancel: async (input: unknown, options: unknown) => {
            clientCalls.push({ op: "form.cancel", input, options })
          },
        },
      },
    },
    data: {
      on: (type: string, handler: (event: any) => void) => {
        const list = dataHandlers.get(type) ?? []
        list.push(handler)
        dataHandlers.set(type, list)
        return () => {}
      },
      location: { default: () => ({ directory: "/repo" }) },
      session: {
        get: () => ({ location: { directory: "/repo" } }),
        sync: async () => {},
        message: { list: () => [] },
        form: { sync: async () => {} },
      },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "session" }) },
      dialog: { clear: () => {}, set: () => {}, select: async () => undefined, alert: async () => {} },
      toast: { show: (t: unknown) => toasts.push(t) },
    },
    keymap: {
      layer: (factory: () => { commands: any[] }) => {
        commands.push(...factory().commands)
        return () => {}
      },
    },
    theme: {
      background: { raised: { base: "#111" } },
      decrease: (c: string) => c,
    },
  }

  const cleanTui = await tuiPlugin.setup(tuiCtx)
  try {
    const reaskLast = commands.find((c) => c.id === "reask.last")
    assert.ok(reaskLast)
    await reaskLast.run()

    assert.equal(clientCalls[0]?.op, "revert.stage")
    assert.deepEqual(clientCalls[0]?.input, { sessionID: "session", messageID: "next", files: true })
    assert.deepEqual(clientCalls[0]?.options, { headers: { "x-opencode-directory": "%2Frepo" } })

    assert.equal(clientCalls[1]?.op, "form.create")
    const formID = (clientCalls[1]?.input as { id: string }).id
    assert.ok(formID.startsWith("frm_reask_"))

    // Simulate user submitting the form in OpenCode TUI
    dataHandlers.get("form.replied")?.forEach((h) =>
      h({ data: { id: formID, sessionID: "session", answer: { q0: "A" } } }),
    )
    await tick()

    assert.equal(clientCalls[2]?.op, "revert.commit")
    assert.deepEqual(clientCalls[2]?.input, { sessionID: "session" })
    assert.ok(server.calls.some((c) => c.startsWith("synthetic:") && c.includes('"resume":true')))
    assert.equal(toasts.at(-1)?.variant, "success")

    // Verify context hook rewrites the question tool-result to the new answer
    const modelMessages: any[] = [
      { id: "message", role: "assistant", content: [{ type: "tool-call", id: "call", name: "question", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", id: "call", name: "question", result: { type: "text", value: "old" } }] },
    ]
    await server.hooks.get("context")!({ sessionID: "session", messages: modelMessages })
    assert.match(modelMessages[1].content[0].result.value, /"Pick a value"="A"/)

    // Trigger again and cancel via form.cancelled -> clears staged revert cleanly
    await reaskLast.run()
    const secondFormID = (clientCalls[4]?.input as { id: string }).id
    dataHandlers.get("form.cancelled")?.forEach((h) => h({ data: { id: secondFormID, sessionID: "session" } }))
    await tick()

    assert.equal(clientCalls[5]?.op, "revert.clear")
    assert.deepEqual(clientCalls[5]?.input, { sessionID: "session" })
  } finally {
    await cleanTui?.()
    await cleanServer?.()
  }
})
