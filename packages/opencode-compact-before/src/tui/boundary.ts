import type { SessionMessageInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  TextRenderable,
  type Renderable,
} from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { errorText } from "../core.ts"

type Checkpoint = Extract<SessionMessageInfo, { type: "compaction"; status: "completed" }>
type Boundary = { sessionID: string; checkpoint: Checkpoint; beforeID: string }

function* descendants(node: Renderable): Generator<Renderable> {
  yield node
  for (const child of node.getChildren()) yield* descendants(child)
}

function timelineRow(node: Renderable, contents: Set<Renderable>): Renderable | undefined {
  let row = node
  while (row.parent && !contents.has(row.parent)) row = row.parent
  return row.parent && contents.has(row.parent) ? row : undefined
}

/** Native 2.2.x gives text user rows their message ID. Attachment-only rows have no ID;
 * locate those by their ordinal relative to the other user rows in the same mounted timeline. */
function boundaryRow(context: Context, boundary: Boundary, contents: Set<Renderable>) {
  const direct = context.renderer.root.findDescendantById(boundary.beforeID)
  if (direct) return direct
  const users = context.data.session.message.list(boundary.sessionID).filter((message) => message.type === "user")
  const index = users.findIndex((message) => message.id === boundary.beforeID)
  if (index < 0) return
  for (const content of contents) {
    const rows = content.getChildren().filter((row) => {
      const body = row.getChildren().find((child) => !child.id.startsWith("compact-before-boundary:"))
      return body instanceof BoxRenderable && Array.isArray(body.border) && body.border.join() === "left"
    })
    const anchor = rows.findIndex((row) => users.some((user) => user.id === row.id))
    if (anchor >= 0) {
      const offset = users.findIndex((user) => user.id === rows[anchor].id) - anchor
      return rows[index - offset]
    }
    if (rows.length === users.length) return rows[index]
  }
}

function projectBoundary(context: Context, boundary: Boundary) {
  const renderer = context.renderer
  const syntax = SyntaxStyle.fromStyles(
    {
      default: { fg: context.theme.markdown.text },
      "markup.heading": { fg: context.theme.markdown.heading, bold: true },
      "markup.strong": { fg: context.theme.markdown.strong, bold: true },
      "markup.italic": { fg: context.theme.markdown.emphasis, italic: true },
      "markup.raw": { fg: context.theme.markdown.code },
      "markup.link": { fg: context.theme.markdown.link, underline: true },
    },
    renderer.nativeScene,
  )
  const hidden = new Map<Renderable, boolean>()
  let view: BoxRenderable | undefined
  const viewID = `compact-before-boundary:${boundary.checkpoint.id}`

  const refresh = () => {
    const nodes = [...descendants(renderer.root)]
    const contents = new Set(nodes.filter((node) => node instanceof ScrollBoxRenderable).map((node) => node.content))
    const target = boundaryRow(context, boundary, contents)
    if (view?.isDestroyed) view = undefined
    if (view && view.parent !== target) {
      view.destroyRecursively()
      view = undefined
    }
    if (target && !view) {
      view = new BoxRenderable(renderer, {
        id: viewID,
        flexDirection: "column",
        flexShrink: 0,
        marginBottom: 1,
        border: ["top", "bottom"],
        borderColor: context.theme.text.feedback.info.base,
        paddingX: 2,
        paddingY: 1,
      })
      view.add(
        new TextRenderable(renderer, {
          content: "Compact before · 以上历史已总结",
          fg: context.theme.text.feedback.info.base,
          marginBottom: 1,
        }),
      )
      view.add(
        new MarkdownRenderable(renderer, {
          content: boundary.checkpoint.summary,
          syntaxStyle: syntax,
          streaming: false,
          internalBlockMode: "top-level",
          tableOptions: { style: "grid", cellPaddingX: 1 },
          fg: context.theme.markdown.text,
          bg: context.theme.background.base,
        }),
      )
      view.add(
        new TextRenderable(renderer, {
          content: "↓ 从下面这条消息开始保留在上下文中",
          fg: context.theme.text.feedback.info.base,
          marginTop: 1,
        }),
      )
      target.add(view, 0)
    }

    // Compaction rows have no message ID in 2.2.x. Identify the native summary by its
    // Markdown body and Compaction heading; the plugin's copy lives inside the user row.
    const originals = nodes.flatMap((node) => {
      if (!(node instanceof MarkdownRenderable) || node.content !== boundary.checkpoint.summary.trim()) return []
      const row = timelineRow(node, contents)
      if (!row || row === target) return []
      return [...descendants(row)].some((child) => child instanceof TextRenderable && child.plainText === "Compaction")
        ? [row]
        : []
    })
    const original = originals.at(-1)
    if (original && !hidden.has(original)) {
      hidden.set(original, original.visible)
      original.visible = false
    }
    for (const row of hidden.keys()) if (row.isDestroyed) hidden.delete(row)
  }

  renderer.on("frame", refresh)
  refresh()
  return () => {
    renderer.off("frame", refresh)
    view?.destroyRecursively()
    for (const [row, visible] of hidden) if (!row.isDestroyed) row.visible = visible
    void renderer.idle().then(() => syntax.destroy())
  }
}

export function installBoundaryView(context: Context) {
  return context.ui.slot({
    append: "app",
    render: () => {
      const [revision, update] = createSignal(0)
      // New routes include optimistic sessions that do not exist on the server yet.
      // Follow native timeline hydration; only a completed checkpoint needs a boundary view.
      const checkpointID = createMemo(() => {
        const route = context.ui.router.current()
        if (route.type !== "session") return
        return context.data.session.message
          .list(route.sessionID)
          .findLast((message) => message.type === "compaction" && message.status === "completed")?.id
      })
      const [boundary] = createResource(
        () => {
          const route = context.ui.router.current()
          return route.type === "session"
            ? { sessionID: route.sessionID, checkpointID: checkpointID(), revision: revision() }
            : undefined
        },
        async ({ sessionID, checkpointID }): Promise<Boundary | undefined> => {
          if (!checkpointID) return
          let cursor: string | undefined
          do {
            const page = await context.client.message.list(
              cursor ? { sessionID, type: "compaction", cursor } : { sessionID, type: "compaction", order: "desc" },
            )
            const checkpoint = page.data.find(
              (message): message is Checkpoint => message.type === "compaction" && message.status === "completed",
            )
            if (checkpoint) {
              const beforeID = checkpoint.metadata?.keepID
              return checkpoint.metadata?.compactBefore && typeof beforeID === "string"
                ? { sessionID, checkpoint, beforeID }
                : undefined
            }
            if (!page.data.length) return
            cursor = page.cursor.next ?? undefined
          } while (cursor)
        },
      )
      const stops = (["session.compaction.ended", "session.revert.committed", "session.revert.cleared"] as const).map(
        (type) =>
          context.data.on(type, (event) => {
            const route = context.ui.router.current()
            if (route.type === "session" && route.sessionID === event.data.sessionID) update((value) => value + 1)
          }),
      )
      onCleanup(() => stops.forEach((stop) => stop()))
      createEffect(() => {
        if (boundary.error) {
          context.ui.toast.show({ title: "Compact before", message: errorText(boundary.error), variant: "error" })
          return
        }
        const value = boundary()
        const route = context.ui.router.current()
        if (value && route.type === "session" && route.sessionID === value.sessionID) {
          onCleanup(projectBoundary(context, value))
        }
      })
      return null
    },
  })
}
