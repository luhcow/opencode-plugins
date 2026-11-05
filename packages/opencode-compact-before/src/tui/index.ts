import { Plugin } from "@opencode/plugin/tui"
import { errorText, prefixTranscript, visibleHistory, type Message } from "../core.ts"
import { CompactBeforeRpc } from "../rpc.ts"
import { installBoundaryView } from "./boundary.ts"

export default Plugin.define({
  id: "compact-before.tui",
  setup(context) {
    const rpc = context.client.rpc(CompactBeforeRpc)

    const select = async () => {
      const route = context.ui.router.current()
      if (route.type !== "session") return
      const sessionID = route.sessionID
      const location =
        context.data.session.get(sessionID)?.location ?? context.location ?? context.data.location.default()
      const reads = { headers: { "x-opencode-capabilities": "experimental-media-uri" } }
      const list = async (type?: "user") => {
        const messages: Message[] = []
        let cursor: string | undefined
        do {
          const page = await context.client.message.list(
            cursor ? { sessionID, type, cursor } : { sessionID, type, order: "asc" },
            reads,
          )
          messages.push(...page.data)
          if (page.data.length === 0) break
          cursor = page.cursor.next ?? undefined
        } while (cursor)
        return messages
      }

      try {
        context.ui.toast.show({ message: "正在读取用户消息…", variant: "info" })
        const session = await context.client.session.get({ sessionID })
        const users = session.revert
          ? visibleHistory(await list(), session.revert.messageID).filter((message) => message.type === "user")
          : await list("user")
        const beforeID = await context.ui.dialog.select({
          title: session.revert ? "Compact before · 按撤销后的历史压缩" : "Compact before · 压缩所选消息之前",
          options: users
            .map((message, index) => ({
              title: `#${index + 1}  ${message.text?.replace(/\s+/g, " ").trim() || "（附件消息）"}`,
              value: message.id,
              description: session.revert ? "确认当前撤销，保留此条及之后的有效对话" : "保留此条及之后的对话",
            }))
            .reverse(),
        })
        if (!beforeID) return
        context.ui.toast.show({ message: "正在读取需要压缩的历史…", variant: "info" })
        await context.client.session.message.get({ sessionID, messageID: beforeID }, reads)
        const current = await context.client.session.get({ sessionID })
        const messages = visibleHistory(await list(), current.revert?.messageID)
        await rpc.start({ sessionID, beforeID, transcript: prefixTranscript(messages, beforeID) }, { location })
        context.ui.toast.show({ title: "Compact before", message: "已提交原生压缩。", variant: "success" })
      } catch (error) {
        context.ui.toast.show({ title: "Compact before", message: errorText(error), variant: "error" })
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "compact-before.select",
          title: "Compact history before a message",
          group: "Session",
          palette: true,
          bind: "ctrl+alt+c",
          slash: { name: "compact-before" },
          enabled: () => context.ui.router.current().type === "session",
          run: select,
        },
      ],
      bindings: ["compact-before.select"],
    }))
    return installBoundaryView(context)
  },
})
