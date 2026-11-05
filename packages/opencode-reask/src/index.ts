import { Plugin } from "@opencode/plugin"
import {
  NOTICE_PREFIX,
  WAKE_PREFIX,
  applyContextOverrides,
  buildFormFields,
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
  type ReaskCancelInput,
  type ReaskCancelOutput,
  type ReaskEntry,
  type ReaskListOutput,
  type ReaskRevertInput,
  type ReaskRevertOutput,
  type ReaskStartInput,
  type ReaskStartOutput,
} from "./rpc.ts"

const STORAGE_KEY = "overrides"

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

export { formatQuestionAnswer }

export default Plugin.define({
  id: "reask",
  async setup(ctx) {
    // State belongs to this host/location, never to another plugin instance.
    const memoryOverrides = new Map<string, SessionOverrides>()
    const pendingForms = new Map<string, PendingReaskForm>()
    const pendingBySession = new Map<string, string>()
    const extSession = ctx.session as unknown as {
      revert?: {
        stage?: (input: { sessionID: string; messageID: string; files?: boolean }) => Promise<unknown>
        clear?: (input: { sessionID: string }) => Promise<unknown>
        commit?: (input: { sessionID: string }) => Promise<unknown>
      }
      form?: {
        create?: (input: {
          sessionID: string
          id?: string
          title: string
          metadata?: Record<string, unknown>
          fields: unknown[]
        }) => Promise<unknown>
        cancel?: (input: { sessionID: string; formID: string; message?: string }) => Promise<unknown>
      }
    }

    const stageRevert = async (input: { sessionID: string; messageID: string; files?: boolean }) => {
      if (typeof extSession.revert?.stage === "function") {
        return extSession.revert.stage(input)
      }
      throw new Error("Reask requires a host with session.revert.stage support. Update OpenCode.")
    }

    const clearRevert = async (input: { sessionID: string }) => {
      if (typeof extSession.revert?.clear === "function") {
        return extSession.revert.clear(input)
      }
      throw new Error("Reask requires a host with session.revert.clear support. Update OpenCode.")
    }

    const commitRevert = async (input: { sessionID: string }) => {
      if (typeof extSession.revert?.commit === "function") {
        return extSession.revert.commit(input)
      }
      throw new Error("Reask requires a host with session.revert.commit support. Update OpenCode.")
    }

    const createForm = async (input: {
      sessionID: string
      title: string
      metadata?: Record<string, unknown>
      fields: unknown[]
    }) => {
      if (typeof extSession.form?.create === "function") {
        return extSession.form.create(input)
      }
      throw new Error("Reask requires a host with session.form.create support. Update OpenCode.")
    }

    const cancelForm = async (input: { sessionID: string; formID: string }) => {
      if (typeof extSession.form?.cancel === "function") {
        return extSession.form.cancel(input)
      }
      throw new Error("Reask requires a host with session.form.cancel support. Update OpenCode.")
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

    const cancelExistingPendingForm = async (sessionID: string, shouldClearRevert: boolean): Promise<boolean> => {
      const existingFormID = pendingBySession.get(sessionID)
      if (!existingFormID) return false
      const pending = pendingForms.get(existingFormID)
      pendingBySession.delete(sessionID)
      pendingForms.delete(existingFormID)
      await cancelForm({ sessionID, formID: existingFormID }).catch(() => {})
      if (shouldClearRevert && pending?.revertStaged) {
        await clearRevert({ sessionID }).catch(() => {})
      }
      return true
    }

    const listSessionQuestions = async (sessionID: string): Promise<ReaskEntry[]> => {
      const [rawMessages, overrides] = await Promise.all([
        ctx.session.context({ sessionID }),
        loadSessionOverrides(sessionID),
      ])
      return extractEntries(unwrapMessages(rawMessages), overrides)
    }

    const startReask = async (input: ReaskStartInput): Promise<ReaskStartOutput> => {
      const { sessionID } = input
      try {
        await cancelExistingPendingForm(sessionID, false)

        await ctx.session.interrupt({ sessionID }).catch(() => {})
        await ctx.session.wait({ sessionID }).catch(() => {})

        const entries = await listSessionQuestions(sessionID)
        if (entries.length === 0) {
          return { ok: false, error: "No question (Ask) found in this session." }
        }

        let target: ReaskEntry | undefined
        if (input.messageID && input.toolCallID) {
          target = entries.find((e) => e.messageID === input.messageID && e.toolCallID === input.toolCallID)
        }
        if (!target && input.messageID) {
          target = entries.findLast((e) => e.messageID === input.messageID)
        }
        if (!target && input.toolCallID) {
          target = entries.find((e) => e.toolCallID === input.toolCallID)
        }
        if (!target && typeof input.index === "number") {
          target = entries.find((e) => e.index === input.index)
        }
        if (!target && !input.messageID && !input.toolCallID && input.index === undefined) {
          target = entries.at(-1)
        }

        if (!target) {
          return {
            ok: false,
            error: `Target question not found (session has ${entries.length} question${entries.length === 1 ? "" : "s"}).`,
          }
        }

        const shouldRevert = input.revert !== false
        const revertFiles = input.files !== false
        let revertStaged = false
        let revertedFromMessageID: string | undefined

        if (shouldRevert && target.nextMessageID) {
          await stageRevert({
            sessionID,
            messageID: target.nextMessageID,
            files: revertFiles,
          })
          revertStaged = true
          revertedFromMessageID = target.nextMessageID
        }

        const fields = buildFormFields(target.questions, target.answers)
        const form = await createForm({
          sessionID,
          title: `Questions (Re-ask #${target.index})`,
          metadata: {
            kind: "question",
            reask: {
              messageID: target.messageID,
              toolCallID: target.toolCallID,
              index: target.index,
            },
          },
          fields,
        })

        const formID =
          (form as { id?: string; data?: { id?: string } })?.id ??
          (form as { data?: { id?: string } })?.data?.id
        if (!formID) {
          return { ok: false, error: "Failed to create session form." }
        }

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
          messageID: target.messageID,
          toolCallID: target.toolCallID,
          index: target.index,
          revertedFromMessageID,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: message }
      }
    }

    const revertOnly = async (input: ReaskRevertInput): Promise<ReaskRevertOutput> => {
      const { sessionID } = input
      try {
        await cancelExistingPendingForm(sessionID, false)
        await ctx.session.interrupt({ sessionID }).catch(() => {})
        await ctx.session.wait({ sessionID }).catch(() => {})

        const entries = await listSessionQuestions(sessionID)
        let target: ReaskEntry | undefined
        if (input.messageID && input.toolCallID) {
          target = entries.find((e) => e.messageID === input.messageID && e.toolCallID === input.toolCallID)
        } else if (input.messageID) {
          target = entries.findLast((e) => e.messageID === input.messageID)
        } else if (typeof input.index === "number") {
          target = entries.find((e) => e.index === input.index)
        } else {
          target = entries.at(-1)
        }

        if (!target) {
          return { ok: false, error: "Target question not found." }
        }
        if (!target.nextMessageID) {
          return { ok: true, revertedFromMessageID: undefined }
        }

        await stageRevert({
          sessionID,
          messageID: target.nextMessageID,
          files: input.files !== false,
        })
        return { ok: true, revertedFromMessageID: target.nextMessageID }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    const rpcRegistration = await ctx.rpc.register(ReaskRpc, {
      list: async (rawInput): Promise<ReaskListOutput> => {
        const input = rawInput as { sessionID: string }
        const items = await listSessionQuestions(input.sessionID)
        return { items }
      },
      start: async (rawInput): Promise<ReaskStartOutput> => {
        return startReask(rawInput as ReaskStartInput)
      },
      revertOnly: async (rawInput): Promise<ReaskRevertOutput> => {
        return revertOnly(rawInput as ReaskRevertInput)
      },
      cancel: async (rawInput): Promise<ReaskCancelOutput> => {
        const input = rawInput as ReaskCancelInput
        const cancelled = await cancelExistingPendingForm(input.sessionID, true)
        return {
          ok: true,
          message: cancelled ? "Cancelled pending re-ask and restored session state." : "No pending re-ask form.",
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
            const pending = pendingForms.get(ev.data.id)
            if (!pending) continue
            pendingForms.delete(ev.data.id)
            if (pendingBySession.get(pending.sessionID) === pending.formID) {
              pendingBySession.delete(pending.sessionID)
            }

            const rawAnswer = ev.data.answer ?? {}
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
              await commitRevert({ sessionID: pending.sessionID }).catch(() => {})
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
              resume: true,
            })
          }

          if (ev.type === "form.cancelled" && ev.data?.id) {
            const pending = pendingForms.get(ev.data.id)
            if (!pending) continue
            pendingForms.delete(ev.data.id)
            if (pendingBySession.get(pending.sessionID) === pending.formID) {
              pendingBySession.delete(pending.sessionID)
            }
            if (pending.revertStaged) {
              await clearRevert({ sessionID: pending.sessionID }).catch(() => {})
            }
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
        description: "Re-answer a submitted or cancelled question (Ask). Usage: /reask [last|list|<n> [--keep-files]|cancel]",
        async execute({ sessionID, prompt }) {
          const raw = (prompt.text ?? "").replace(/^\/?(?:reask|ask-again)\b/i, "").trim()
          const tokens = raw.split(/\s+/).filter(Boolean)
          const head = (tokens[0] ?? "").toLowerCase()
          const keepFiles = tokens.some((t) => t === "--keep-files" || t === "--no-files")
          const noRevert = tokens.some((t) => t === "--no-revert")

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
            const cancelled = await cancelExistingPendingForm(sessionID, true)
            await notify(cancelled ? "已取消重答并恢复回滚前的会话状态。" : "当前没有正在进行的重答表单。")
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
              "用法: /reask [编号] [--keep-files] | /reask last | /reask cancel",
            ]
            await notify(lines.join("\n"))
            return
          }

          const indexNum = head && head !== "last" && head !== "latest" ? Number(head) : undefined
          if (indexNum !== undefined && (!Number.isInteger(indexNum) || indexNum < 1)) {
            await notify("参数无效。用法: /reask [编号] [--keep-files] | /reask list | /reask cancel")
            return
          }

          const res = await startReask({
            sessionID,
            ...(indexNum !== undefined ? { index: indexNum } : {}),
            revert: !noRevert,
            files: !keepFiles,
          })
          if (!res.ok) {
            await notify(res.error ?? "无法启动重答表单。")
          }
        },
      })
    })

    return () => {
      eventController.abort()
      memoryOverrides.clear()
      pendingForms.clear()
      pendingBySession.clear()
    }
  },
})
