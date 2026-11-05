import { copyFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const root = fileURLToPath(new URL("../", import.meta.url))
for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  copyFileSync(join(root, "LICENSE"), join(root, "packages", entry.name, "LICENSE"))
}
console.log("Synchronized each package LICENSE with the repository GPL-3.0-or-later license.")
