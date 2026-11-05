import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const npmCli = process.env.npm_execpath
const npm = (args, options) => npmCli
  ? execFileSync(process.execPath, [npmCli, ...args], options)
  : execFileSync("npm", args, options)
const temp = mkdtempSync(join(tmpdir(), "opencode-package-check-"))
try {
  const packed = JSON.parse(npm(["pack", "--workspaces", "--json", "--ignore-scripts", "--pack-destination", temp], { cwd: root, encoding: "utf8" }))
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const dependencies = Object.fromEntries(packed.map((pkg) => [pkg.name, `file:./${pkg.filename}`]))
  // Pin the supported host baseline; dependencies resolve entirely inside the temporary install.
  for (const name of ["@opencode/plugin", "@opencode/client", "@opentui/core", "@opentui/solid", "solid-js", "tsx"])
    dependencies[name] = rootPackage.devDependencies[name]
  for (const pkg of packed) {
    const paths = new Set(pkg.files.map((file) => file.path))
    assert(paths.has("LICENSE"), `${pkg.name}: missing LICENSE`)
    assert(paths.has("README.md"), `${pkg.name}: missing README`)
    for (const path of paths) assert(!/(?:^|\/)(?:doc|test|\.env|secrets|private)(?:\/|$)|\.(?:sqlite|db|gguf|log)$/.test(path), `${pkg.name}: unexpected ${path}`)
    const manifest = JSON.parse(readFileSync(join(root, "packages", pkg.name, "package.json"), "utf8"))
    for (const target of Object.values(manifest.exports)) assert(paths.has(target.replace(/^\.\//, "")), `${pkg.name}: export missing from tarball`)
  }
  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }))
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: temp, stdio: "pipe" })
  const imports = packed.flatMap((pkg) => {
    const manifest = JSON.parse(readFileSync(join(root, "packages", pkg.name, "package.json"), "utf8"))
    return Object.keys(manifest.exports).map((key) => ({ name: pkg.name + (key === "." ? "" : key.slice(1)), part: key }))
  })
  writeFileSync(join(temp, "smoke.mjs"), `import assert from 'node:assert/strict';\nfor (const entry of ${JSON.stringify(imports)}) {\nconst mod = await import(entry.name);\nif (entry.part !== './rpc') { assert.equal(typeof mod.default.setup, 'function', entry.name); assert.equal(typeof mod.default.id, 'string', entry.name); } else assert(Object.keys(mod).length, entry.name);\n}\n`)
  execFileSync(process.execPath, ["--import", "tsx", "smoke.mjs"], { cwd: temp, stdio: "pipe" })
  console.log(`Verified ${packed.length} packed plugins and ${imports.length} installed entrypoints in an isolated directory.`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
