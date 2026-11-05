import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const files = [...new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean))]
// Detection expressions intentionally describe categories; diagnostics never print matching values.
const rules = [
  ["personal home path", /(?:\/Users|\/home)\/[A-Za-z0-9_.-]+\//],
  ["Windows home path", /[A-Z]:\\(?:Users|Documents and Settings)\\[^\\]+/i],
  ["machine temporary path", /\/private\/var\/folders\/[A-Za-z0-9/]+/],
  ["credential", /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/],
  ["private provider ID", /\bgbu-[a-z0-9][a-z0-9._-]+/i],
  ["live session ID", /\b(?:ses|msg)_(?!example_)[a-f0-9]{8,}[A-Za-z0-9]{8,}/],
  ["internal service URL", /https?:\/\/[^\s/]+\.(?:internal|corp|lan)(?=[:/\s"'])/i],
]
let failures = 0
for (const file of files) {
  const absolute = new URL(file, new URL("../", import.meta.url))
  if (!existsSync(absolute)) continue
  if (/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|secrets|private)(?:\/|$)/.test(file) && !file.endsWith(".env.example") || /\.(?:db|sqlite|gguf|pem|key)(?:-.*)?$/.test(file)) {
    console.error(`${file}: private/generated file is a publication candidate`)
    failures++
  }
  const bytes = readFileSync(absolute)
  if (bytes.includes(0)) continue
  const lines = bytes.toString("utf8").split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    for (const [name, pattern] of rules) {
      if (!pattern.test(line)) continue
      console.error(`${file}:${index + 1}: ${name}`)
      failures++
    }
  }
}
if (failures) process.exitCode = 1
else console.log(`Public-content pattern scan passed (${files.length} candidate files, including engineering documents).`)
