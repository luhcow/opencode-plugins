import { Plugin } from "@opencode/plugin/tui"
import { createElement, effect, insert, insertNode, setProp } from "@opentui/solid"
import { createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import {
  createTpsTracker,
  resolveTpsFooterDisplay,
  type HistoryMessageLike,
  type TpsFooterDisplay,
} from "./core.ts"

type ResizeEmitterLike = {
  width?: number
  isDestroyed?: boolean
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  off?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
}

function readPositiveWidth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function removeResizeListener(emitter: ResizeEmitterLike | undefined, listener: (...args: unknown[]) => void) {
  if (!emitter || emitter.isDestroyed) return
  if (typeof emitter.off === "function") emitter.off("resize", listener)
  else emitter.removeListener?.("resize", listener)
}

export default Plugin.define({
  id: "tps.tui",
  setup(context) {
    const tracker = createTpsTracker()
    const [tick, setTick] = createSignal(Date.now())
    let timer: ReturnType<typeof setInterval> | undefined

    const syncTimer = () => {
      if (tracker.hasActiveStream()) {
        if (!timer) {
          timer = setInterval(() => {
            if (!tracker.hasActiveStream()) {
              clearInterval(timer)
              timer = undefined
              return
            }
            setTick(Date.now())
          }, 100)
        }
      } else if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    }

    const bump = (timestamp?: number) => {
      setTick(timestamp && timestamp > 0 ? Math.max(timestamp, Date.now()) : Date.now())
      syncTimer()
    }

    const subscriptions = [
      context.data.on("session.execution.started", (event) => {
        tracker.onExecutionStarted(event.data.sessionID)
        bump(event.created)
      }),
      context.data.on("session.step.started", (event) => {
        tracker.onStepStarted(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.started,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.step.first-token", (event) => {
        tracker.onFirstToken(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.text.delta", (event) => {
        tracker.onDelta(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.delta,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.reasoning.delta", (event) => {
        tracker.onDelta(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.delta,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.tool.input.delta", (event) => {
        tracker.onToolInputDelta(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.id,
          event.data.delta,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.tool.input.ended", (event) => {
        tracker.onToolInputEnded(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.id,
          event.data.text,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.tool.called", (event) => {
        tracker.onStepStreamed(event.data.sessionID, event.data.assistantMessageID, event.created)
        bump(event.created)
      }),
      context.data.on("session.step.streamed", (event) => {
        tracker.onStepStreamed(event.data.sessionID, event.data.assistantMessageID, event.created)
        bump(event.created)
      }),
      context.data.on("session.step.ended", (event) => {
        tracker.onStepEnded(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.tokens,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.step.failed", (event) => {
        tracker.onStepFailed(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.tokens,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.compaction.started", (event) => {
        tracker.onStepStarted(
          event.data.sessionID,
          "compaction",
          event.created,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.compaction.delta", (event) => {
        tracker.onDelta(event.data.sessionID, "compaction", event.data.text, event.created)
        bump(event.created)
      }),
      context.data.on("session.compaction.ended", (event) => {
        tracker.onStepEnded(event.data.sessionID, "compaction", event.data.tokens, event.created)
        bump(event.created)
      }),
      context.data.on("session.compaction.failed", (event) => {
        tracker.onStepFailed(event.data.sessionID, "compaction", event.data.tokens, event.created)
        bump(event.created)
      }),
      context.data.on("session.execution.succeeded", (event) => {
        tracker.onExecutionFinished(event.data.sessionID, event.created)
        bump(event.created)
      }),
      context.data.on("session.execution.failed", (event) => {
        tracker.onExecutionFinished(event.data.sessionID, event.created)
        bump(event.created)
      }),
      context.data.on("session.execution.interrupted", (event) => {
        tracker.onExecutionFinished(event.data.sessionID, event.created)
        bump(event.created)
      }),
    ]

    let disposed = false
    const renderer = (context as { renderer?: ResizeEmitterLike }).renderer
    const [terminalWidth, setTerminalWidth] = createSignal<number | undefined>(
      typeof renderer?.width === "number" && Number.isFinite(renderer.width) ? renderer.width : undefined,
    )
    const onRendererResize = (width: unknown) => {
      if (disposed) return
      const next =
        typeof width === "number" && Number.isFinite(width)
          ? width
          : typeof renderer?.width === "number" && Number.isFinite(renderer.width)
            ? renderer.width
            : undefined
      setTerminalWidth(next)
    }
    renderer?.on?.("resize", onRendererResize)

    const removeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => {
        const [containerWidth, setContainerWidth] = createSignal<number | undefined>(undefined)
        let trackedParent: ResizeEmitterLike | undefined
        const onParentResize = () => {
          if (disposed || !trackedParent || trackedParent.isDestroyed) return
          const next = readPositiveWidth(trackedParent.width)
          if (next !== undefined) {
            queueMicrotask(() => {
              if (!disposed) setContainerWidth(next)
            })
          }
        }
        const detachParent = () => {
          removeResizeListener(trackedParent, onParentResize)
          trackedParent = undefined
        }
        const attachParent = (node: unknown) => {
          if (disposed) return
          const parent = (node as { parent?: ResizeEmitterLike | null } | null | undefined)?.parent
          if (!parent || parent.isDestroyed) return
          if (parent !== trackedParent) {
            detachParent()
            trackedParent = parent
            parent.on?.("resize", onParentResize)
          }
          const next = readPositiveWidth(parent.width)
          if (next !== undefined) {
            queueMicrotask(() => {
              if (!disposed) setContainerWidth(next)
            })
          }
        }
        onCleanup(detachParent)

        const snapshot = createMemo(() => {
          const now = tick()
          const sessionID = props.sessionID
          if (!sessionID) return undefined
          const status = context.data.session.status(sessionID)
          const session = context.data.session.get(sessionID)
          const messages = context.data.session.message.list(sessionID) as unknown as readonly HistoryMessageLike[]
          return tracker.getSnapshot(
            sessionID,
            now,
            messages,
            session?.revert?.messageID,
            status === "running",
          )
        })

        const display = createMemo(() => {
          terminalWidth()
          const activeParentWidth = trackedParent && !trackedParent.isDestroyed ? containerWidth() : undefined
          return resolveTpsFooterDisplay({
            snapshot: snapshot(),
            mode: props.mode,
            showDetails: props.showDetails,
            width: activeParentWidth ?? terminalWidth(),
          })
        })

        return Show({
          get when() {
            return display()
          },
          children: (value: () => TpsFooterDisplay) => {
            const box = createElement("box")
            setProp(box, "flexShrink", 0)
            setProp(box, "height", 1)
            const text = createElement("text")
            setProp(text, "wrapMode", "none")
            setProp(text, "truncate", true)
            effect((prev) =>
              setProp(
                text,
                "fg",
                value().streaming ? context.theme.hue.accent[500] : context.theme.text.muted,
                prev,
              ),
            )
            insert(text, () => value().label)
            insertNode(box, text)
            queueMicrotask(() => attachParent(box))
            // OpenTUI accepts native renderables; Solid's shared JSX type is DOM-oriented.
            return box as unknown as JSX.Element
          },
        })
      },
    })

    return () => {
      disposed = true
      removeSlot()
      removeResizeListener(renderer, onRendererResize)
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      subscriptions.forEach((unsubscribe) => unsubscribe())
    }
  },
})
