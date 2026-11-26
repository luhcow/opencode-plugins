import { Plugin } from "@opencode/plugin"
import {
  NOTICE_PREFIX,
  WAKE_PREFIX,
  applyContextOverrides,
  clip,
  extractEntries,
  formatQuestionAnswer,
  makeKey,
  unwrapMessages,
  type ModelMessage,
  type SessionOverrides,
} from "./core.ts"
import {
  ReaskRpc,
  type QuestionItem,
  type ReaskAbortInput,
  type ReaskAbortOutput,
  type ReaskCompleteInput,
  type ReaskCompleteOutput,
  type ReaskEntry,
  type ReaskListOutput,
  type ReaskPendingInput,
  type ReaskPendingOutput,
  type ReaskPrepareInput,
  type ReaskPrepareOutput,
  type ReaskRevertTargetInput,
  type ReaskRevertTargetOutput,
} from "./rpc.ts"

const STORAGE_KEY = "overrides"
const REASK_FORM_PREFIX = "frm_reask_"
const FALLBACK_REPLY_DELAY_MS = 300

type PendingReaskForm = {
  formID: string
  sessionID: string
  messageID: string
  toolCallID: string
  index: number
  questions: QuestionItem[]
  revertStaged: boolean
  revertedFromMessageID?: string
}

function createReaskFormID(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${REASK_FORM_PREFIX}${Date.now().toString(36)}_${rand}`
}

export { formatQuestionAnswer }

export default Plugin.define({
  id: "reask",
  async setup(ctx) {
    // State belongs to this host/location, never to another plugin instance.
    const memoryOverrides = new Map<string, SessionOverrides>()
    const pendingForms = new Map<string, PendingReaskForm>()
    const pendingBySession = new Map<string, string>()
    const fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>()

    const clearFallbackTimer = (formID: string) => {
      const timer = fallbackTimers.get(formID)
      if (timer) {
        clearTimeout(timer)
        fallbackTimers.delete(formID)
      }
    }

    const loadSessionOverrides = async (sessionID: string): Promise<SessionOverrides> => {
      const cached = memoryOverrides.get(sessionID)
      if (cached) return cached
      const stored = await ctx.storage.get(STORAGE_KEY)
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {}
      const sessionMap = (stored as Record<string, SessionOverrides>)[sessionID]
      if (!sessionMap || typeof sessionMap !== "object" || Array.isArray(sessionMap)) return {}
      memoryOverrides.set(sessionID, sessionMap)
      return sessionMap
    }

    const saveSessionOverrides = async (sessionID: string, overrides: SessionOverrides): Promise<void> => {
      const stored = await ctx.storage.get(STORAGE_KEY)
      const all =
        stored && typeof stored === "object" && !Array.isArray(stored)
          ? { ...(stored as Record<string, SessionOverrides>) }
          : {}
      if (Object.keys(overrides).length > 0) {
        all[sessionID] = overrides
        memoryOverrides.set(sessionID, overrides)
      } else {
        delete all[sessionID]
        memoryOverrides.delete(sessionID)
      }
      await ctx.storage.set(STORAGE_KEY, all)
    }

    const popPendingForSession = (
      sessionID: string,
      formID?: string,
    ): { clearedFormID?: string; revertStaged?: boolean } => {
      const targetFormID = formID ?? pendingBySession.get(sessionID)
      if (!targetFormID) return {}
      const pending = pendingForms.get(targetFormID)
      clearFallbackTimer(targetFormID)
      pendingForms.delete(targetFormID)
      if (pendingBySession.get(sessionID) === targetFormID) {
        pendingBySession.delete(sessionID)
      }
      return {
        clearedFormID: targetFormID,
        revertStaged: pending?.revertStaged ?? false,
      }
    }

    const listSessionQuestions = async (sessionID: string): Promise<ReaskEntry[]> => {
      const [rawMessages, overrides] = await Promise.all([
        ctx.session.context({ sessionID }),
        loadSessionOverrides(sessionID),
      ])
      return extractEntries(unwrapMessages(rawMessages), overrides)
    }

    const resolveTargetEntry = (
      entries: ReaskEntry[],
      selector: { messageID?: string; toolCallID?: string; index?: number },
    ): ReaskEntry | undefined => {
      let target: ReaskEntry | undefined
      if (selector.messageID && selector.toolCallID) {
        target = entries.find((e) => e.messageID === selector.messageID && e.toolCallID === selector.toolCallID)
      }
      if (!target && selector.messageID) {
        target = entries.findLast((e) => e.messageID === selector.messageID)
      }
      if (!target && selector.toolCallID) {
        target = entries.find((e) => e.toolCallID === selector.toolCallID)
      }
      if (!target && typeof selector.index === "number") {
        target = entries.find((e) => e.index === selector.index)
      }
      if (!target && !selector.messageID && !selector.toolCallID && selector.index === undefined) {
        target = entries.at(-1)
      }
      return target
    }

    const prepareReask = async (input: ReaskPrepareInput): Promise<ReaskPrepareOutput> => {
      const { sessionID } = input
      try {
        const previous = popPendingForSession(sessionID)

        await ctx.session.interrupt({ sessionID }).catch(() => {})
        await ctx.session.wait({ sessionID }).catch(() => {})

        const entries = await listSessionQuestions(sessionID)
        if (entries.length === 0) {
          return {
            ok: false,
            previousFormID: previous.clearedFormID,
            previousRevertStaged: previous.revertStaged,
            error: "No question (Ask) found in this session.",
          }
        }

        const target = resolveTargetEntry(entries, input)
        if (!target) {
          return {
            ok: false,
            previousFormID: previous.clearedFormID,
            previousRevertStaged: previous.revertStaged,
            error: `Target question not found (session has ${entries.length} question${entries.length === 1 ? "" : "s"}).`,
          }
        }

        const shouldRevert = input.revert !== false
        const revertedFromMessageID = shouldRevert ? target.nextMessageID : undefined
        const revertStaged = Boolean(revertedFromMessageID)
        const formID = createReaskFormID()

        pendingForms.set(formID, {
          formID,
          sessionID,
          messageID: target.messageID,
          toolCallID: target.toolCallID,
          index: target.index,
          questions: target.questions,
          revertStaged,
          revertedFromMessageID,
        })
        pendingBySession.set(sessionID, formID)

        return {
          ok: true,
          formID,
          previousFormID: previous.clearedFormID,
          previousRevertStaged: previous.revertStaged,
          messageID: target.messageID,
          toolCallID: target.toolCallID,
          index: target.index,
          questions: target.questions,
          answers: target.answers,
          revertedFromMessageID,
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    const resolveRevertTarget = async (input: ReaskRevertTargetInput): Promise<ReaskRevertTargetOutput> => {
      const { sessionID } = input
      try {
        const previous = popPendingForSession(sessionID)

        await ctx.session.interrupt({ sessionID }).catch(() => {})
        await ctx.session.wait({ sessionID }).catch(() => {})

        const entries = await listSessionQuestions(sessionID)
        const target = resolveTargetEntry(entries, input)
        if (!target) {
          return {
            ok: false,
            previousFormID: previous.clearedFormID,
            previousRevertStaged: previous.revertStaged,
            error: "Target question not found.",
          }
        }

        return {
          ok: true,
          previousFormID: previous.clearedFormID,
          previousRevertStaged: previous.revertStaged,
          revertedFromMessageID: target.nextMessageID,
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    const finalizeRepliedForm = async (
      pending: PendingReaskForm,
      rawAnswer: Record<string, unknown>,
      options: { resumeSession: boolean },
    ): Promise<number> => {
      const answers: string[][] = pending.questions.map((_, idx) => {
        const val = rawAnswer[`q${idx}`]
        if (val === undefined || val === null) return []
        if (Array.isArray(val)) return val.map((v) => String(v)).filter(Boolean)
        const str = String(val).trim()
        return str ? [str] : []
      })

      const formatted = formatQuestionAnswer(pending.questions, answers)
      const overrides = { ...(await loadSessionOverrides(pending.sessionID)) }

      const key = makeKey(pending.messageID, pending.toolCallID)
      overrides[key] = {
        messageID: pending.messageID,
        toolCallID: pending.toolCallID,
        questions: pending.questions,
        answers,
        formatted,
        updatedAt: Date.now(),
      }

      if (pending.revertStaged) {
        const remainingMessages = unwrapMessages(
          await ctx.session.context({ sessionID: pending.sessionID }).catch(() => []),
        )
        const validMessageIDs = new Set(remainingMessages.map((m) => m.id).filter(Boolean))
        for (const [k, v] of Object.entries(overrides)) {
          if (validMessageIDs.size > 0 && !validMessageIDs.has(v.messageID)) {
            delete overrides[k]
          }
        }
      }

      await saveSessionOverrides(pending.sessionID, overrides)

      await rpcRegistration.events
        .emit("replied", {
          sessionID: pending.sessionID,
          messageID: pending.messageID,
          toolCallID: pending.toolCallID,
          index: pending.index,
          answers,
          formatted,
        })
        .catch(() => {})

      const answerSummary = pending.questions
        .map((q, idx) => `${q.header}: ${answers[idx]?.length ? answers[idx].join(", ") : "Unanswered"}`)
        .join(" · ")

      await ctx.session.synthetic({
        sessionID: pending.sessionID,
        text: `${WAKE_PREFIX}\n${formatted}`,
        description: `Re-answered #${pending.index} (${clip(answerSummary, 100)})`,
        metadata: {
          source: "reask",
          messageID: pending.messageID,
          toolCallID: pending.toolCallID,
          index: pending.index,
        },
        resume: options.resumeSession,
      })

      return pending.index
    }

    const rpcRegistration = await ctx.rpc.register(ReaskRpc, {
      list: async (rawInput): Promise<ReaskListOutput> => {
        const input = rawInput as { sessionID: string }
        const items = await listSessionQuestions(input.sessionID)
        return { items }
      },
      prepare: async (rawInput): Promise<ReaskPrepareOutput> => {
        return prepareReask(rawInput as ReaskPrepareInput)
      },
      revertTarget: async (rawInput): Promise<ReaskRevertTargetOutput> => {
        return resolveRevertTarget(rawInput as ReaskRevertTargetInput)
      },
      pending: async (rawInput): Promise<ReaskPendingOutput> => {
        const input = rawInput as ReaskPendingInput
        const pending = pendingForms.get(input.formID)
        if (!pending) return { exists: false }
        return {
          exists: true,
          sessionID: pending.sessionID,
          revertStaged: pending.revertStaged,
        }
      },
      complete: async (rawInput): Promise<ReaskCompleteOutput> => {
        const input = rawInput as ReaskCompleteInput
        const pending = pendingForms.get(input.formID)
        if (!pending) {
          return { ok: false, error: "Pending re-ask form not found or already settled." }
        }
        clearFallbackTimer(input.formID)
        pendingForms.delete(input.formID)
        if (pendingBySession.get(pending.sessionID) === pending.formID) {
          pendingBySession.delete(pending.sessionID)
        }
        try {
          const index = await finalizeRepliedForm(pending, input.answer ?? {}, { resumeSession: true })
          return { ok: true, index }
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      },
      abort: async (rawInput): Promise<ReaskAbortOutput> => {
        const input = rawInput as ReaskAbortInput
        const cleared = popPendingForSession(input.sessionID, input.formID)
        return {
          ok: true,
          clearedFormID: cleared.clearedFormID,
          revertStaged: cleared.revertStaged,
        }
      },
    })

    const onContextHook = async (event: { sessionID: string; messages: unknown[] }) => {
      try {
        const overrides = await loadSessionOverrides(event.sessionID)
        applyContextOverrides(event.messages as ModelMessage[], overrides)
      } catch (error) {
        console.error("[reask] context hook failed", error)
      }
    }

    await ctx.session.hook("context", onContextHook)
    await ctx.session.hook("compaction", onContextHook)
    await ctx.session.hook("generate", onContextHook)

    const eventController = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
          const ev = event as {
            type: string
            data?: {
              id?: string
              sessionID?: string
              answer?: Record<string, unknown>
            }
          }

          if (ev.type === "form.replied" && ev.data?.id) {
            const formID = ev.data.id
            const pending = pendingForms.get(formID)
            if (!pending) continue
            clearFallbackTimer(formID)
            const answer = ev.data.answer ?? {}
            const timer = setTimeout(() => {
              fallbackTimers.delete(formID)
              const current = pendingForms.get(formID)
              if (!current) return
              pendingForms.delete(formID)
              if (pendingBySession.get(current.sessionID) === current.formID) {
                pendingBySession.delete(current.sessionID)
              }
              void finalizeRepliedForm(current, answer, { resumeSession: !current.revertStaged }).catch((error) => {
                console.error("[reask] fallback form.replied handling failed", error)
              })
            }, FALLBACK_REPLY_DELAY_MS)
            fallbackTimers.set(formID, timer)
          }

          if (ev.type === "form.cancelled" && ev.data?.id) {
            const pending = pendingForms.get(ev.data.id)
            if (!pending) continue
            popPendingForSession(pending.sessionID, pending.formID)
          }
        }
      } catch (error) {
        if (!eventController.signal.aborted) {
          console.error("[reask] event loop error", error)
        }
      }
    })()

    await ctx.command.transform((editor) => {
      editor.add({
        name: "reask",
        description: "List Ask entries or run interactive /reask in TUI. Usage: /reask [list|cancel]",
        async execute({ sessionID, prompt }) {
          const raw = (prompt.text ?? "").replace(/^\/?(?:reask|ask-again)\b/i, "").trim()
          const tokens = raw.split(/\s+/).filter(Boolean)
          const head = (tokens[0] ?? "").toLowerCase()

          const notify = async (text: string) => {
            await ctx.session.synthetic({
              sessionID,
              text: `${NOTICE_PREFIX}\n${text}`,
              description: `reask: ${clip(text, 90)}`,
              metadata: { source: "reask" },
              resume: false,
            })
          }

          if (head === "cancel" || head === "clear") {
            const cleared = popPendingForSession(sessionID)
            await notify(
              cleared.clearedFormID
                ? "已清理待重答表单记录（若仍暂存回滚，请在 TUI 中执行 /redo 恢复）。"
                : "当前没有正在进行的重答表单。",
            )
            return
          }

          if (head === "list" || head === "help") {
            const items = await listSessionQuestions(sessionID)
            if (items.length === 0) {
              await notify("当前会话中没有可重新回答的 Ask (question)。")
              return
            }
            const lines = [
              `当前会话共有 ${items.length} 条 Ask：`,
              ...items.map((item) => {
                const statusLabel = item.reanswered ? "已重答" : item.status === "completed" ? "已回答" : "已取消/未完成"
                const qPreview = item.questions.map((q) => q.header || q.question).join(" / ")
                const aPreview = item.answers
                  .map((a, i) => `${item.questions[i]?.header ?? `Q${i + 1}`}=${a.length ? a.join(",") : "未答"}`)
                  .join("; ")
                return `#${item.index} [${statusLabel}] ${clip(qPreview, 60)} -> ${clip(aPreview, 60)}`
              }),
              "",
              "用法: 在 OpenCode TUI 中使用 /reask [编号] [--keep-files] | /reask last | <leader>k",
            ]
            await notify(lines.join("\n"))
            return
          }

          await notify("请在 OpenCode TUI 中使用 /reask、命令面板或快捷键 <leader>k 发起交互式重答。")
        },
      })
    })

    return () => {
      eventController.abort()
      for (const timer of fallbackTimers.values()) clearTimeout(timer)
      fallbackTimers.clear()
      memoryOverrides.clear()
      pendingForms.clear()
      pendingBySession.clear()
    }
  },
})
