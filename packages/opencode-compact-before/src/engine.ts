import { randomUUID } from "node:crypto"
import { summaryPrompt, type Message, type ModelRef } from "./core.ts"

export type Selection = { beforeID: string; transcript: string }
export type StartInput = Selection & { sessionID: string }

export type Host = {
  get(key: string): Promise<unknown>
  put(key: string, value: Selection): Promise<void>
  remove(key: string): Promise<void>
  context(sessionID: string): Promise<readonly Message[]>
  compact(sessionID: string, requestID: string): Promise<{ id: string }>
  generate(prompt: string, model: ModelRef): Promise<string>
}

type CompactionHook = {
  sessionID: string
  model: ModelRef
  result?: { summary: string; metadata?: Record<string, unknown> }
}

const selectionKey = (requestID: string) => `selection/${requestID}`

export function createEngine(host: Host) {
  return {
    async start(input: StartInput) {
      const requestID = `msg_${randomUUID().replaceAll("-", "")}`
      await host.put(selectionKey(requestID), { beforeID: input.beforeID, transcript: input.transcript })
      const admitted = await host.compact(input.sessionID, requestID)
      // Native admission coalesces pending compactions; the already-admitted request keeps its selection.
      if (admitted.id !== requestID) await host.remove(selectionKey(requestID))
      return { requestID: admitted.id }
    },

    async hook(event: CompactionHook) {
      const messages = await host.context(event.sessionID)
      const running = messages.findLast((message) => message.type === "compaction" && message.status === "running")
      if (!running) return
      const selection = (await host.get(selectionKey(running.id))) as Selection | undefined
      if (!selection) return
      const summary = await host.generate(summaryPrompt(selection.transcript), event.model)
      event.result = {
        summary,
        metadata: {
          keepID: selection.beforeID,
          compactBefore: { requestID: running.id, beforeID: selection.beforeID },
        },
      }
    },

    async reconcile(sessionID: string, cancelledID?: string) {
      if (cancelledID) return host.remove(selectionKey(cancelledID))
      const messages = await host.context(sessionID)
      for (const message of messages) {
        if (message.type === "compaction" && (message.status === "completed" || message.status === "failed")) {
          await host.remove(selectionKey(message.id))
        }
      }
    },
  }
}
