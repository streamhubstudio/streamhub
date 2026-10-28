# Built-in plugin metas — `builtins.json`

`builtins.json` is **the source of truth** for the in-tree (built-in) plugins and
Studio Apps: one declarative meta per entry, embedded into the binary
(`registry.go`, `//go:embed`). The shape is the one documented by the plugin
contract (`https://streamhub.studio/docs/features/plugins`, `STUDIO-APPS.md`); the registry
validates every entry exactly like Node validated a `plugin.meta.ts`.

History: the file was exported from the NestJS core's
`src/plugins/<id>/plugin.meta.ts` files (a `gen.js` that `require()`d the
compiled metas). That core was retired in 3.2; the TS metas live on in branch
`legacy/node-2.x` / tag `2.24.0`. Edit the JSON directly now.

Rules:

- Keep entries **sorted by `id`**, ids unique, every field a meta needs
  (`TestBuiltinsCatalogIsValid` fails otherwise — an invalid entry would only
  log and disappear at boot).
- A worker plugin (`needsWorker: true`) sets `"worker": {"spawn": "<key>"}`;
  `<key>` names a Go func wired in `builtinSpawn` (`builtin.go`). The TS
  closure it replaces is locked by `testdata/spawn_vectors.json`.
- `testdata/catalog.json` is the catalog the oracle listed. A deliberate change
  to a built-in changes it: re-baseline with
  `go test ./internal/plugins -run TestCatalogVector -update` and review the diff.
- The HTTP surface is pinned too: re-run the parity replay
  (`go run ./cmd/parity -go ./bin/streamhub`) and `-accept` intended changes.
