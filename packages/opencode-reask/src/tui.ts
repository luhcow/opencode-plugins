import { Plugin } from "@opencode/plugin/tui"
import { ReaskRpc, type QuestionItem, type ReaskEntry, type ReaskListOutput, type ReaskStartOutput, type ReaskRevertOutput, type ReaskCancelOutput } from "./rpc.ts"

type RenderableLike = {
  id?: string
  num?: number
  isDestroyed?: boolean
  parent?: RenderableLike | null
  backgroundColor?: unknown
  _backgroundColor?: unknown
  border?: unknown
  _border?: unknown
  getChildren?: () => RenderableLike[]
  onMouseUp?: (event: MouseEventLike) => void
  onMouseOver?: (event: MouseEventLike) => void
  onMouseOut?: (event: MouseEventLike) => void
  _mouseListeners?: {
    up?: (event: MouseEventLike) => void
    over?: (event: MouseEventLike) => void
    out?: (event: MouseEventLike) => void
  }
}

type MouseEventLike = {
  type?: string
  button?: number
  target?: RenderableLike | null
  currentTarget?: RenderableLike | null
  defaultPrevented?: boolean
  propagationStopped?: boolean
}

type QuestionHit = {
  sessionID: string
  messageID: string
  toolCallID: string
  rowNode: RenderableLike
  cardNode?: RenderableLike
}

function clip(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return normalized.slice(0, limit - 1) + "…"
}

function formatEntryTitle(entry: ReaskEntry): string {
  const headers = entry.questions.map((q) => q.header || q.question).join(" / ")
  const firstQuestion = entry.questions[0]?.question ?? ""
  return `#${entry.index}  [${clip(headers, 36)}] ${clip(firstQuestion, 64)}`
}

function formatEntryDescription(entry: ReaskEntry): string {
  if (entry.status === "cancelled") {
    return "✗ 已取消 / 对话中断（未完成回答）"
  }
  const summary = entry.questions
    .map((q, idx) => {
      const ans = entry.answers[idx]
      return `${q.header || `Q${idx + 1}`}: ${ans?.length ? ans.join(", ") : "未答"}`
    })
    .join(" · ")
  return `${entry.reanswered ? "↻ 已重答" : "✓ 已回答"} — ${clip(summary, 90)}`
}

function findCardBox(root: RenderableLike): RenderableLike | undefined {
  const queue: RenderableLike[] = [root]
  let visited = 0
  while (queue.length > 0 && visited < 40) {
    const current = queue.shift()!
    visited++
    if (current !== root && (current.border || current._border || current.backgroundColor || current._backgroundColor)) {
      return current
    }
    const children = current.getChildren?.() ?? []
    for (const child of children) {
      if (child && !child.isDestroyed) queue.push(child)
    }
  }
  return undefined
}

export default Plugin.define({
  id: "reask.tui",
  setup(context) {
    const rpc = context.client.rpc(ReaskRpc)
    let dialogOpen = false

    const getActiveSessionID = (): string | undefined => {
      const route = context.ui.router.current() as { type?: string; sessionID?: string } | undefined
      if (route?.type === "session" && route.sessionID && route.sessionID !== "dummy") {
        return route.sessionID
      }
      return undefined
    }

    const getLocationForSession = (sessionID?: string) => {
      if (sessionID) {
        const session = context.data.session.get(sessionID) as { location?: { directory: string } } | undefined
        if (session?.location) return session.location
      }
      return context.location ?? context.data.location.default()
    }

    const listLocalQuestions = (sessionID: string): ReaskEntry[] => {
      const messages = context.data.session.message.list(sessionID) ?? []
      const entries: ReaskEntry[] = []
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i] as {
          id: string
          type: string
          time?: { created?: number }
          content?: Array<{
            type: string
            id?: string
            name?: string
            time?: { created?: number }
            state?: {
              status?: string
              input?: { questions?: QuestionItem[] }
              metadata?: { answers?: string[][] }
            }
          }>
        }
        if (msg?.type !== "assistant" || !Array.isArray(msg.content)) continue
        const nextMsg = messages[i + 1] as { id?: string } | undefined
        for (const part of msg.content) {
          if (part.type !== "tool" || part.name?.toLowerCase() !== "question" || !part.id) continue
          const questions = Array.isArray(part.state?.input?.questions) ? part.state.input.questions : []
          if (questions.length === 0) continue
          const rawAnswers = part.state?.metadata?.answers
          const answers = Array.isArray(rawAnswers)
            ? questions.map((_, idx) => {
                const a = rawAnswers[idx]
                return Array.isArray(a) ? a.map(String) : typeof a === "string" ? [a] : []
              })
            : questions.map(() => [])
          const status =
            part.state?.status === "completed"
              ? "completed"
              : part.state?.status === "running" || part.state?.status === "streaming"
                ? "running"
                : "cancelled"
          entries.push({
            index: entries.length + 1,
            messageID: msg.id,
            toolCallID: part.id,
            nextMessageID: nextMsg?.id,
            status,
            reanswered: false,
            questions,
            answers,
            createdAt: part.time?.created ?? msg.time?.created ?? Date.now(),
          })
        }
      }
      return entries
    }

    const fetchQuestions = async (sessionID: string): Promise<ReaskEntry[]> => {
      try {
        const res = await rpc.list({ sessionID }, { location: getLocationForSession(sessionID) }) as ReaskListOutput
        if (res?.items && Array.isArray(res.items)) {
          return res.items as ReaskEntry[]
        }
      } catch {
        // Fallback to TUI local cache
      }
      return listLocalQuestions(sessionID)
    }

    const triggerReask = async (input: {
      sessionID: string
      messageID?: string
      toolCallID?: string
      index?: number
      revert?: boolean
      files?: boolean
    }) => {
      context.ui.dialog.clear()
      dialogOpen = false
      try {
        const res = await rpc.start(input, { location: getLocationForSession(input.sessionID) }) as ReaskStartOutput
        if (!res.ok) {
          context.ui.toast.show({
            title: "Re-ask",
            message: res.error ?? "Failed to open question form",
            variant: "error",
            duration: 4000,
          })
          return
        }
        await context.data.session.form.sync(input.sessionID, getLocationForSession(input.sessionID)).catch(() => {})
        await context.data.session.sync(input.sessionID).catch(() => {})
      } catch (error) {
        context.ui.toast.show({
          title: "Re-ask failed",
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
          duration: 4000,
        })
      }
    }

    const triggerRevertOnly = async (input: {
      sessionID: string
      messageID?: string
      toolCallID?: string
      index?: number
      files?: boolean
    }) => {
      context.ui.dialog.clear()
      dialogOpen = false
      try {
        const res = await rpc.revertOnly(input, { location: getLocationForSession(input.sessionID) }) as ReaskRevertOutput
        if (!res.ok) {
          context.ui.toast.show({
            title: "Revert failed",
            message: res.error ?? "Could not stage revert",
            variant: "error",
            duration: 4000,
          })
          return
        }
        await context.data.session.sync(input.sessionID).catch(() => {})
        context.ui.toast.show({
          title: "Reverted",
          message: "Staged revert after selected question. Use /redo to restore.",
          variant: "info",
          duration: 3000,
        })
      } catch (error) {
        context.ui.toast.show({
          title: "Revert failed",
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
          duration: 4000,
        })
      }
    }

    const showQuestionPreview = async (sessionID: string, entry: ReaskEntry) => {
      const lines = entry.questions.flatMap((q, idx) => {
        const ans = entry.answers[idx]
        const ansText = ans?.length ? ans.join(", ") : "(未回答)"
        const opts = q.options.map((o, oi) => `  ${oi + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`)
        return [`[${q.header}] ${q.question}`, `当前回答: ${ansText}`, ...opts, ""]
      })
      await context.ui.dialog.alert({
        title: `Question #${entry.index} Details`,
        message: lines.join("\n").trim(),
      })
      await openQuestionActionsDialog(sessionID, entry)
    }

    const openQuestionActionsDialog = async (sessionID: string, entry: ReaskEntry) => {
      dialogOpen = true
      try {
        context.ui.dialog.set({ size: "medium", centered: true })
        const firstQ = clip(entry.questions.map((q) => q.header || q.question).join(" / "), 48)
        const choice = await context.ui.dialog.select({
          title: `Question #${entry.index} Actions (${firstQ})`,
          options: [
            {
              title: "Re-answer & Revert",
              value: "reask.revert",
              description: "回滚该问答之后的对话与文件改动，并在底部重新弹出问答表单",
            },
            {
              title: "Re-answer (Keep files)",
              value: "reask.keep_files",
              description: "仅回滚该问答之后的对话（保留文件修改），并重新弹出问答表单",
            },
            {
              title: "Revert only",
              value: "revert.only",
              description: "仅回滚到该问答之后（可通过 /redo 恢复）",
            },
            {
              title: "View details",
              value: "details",
              description: "查看完整问题、选项与上次回答详情",
            },
          ],
        })

        if (!choice) return
        if (choice === "reask.revert") {
          await triggerReask({
            sessionID,
            messageID: entry.messageID,
            toolCallID: entry.toolCallID,
            index: entry.index,
            revert: true,
            files: true,
          })
        } else if (choice === "reask.keep_files") {
          await triggerReask({
            sessionID,
            messageID: entry.messageID,
            toolCallID: entry.toolCallID,
            index: entry.index,
            revert: true,
            files: false,
          })
        } else if (choice === "revert.only") {
          await triggerRevertOnly({
            sessionID,
            messageID: entry.messageID,
            toolCallID: entry.toolCallID,
            index: entry.index,
            files: true,
          })
        } else if (choice === "details") {
          await showQuestionPreview(sessionID, entry)
        }
      } finally {
        dialogOpen = false
      }
    }

    const openSelectDialog = async (sessionID: string) => {
      const items = await fetchQuestions(sessionID)
      if (items.length === 0) {
        context.ui.toast.show({
          title: "Re-ask",
          message: "当前会话中没有 Ask (question) 记录",
          variant: "info",
          duration: 3000,
        })
        return
      }

      dialogOpen = true
      try {
        context.ui.dialog.set({ size: "large", centered: true })
        const byKey = new Map<string, ReaskEntry>()
        const options = items
          .slice()
          .reverse()
          .map((entry) => {
            const key = `${entry.messageID}:${entry.toolCallID}`
            byKey.set(key, entry)
            return {
              title: formatEntryTitle(entry),
              value: key,
              description: formatEntryDescription(entry),
              category: entry.reanswered
                ? "Re-answered"
                : entry.status === "completed"
                  ? "Answered"
                  : "Cancelled / Unanswered",
            }
          })

        let actionHandled = false
        const selectedKey = await context.ui.dialog.select({
          title: "Select Question (Ask) to Re-answer",
          placeholder: "Search questions...",
          options,
          actions: [
            {
              bind: "ctrl+k",
              title: "Keep files & Re-answer",
              onTrigger: (val) => {
                const entry = byKey.get(val)
                if (!entry) return
                actionHandled = true
                void triggerReask({
                  sessionID,
                  messageID: entry.messageID,
                  toolCallID: entry.toolCallID,
                  index: entry.index,
                  revert: true,
                  files: false,
                })
              },
            },
            {
              bind: "ctrl+o",
              title: "More actions",
              onTrigger: (val) => {
                const entry = byKey.get(val)
                if (!entry) return
                actionHandled = true
                context.ui.dialog.clear()
                void openQuestionActionsDialog(sessionID, entry)
              },
            },
          ],
        })

        if (actionHandled || !selectedKey) return
        const selected = byKey.get(selectedKey)
        if (!selected) return

        await triggerReask({
          sessionID,
          messageID: selected.messageID,
          toolCallID: selected.toolCallID,
          index: selected.index,
          revert: true,
          files: true,
        })
      } finally {
        dialogOpen = false
      }
    }

    const unsubReplied = rpc.events.on("replied", (event) => {
      const data = event.data as {
        sessionID: string
        index: number
        answers: string[][]
      }
      const currentSessionID = getActiveSessionID()
      if (currentSessionID && currentSessionID === data.sessionID) {
        context.ui.toast.show({
          title: `Re-answered Ask #${data.index}`,
          message: "已更新回答并继续执行",
          variant: "success",
          duration: 2500,
        })
      }
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "reask.select",
          title: "Select question (Ask) to re-answer...",
          group: "Session",
          bind: "<leader>k",
          palette: true,
          slash: { name: "reask", aliases: ["ask-again"], arguments: true },
          enabled: () => Boolean(getActiveSessionID()),
          run: async (rawArgs) => {
            const sessionID = getActiveSessionID()
            if (!sessionID) return
            const argText = (rawArgs ?? "").trim()
            if (!argText || argText === "select" || argText === "list") {
              await openSelectDialog(sessionID)
              return
            }
            const tokens = argText.split(/\s+/).filter(Boolean)
            const head = (tokens[0] ?? "").toLowerCase()
            const keepFiles = tokens.some((t) => t === "--keep-files" || t === "--no-files")
            const noRevert = tokens.some((t) => t === "--no-revert")

            if (head === "cancel" || head === "clear") {
              const res = await rpc.cancel({ sessionID }, { location: getLocationForSession(sessionID) }) as ReaskCancelOutput
              context.ui.toast.show({
                title: "Re-ask",
                message: res.message ?? "Cancelled",
                variant: "info",
                duration: 2500,
              })
              return
            }

            if (head === "last" || head === "latest") {
              await triggerReask({ sessionID, revert: !noRevert, files: !keepFiles })
              return
            }

            const indexNum = Number(head)
            if (Number.isInteger(indexNum) && indexNum >= 1) {
              await triggerReask({
                sessionID,
                index: indexNum,
                revert: !noRevert,
                files: !keepFiles,
              })
              return
            }

            await openSelectDialog(sessionID)
          },
        },
        {
          id: "reask.last",
          title: "Re-answer last question (Ask)",
          group: "Session",
          bind: "<leader>shift+k",
          palette: true,
          slash: { name: "reask-last" },
          enabled: () => Boolean(getActiveSessionID()),
          run: async () => {
            const sessionID = getActiveSessionID()
            if (!sessionID) return
            await triggerReask({ sessionID, revert: true, files: true })
          },
        },
      ],
      bindings: ["reask.select", "reask.last"],
    }))

    const findQuestionHit = (target: RenderableLike | null | undefined): QuestionHit | undefined => {
      const sessionID = getActiveSessionID()
      if (!sessionID || !target) return undefined

      let node: RenderableLike | null | undefined = target
      while (node && !node.isDestroyed) {
        const id = node.id
        if (typeof id === "string") {
          if (id.startsWith("session-part:")) {
            const firstColon = id.indexOf(":")
            const secondColon = id.indexOf(":", firstColon + 1)
            if (secondColon > firstColon) {
              const messageID = id.slice(firstColon + 1, secondColon)
              const partID = id.slice(secondColon + 1)
              const msg = context.data.session.message.get(sessionID, messageID) as
                | {
                    type?: string
                    content?: Array<{ type?: string; id?: string; name?: string }>
                  }
                | undefined
              if (msg?.type === "assistant" && Array.isArray(msg.content)) {
                const part = msg.content.find((p) => p.type === "tool" && p.id === partID)
                if (part && part.name?.toLowerCase() === "question") {
                  return {
                    sessionID,
                    messageID,
                    toolCallID: partID,
                    rowNode: node,
                    cardNode: findCardBox(node),
                  }
                }
              }
            }
          }

          if (id.startsWith("msg_")) {
            const msg = context.data.session.message.get(sessionID, id) as
              | {
                  type?: string
                  content?: Array<{ type?: string; id?: string; name?: string; text?: string }>
                }
              | undefined
            if (msg?.type === "assistant" && Array.isArray(msg.content)) {
              const firstToolOrText = msg.content.find(
                (p) => (p.type === "text" && p.text?.trim()) || p.type === "tool",
              )
              const firstPart = msg.content[0]
              const candidate =
                firstPart?.type === "tool" && firstPart.name?.toLowerCase() === "question"
                  ? firstPart
                  : firstToolOrText?.type === "tool" && firstToolOrText.name?.toLowerCase() === "question"
                    ? firstToolOrText
                    : undefined
              if (candidate?.id) {
                return {
                  sessionID,
                  messageID: id,
                  toolCallID: candidate.id,
                  rowNode: node,
                  cardNode: findCardBox(node),
                }
              }
            }
          }
        }
        node = node.parent
      }
      return undefined
    }

    const root = context.renderer.root as unknown as RenderableLike
    let hoveredCard: RenderableLike | undefined

    const clearHoveredCard = () => {
      if (hoveredCard && !hoveredCard.isDestroyed) {
        try {
          hoveredCard.backgroundColor = context.theme.background.raised.base
        } catch {
          // ignore
        }
      }
      hoveredCard = undefined
    }

    const prevMouseOver = root._mouseListeners?.over
    const prevMouseOut = root._mouseListeners?.out
    const prevMouseUp = root._mouseListeners?.up

    root.onMouseOver = (event: MouseEventLike) => {
      prevMouseOver?.call(root, event)
      if (dialogOpen) return
      const hit = findQuestionHit(event.target)
      if (hit?.cardNode && hit.cardNode !== hoveredCard) {
        clearHoveredCard()
        hoveredCard = hit.cardNode
        try {
          hoveredCard.backgroundColor = context.theme.decrease(context.theme.background.raised.base)
        } catch {
          // ignore
        }
      } else if (!hit && hoveredCard) {
        clearHoveredCard()
      }
    }

    root.onMouseOut = (event: MouseEventLike) => {
      prevMouseOut?.call(root, event)
      if (hoveredCard) {
        clearHoveredCard()
      }
    }

    root.onMouseUp = (event: MouseEventLike) => {
      prevMouseUp?.call(root, event)
      if (dialogOpen) return
      if (event.button !== undefined && event.button !== 0) return
      const renderer = context.renderer as unknown as {
        getSelection?: () => { getSelectedText?: () => string } | null
      }
      if (renderer.getSelection?.()?.getSelectedText?.()) return

      const hit = findQuestionHit(event.target)
      if (!hit) return

      clearHoveredCard()
      void (async () => {
        const items = await fetchQuestions(hit.sessionID)
        const entry =
          items.find((e) => e.messageID === hit.messageID && e.toolCallID === hit.toolCallID) ??
          items.findLast((e) => e.messageID === hit.messageID)
        if (!entry) return
        await openQuestionActionsDialog(hit.sessionID, entry)
      })()
    }

    return () => {
      unsubReplied()
      clearHoveredCard()
      root.onMouseOver = prevMouseOver
      root.onMouseOut = prevMouseOut
      root.onMouseUp = prevMouseUp
    }
  },
})
