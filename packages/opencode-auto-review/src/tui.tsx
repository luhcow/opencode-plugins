/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { AutoReview } from "./rpc.js"
import { createAutoReviewController, resolveAutoReviewFooterLabel } from "./tui-state.js"

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
  id: "opencode-auto-review.tui",
  setup(ctx) {
    const [enabled, setEnabled] = createSignal(ctx.options.enabled !== false)
    // Must match `parseOptions()`: the server default is off.
    const [fallback, setFallback] = createSignal(ctx.options.humanFallback === true)
    const rpc = ctx.client.rpc(AutoReview)
    let disposed = false
    const toast = (message: string) => {
      if (!disposed) ctx.ui.toast.show({ message, variant: "warning", duration: 4_000 })
    }

    // Reviewer notices arrive over RPC and are shown as a toast. They are never
    // committed to the session, so a notice cannot resume an idle session or enter
    // the coding model's context. Events from another location are ignored, the
    // same way the state controller ignores them.
    const activeLocation = ctx.location
    const isLocal = (location: { directory?: string; workspaceID?: string } | undefined): boolean => {
      if (!activeLocation || !location) return true
      return location.directory === activeLocation.directory && location.workspaceID === activeLocation.workspaceID
    }
    const stopNotices = rpc.events.on("notice", (event) => {
      if (disposed || !isLocal(event.location)) return
      const data = event.data as { description?: unknown; severity?: unknown } | undefined
      if (typeof data?.description !== "string" || !data.description) return
      const severity = data.severity
      const variant = severity === "success" || severity === "info" || severity === "warning" || severity === "error" ? severity : "info"
      ctx.ui.toast.show({ message: data.description, variant, duration: variant === "success" ? 3_000 : 6_000 })
    })

    // Only confirmed RPC responses or events move the signal; the controller
    // keeps the authoritative state and discards stale status responses.
    const controller = createAutoReviewController({
      client: rpc,
      location: ctx.location,
      initial: ctx.options.enabled !== false,
      initialFallback: ctx.options.humanFallback === true,
      onChange: (value) => setEnabled(value),
      onFallbackChange: (value) => setFallback(value),
      toast,
    })
    controller.start()
    // A reconnect may have missed state events; re-query the authoritative state.
    const stopConnected = ctx.data.on("server.connected", () => void controller.refresh())

    const renderer = (ctx as { renderer?: ResizeEmitterLike }).renderer
    const [terminalWidth, setTerminalWidth] = createSignal<number | undefined>(
      typeof renderer?.width === "number" && Number.isFinite(renderer.width) ? renderer.width : undefined,
    )
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
      queueMicrotask(() => {
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
          setContainerWidth(next)
        }
      })
    }
    const onRendererResize = (width: unknown) => {
      if (disposed) return
      if (trackedParent?.isDestroyed) {
        detachParent()
        setContainerWidth(undefined)
      }
      const next =
        typeof width === "number" && Number.isFinite(width)
          ? width
          : typeof renderer?.width === "number" && Number.isFinite(renderer.width)
            ? renderer.width
            : undefined
      setTerminalWidth(next)
    }
    renderer?.on?.("resize", onRendererResize)

    // A keymap layer is owned by the calling Solid component. `setup` runs
    // outside the keymap provider tree, so registering here would throw
    // "Keymap.Provider is missing"; register from a rendered component instead.
    const Status = (props: { mode: string; showDetails?: boolean | undefined }) => {
      ctx.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [{
          id: "auto-review.toggle",
          title: "Toggle Auto-review",
          group: "Auto-review",
          palette: true,
          suggested: true,
          enabled: () => ctx.ui.router.current().type === "session",
          run: async () => {
            const route = ctx.ui.router.current()
            if (route.type !== "session") {
              ctx.ui.toast.show({ message: "Open a session to change auto-review mode", variant: "warning" })
              return
            }
            if (disposed) return
            const action = await ctx.ui.dialog.select({
              title: "Auto-review mode",
              options: [
                { title: "Enable", value: "on", description: "Review eligible requests; ask when evidence or confirmation is needed" },
                { title: "Disable", value: "off", description: "Use normal OpenCode permission handling" },
                { title: "Human fallback", value: "fallback", description: "When off, a decision needing a human is denied instead of prompting, so unattended work cannot stall" },
                { title: "Show status", value: "status" },
              ],
            })
            if (!action || disposed) return
            if (action === "status") {
              const confirmed = await controller.refresh()
              if (disposed) return
              if (!confirmed) {
                toast("Auto-review status is unavailable right now.")
                return
              }
              ctx.ui.toast.show({
                message: `Auto-review is ${controller.enabled() ? "enabled" : "disabled"} (human fallback ${controller.humanFallback() ? "on" : "off"}).`,
              })
              return
            }
            if (action === "fallback") {
              // Refresh first so the suggested value matches the server state.
              await controller.refresh()
              if (disposed) return
              const choice = await ctx.ui.dialog.select({
                title: "Human fallback",
                current: controller.humanFallback() ? "on" : "off",
                options: [
                  { title: "On", value: "on", description: "Escalate to a human prompt when a decision needs confirmation" },
                  { title: "Off", value: "off", description: "Deny instead of prompting, so unattended work cannot stall" },
                ],
              })
              if (!choice || disposed) return
              const confirmed = await controller.setFallback(choice === "on")
              if (confirmed) {
                ctx.ui.toast.show({ message: `Human fallback is ${controller.humanFallback() ? "on" : "off"}.` })
              }
              return
            }
            await controller.setEnabled(action === "on")
          },
        }],
        bindings: ["auto-review.toggle"],
      }))

      const primary = ctx.theme.text.action.primary as {
        base: typeof ctx.theme.text.base
        default?: typeof ctx.theme.text.base
      }
      const footerLabel = () => {
        const rendererWidth = terminalWidth()
        const activeParentWidth = trackedParent && !trackedParent.isDestroyed ? containerWidth() : undefined
        return resolveAutoReviewFooterLabel({
          enabled: enabled(),
          mode: props.mode,
          showDetails: props.showDetails,
          width: activeParentWidth ?? rendererWidth,
        })
      }
      return (
        <Show when={footerLabel()}>
          {(label) => (
            <box ref={attachParent} flexShrink={0} height={1}>
              <text wrapMode="none" truncate={true} fg={primary.base ?? primary.default}>
                <b>{label()}</b>
              </text>
            </box>
          )}
        </Show>
      )
    }

    const removeStatus = ctx.ui.slot({
      append: "prompt.footer.status",
      render: ({ mode, showDetails }) => <Status mode={mode} showDetails={showDetails} />,
    })

    return () => {
      disposed = true
      detachParent()
      removeResizeListener(renderer, onRendererResize)
      stopConnected()
      stopNotices()
      controller.dispose()
      removeStatus()
    }
  },
})
