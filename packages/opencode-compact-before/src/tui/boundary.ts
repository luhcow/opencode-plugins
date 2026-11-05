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
import { activeCheckpointID, errorText, findCheckpoint, resolveCheckpoint, visibleHistory } from "../core.ts"

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

/** Native 2.2.x gives text user rows and first assistant rows their message ID, and assistant
 * part rows `session-part:${messageID}:${partID}`. Attachment-only user rows have no ID;
 * locate those by their ordinal relative to the other user rows in the same mounted timeline. */
function boundaryRow(context: Context, boundary: Boundary, contents: Set<Renderable>, nodes: Renderable[]) {
  const all = context.data.session.message.list(boundary.sessionID)
  const revertID = context.data.session.get(boundary.sessionID)?.revert?.messageID
  const messages = visibleHistory(all, revertID)
  if (
    messages.length !== all.length &&
    all.some((message) => message.id === boundary.beforeID) &&
    !messages.some((message) => message.id === boundary.beforeID)
  ) {
    return
  }
  const direct = context.renderer.root.findDescendantById(boundary.beforeID)
  if (direct) return timelineRow(direct, contents) ?? direct
  const part = nodes.find((node) => node.id.startsWith(`session-part:${boundary.beforeID}:`))
  if (part) return timelineRow(part, contents) ?? part
  const users = messages.filter((message) => message.type === "user")
  const index = users.findIndex((message) => message.id === boundary.beforeID)
  if (index < 0) return
  const nonUsers = new Set(messages.filter((message) => message.type !== "user").map((message) => message.id))
  for (const content of contents) {
    const rows = content.getChildren().filter((row) => {
      if (row.id.startsWith("session-part:") || nonUsers.has(row.id)) return false
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
    const contents = new Set<Renderable>(
      nodes
        .filter((node) => node instanceof ScrollBoxRenderable)
        .map((node) => (node.content instanceof BoxRenderable ? node.content : node)),
    )
    const target = boundaryRow(context, boundary, contents, nodes)
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

    const replaced = Boolean(target && view && !view.isDestroyed && view.parent === target)
    // Compaction rows have no message ID in 2.2.x. Identify the native summary by its
    // Markdown body and Compaction heading; the plugin's copy lives inside the target row.
    const originals = replaced
      ? nodes.flatMap((node) => {
          if (!(node instanceof MarkdownRenderable) || node.content !== boundary.checkpoint.summary.trim()) return []
          const row = timelineRow(node, contents)
          if (!row || row === target) return []
          return [...descendants(row)].some(
            (child) => child instanceof TextRenderable && child.plainText === "Compaction",
          )
            ? [row]
            : []
        })
      : []
    const original = originals.at(-1)
    for (const [row, visible] of hidden) {
      if (row.isDestroyed) {
        hidden.delete(row)
        continue
      }
      if (!replaced || row !== original) {
        row.visible = visible
        hidden.delete(row)
      }
    }
    if (replaced && original && !hidden.has(original)) {
      hidden.set(original, original.visible)
      original.visible = false
    }
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
        revision()
        const route = context.ui.router.current()
        if (route.type !== "session") return
        return activeCheckpointID(
          context.data.session.message.list(route.sessionID),
          context.data.session.get(route.sessionID)?.revert?.messageID,
        )
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
            const checkpoint = findCheckpoint(
              page.data.filter(
                (message): message is Checkpoint => message.type === "compaction" && message.status === "completed",
              ),
              checkpointID,
            )
            if (checkpoint) {
              const resolved = resolveCheckpoint(checkpoint)
              return resolved?.kind === "boundary"
                ? { sessionID, checkpoint, beforeID: resolved.beforeID }
                : undefined
            }
            if (!page.data.length) return
            cursor = page.cursor.next ?? undefined
          } while (cursor)
        },
      )
      const stops = (
        [
          "session.compaction.ended",
          "session.revert.staged",
          "session.revert.committed",
          "session.revert.cleared",
        ] as const
      ).map((type) =>
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
