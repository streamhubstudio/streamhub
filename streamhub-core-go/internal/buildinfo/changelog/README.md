# Embedded changelog

`go generate ./internal/buildinfo` copies the repo-root `CHANGELOG.md` here
(`CHANGELOG.md`, gitignored) so `go:embed` bakes it into the binary — Go can't
embed files outside the module. `deploy/Dockerfile` and
`deploy/make-core-bundle.sh` run the generate step before `go build`.

A binary built without it still serves the changelog: `GET /system/changelog`
falls back to a `CHANGELOG.md` in the cwd / next to the binary (or one level
up) — the same lookup as `VERSION` — and reports `source: "none"` when there is
none. This README is the placeholder that keeps the `//go:embed changelog`
pattern matching on a fresh checkout.
