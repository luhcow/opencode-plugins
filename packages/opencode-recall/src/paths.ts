import { homedir } from "node:os"
import { resolve } from "node:path"

/** Relative options are resolved against the plugin location, not the server's cwd. */
export function resolveLocalPath(value: string, baseDirectory = process.cwd()): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(homedir(), value.slice(2))
  return resolve(baseDirectory, value)
}
