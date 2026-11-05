import { Plugin } from "@opencode/plugin"
import { createEngine, type StartInput } from "./engine.ts"
import { CompactBeforeRpc } from "./rpc.ts"

export default Plugin.define({
  id: "compact-before",
  async setup(ctx) {
    const controller = new AbortController()
    const engine = createEngine({
      get: (key) => ctx.storage.get(key),
      put: (key, value) => ctx.storage.set(key, value),
      remove: (key) => ctx.storage.remove(key),
      context: (sessionID) => ctx.session.context({ sessionID }),
      compact: (sessionID, id) => ctx.session.compact({ sessionID, id }),
      async generate(prompt, model) {
        return (await ctx.experimental.generate.text({ prompt, model }, { signal: controller.signal })).text
      },
    })

    await ctx.rpc.register(CompactBeforeRpc, {
      // JSON Schema validation is supplied by OpenCode's RPC layer.
      start: (input) => engine.start(input as StartInput),
    })
    await ctx.session.hook("compaction", (event) => engine.hook(event))

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.compaction.ended", "session.compaction.failed", "session.inbox.cancelled"],
          signal: controller.signal,
        })) {
          await engine.reconcile(
            event.data.sessionID,
            event.type === "session.inbox.cancelled" ? event.data.inboxID : undefined,
          )
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("[compact-before] cleanup failed", error)
      }
    })()
    return () => controller.abort()
  },
})
