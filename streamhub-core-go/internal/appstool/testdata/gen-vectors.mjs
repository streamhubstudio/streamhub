// Generates vectors.json from tree.json with the Node tooling this package
// replaced (scripts/lib/{tar,appcompose}.mjs — at d05b0512 and earlier):
//   node gen-vectors.mjs <path-to>/scripts/lib > vectors.json
// For each excluder: the entry names collectDir yields and the sha256 of the
// uncompressed tar packTarGz writes (manifest entry first, like apps-pack),
// plus rewriteVendorImports over every `imports` input.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const lib = path.resolve(process.argv[2])
const ac = await import(pathToFileURL(path.join(lib, 'appcompose.mjs')))
const { packTarGz } = await import(pathToFileURL(path.join(lib, 'tar.mjs')))
const spec = JSON.parse(fs.readFileSync(new URL('./tree.json', import.meta.url), 'utf8'))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appstool-vec-'))
for (const f of spec.files) {
  const abs = path.join(root, f.path)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, f.repeat ? f.repeat[0].repeat(f.repeat[1]) : f.body)
}
const manifest = { name: 'streamhub.app.json', body: Buffer.from('{\n  "id": "vec"\n}\n') }
const out = { collect: {}, imports: [] }
for (const [k, excl] of Object.entries({
  worker: ac.isWorkerFileExcluded,
  frontend: ac.isFrontendFileExcluded,
  none: undefined,
})) {
  const entries = ac.collectDir(root, k, excl)
  const tar = zlib.gunzipSync(packTarGz([manifest, ...entries]))
  out.collect[k] = { names: entries.map((e) => e.name), sha256: ac.sha256(tar) }
}
for (const src of spec.imports) out.imports.push({ in: src, out: ac.rewriteVendorImports(src) })
fs.rmSync(root, { recursive: true, force: true })
process.stdout.write(JSON.stringify(out, null, 2) + '\n')
