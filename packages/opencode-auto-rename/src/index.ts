import { Plugin } from "@opencode/plugin"
import {
  MAX_STORED_SESSIONS,
  STORAGE_KEY,
  buildTitlePrompt,
  cleanGeneratedTitle,
  resolveFirstTurnForRename,
  unwrapData,
  unwrapMessages,
  unwrapText,
  type SessionInfo,
} from "./core.ts"

export default Plugin.define({
  id: "auto-rename-first-turn",
  async setup(ctx) {
    const processedSessions = new Set<string>()
    const inFlightSessions = new Set<string>()
    let storageLoaded = false

    const ensureStorageLoaded = async () => {
      if (storageLoaded) return
      storageLoaded = true
      try {
        const stored = await ctx.storage.get(STORAGE_KEY)
        if (Array.isArray(stored)) {
          for (const item of stored) {
            if (typeof item === "string") processedSessions.add(item)
          }
        }
      } catch {
        // Ignore storage read errors
      }
    }

    const markProcessed = async (sessionID: string) => {
      processedSessions.add(sessionID)
      try {
        const list = Array.from(processedSessions).slice(-MAX_STORED_SESSIONS)
        await ctx.storage.set(STORAGE_KEY, list)
      } catch {
        // Ignore storage write errors
      }
    }

    const handleFirstTurnCompleted = async (
      sessionID: string,
      trigger: "idle" | "turn-boundary" = "idle",
    ) => {
      await ensureStorageLoaded()
      if (processedSessions.has(sessionID) || inFlightSessions.has(sessionID)) return

      inFlightSessions.add(sessionID)
      try {
        const session = unwrapData<SessionInfo>(await ctx.session.get({ sessionID }))
        if (!session || session.parentID) {
          await markProcessed(sessionID)
          return
        }

        const messages = unwrapMessages(await ctx.session.context({ sessionID }))
        const resolution = resolveFirstTurnForRename(messages, trigger)

        if (resolution.status === "wait") return
        if (resolution.status === "skip") {
          await markProcessed(sessionID)
          return
        }

        const { userText, assistantText } = resolution

        let model = session.model
        try {
          const titleAgent = unwrapData<{ model?: SessionInfo["model"] }>(await ctx.agent.get({ agentID: "title" }))
          if (titleAgent?.model) {
            model = titleAgent.model
          }
        } catch {
          // Fall back to session.model
        }

        const prompt = buildTitlePrompt(userText, assistantText)
        const generateText =
          (
            ctx as unknown as {
              experimental?: { generate?: { text?: typeof ctx.generate.text } }
            }
          ).experimental?.generate?.text ?? ctx.generate.text

        const generated = await generateText({
          prompt,
          ...(model ? { model } : {}),
        })

        const newTitle = cleanGeneratedTitle(unwrapText(generated))
        await markProcessed(sessionID)

        if (!newTitle || newTitle === session.title) return

        await ctx.session.update({
          sessionID,
          title: newTitle,
        })
      } catch (error) {
        console.error("[auto-rename-first-turn] failed to rename session", sessionID, error)
      } finally {
        inFlightSessions.delete(sessionID)
      }
    }

    await ctx.session.hook("context", (event) => {
      if (!processedSessions.has(event.sessionID) && !inFlightSessions.has(event.sessionID)) {
        void handleFirstTurnCompleted(event.sessionID, "turn-boundary")
      }
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const ev = event as {
            type: string
            data?: { sessionID?: string }
            properties?: { sessionID?: string }
          }
          if (ev.type === "session.execution.succeeded" || ev.type === "session.idle") {
            const sessionID = ev.data?.sessionID ?? ev.properties?.sessionID
            if (sessionID) {
              void handleFirstTurnCompleted(sessionID, "idle")
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("[auto-rename-first-turn] event loop error", error)
        }
      }
    })()

    return () => {
      controller.abort()
    }
  },
})
