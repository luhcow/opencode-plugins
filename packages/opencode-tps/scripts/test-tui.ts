import path from "node:path"

const source = process.env.OPENCODE_SOURCE_DIR
if (!source) throw new Error("Set OPENCODE_SOURCE_DIR to an OpenCode 2.2.x checkout with dependencies installed")
const sourceDir = path.resolve(source)
const test = path.resolve(import.meta.dirname, "../test/tui.integration.ts")
const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", test], {
  cwd: path.join(sourceDir, "packages/tui"),
  env: { ...process.env, OPENCODE_SOURCE_DIR: sourceDir },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(await child.exited)
