import path from "node:path"

if (process.env.OPENCODE_TUI_PRELOAD === "1") {
  // Bun < 1.4 threw non-Error ResolveMessage from Bun.resolveSync, breaking OpenCode 2.3's optional gui-experimental probe.
  try {
    Bun.resolveSync("__opencode_resolve_probe__", import.meta.dirname)
  } catch (error) {
    if (!(error instanceof Error) && error && typeof error === "object") {
      Object.setPrototypeOf(Object.getPrototypeOf(error), Error.prototype)
    }
  }
} else {
  const source = process.env.OPENCODE_SOURCE_DIR
  if (!source) throw new Error("Set OPENCODE_SOURCE_DIR to an OpenCode V2 checkout with dependencies installed")
  const sourceDir = path.resolve(source)
  const self = path.resolve(import.meta.filename)
  const test = path.resolve(import.meta.dirname, "../test/tui.integration.ts")
  const boundary = path.resolve(import.meta.dirname, "../test/boundary.integration.ts")
  const child = Bun.spawn([process.execPath, "test", "--preload", self, "--timeout", "30000", test, boundary], {
    cwd: path.join(sourceDir, "packages/tui"),
    env: { ...process.env, OPENCODE_SOURCE_DIR: sourceDir, OPENCODE_TUI_PRELOAD: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  process.exit(await child.exited)
}
