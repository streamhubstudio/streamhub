# StreamHub — Testing Strategy

This document describes how StreamHub is tested: the layered approach, the
deploy gate, how to run each layer, and what coverage looks like today.

The philosophy is deliberately pragmatic for a single-node media server that
sits on top of LiveKit:

- **Unit / integration tests are the hard gate.** They run with zero infra
  (Redis, LiveKit and S3 are mocked), so they are fast, deterministic and
  runnable on every laptop and CI runner. If they fail, nothing ships.
- **Functional simulations exercise the real media pipeline** (ffmpeg → RTMP
  ingress → transcode → WebRTC → egress → S3) against a live node. They cannot
  be a per-commit gate — they need GPUs, bandwidth and wall-clock — so they are
  run per-wave and before capacity-sensitive deploys.
- **Smoke tests** are the thin "is it alive and wired?" layer: the app boots,
  `/health` answers, the DB migrates.

---

## 1. The layers

| Layer | What it proves | Where | How to run | Automation |
|-------|----------------|-------|------------|------------|
| **Unit + integration** | Pure logic + wiring, infra faked (Redis/LiveKit/S3/SMTP behind interfaces) | core `*_test.go` (`go test`); web `src/**/*.spec.ts` (node:test) + `*.test.tsx` (vitest); python runtime `pytest` | `go test ./...` / `npm test` / `npm run test:components` / `pytest` | CI `core-go`/`web`/`vision-runtime` jobs on every push — **the gate** |
| **HTTP contract (parity)** | Every `/api/v1` route answers exactly as the 2.x core did (status, headers, normalized JSON) | `streamhub-core-go/test/parity/` (1 343 cases + the recorded oracle) | `go run ./cmd/parity -go ./bin/streamhub` | CI `parity` job — **the gate** |
| **UI behavioral (E2E)** | The dashboard actually behaves: toggles persist, saved config round-trips, every page renders without console errors — driven in a real browser against a real locally-booted core | `streamhub-web/e2e/` (Playwright) | boot a scratch core (see `playwright.config.ts` header) + `npm run test:e2e` | on demand / pre-release |
| **Functional simulations** | The media actually flows and is watchable: real frames, latency, fan-out, recordings in S3 — plus capacity | a running node (LiveKit + ingress/egress + S3) | manual, per-wave (see [FUNCTIONAL-SIMULATIONS.md](./FUNCTIONAL-SIMULATIONS.md)) | per-wave / before capacity-sensitive deploys |
| **Production smoke** | The LIVE deployment's every major surface still answers (reversible: creates and deletes a throwaway app; `-read-only` sends GETs only; `-routes` walks every parameter-free OpenAPI GET per app, failing on any 5xx but 503) | `streamhub-core-go/cmd/smoke` | `STREAMHUB_BASE=… STREAMHUB_TOKEN=… go run ./cmd/smoke [-read-only] [-routes]` (from `streamhub-core-go/`) | CI scheduled `prod:smoke` (nightly) + after every deploy |
| **Conference / call smoke** | The conference sample's pre-join screen renders in headless Chrome (offline); two LiveKit bots join a room and exchange data | `cmd/smoke conference`, `cmd/smoke call` | `go run ./cmd/smoke conference` · `go run ./cmd/smoke call -base … -token …` | on demand / after a sample or LiveKit change |
| **Manual QA** | A human tester validates the whole product by hand — ingest (OBS), playback, rooms, core config, every Studio App, Streamflow, IoT, cluster/edge | [MANUAL-QA.md](./MANUAL-QA.md) (Spanish; 11 suites, 72 cases, P1/P2 matrix) | by hand, following the guide | per release / per tester cycle |
| **Security (SCA)** | Dependency CVEs (npm + pip) | — | `npm audit` / `pip-audit` | CI `sca:*` jobs (every push + weekly schedule) |

See [UNIT-TESTS.md](./UNIT-TESTS.md) for the per-suite catalogue.

**Design principle:** every shipped feature leaves a smoke check behind (one
`s.ok(...)` line in `streamhub-core-go/cmd/smoke/prod.go`) — the smoke is the living contract
of "prod still works". When the smoke caught `origin reports disk = null`,
that WAS the signal a change hadn't reached prod yet. (On a standalone core —
`GET /cluster/info` → `enabled:false` and an empty node registry — that check is
skipped with its reason: the origin only self-registers with a cluster token.)

**Adding a feature — the test checklist**
1. Unit-test the pure logic (a table-driven `*_test.go` next to the code).
2. Add parity cases for the REST route (auth + happy + error paths) in
   `streamhub-core-go/test/parity/cases/` — a new route has no oracle answer:
   review Go's and `-accept` it (see that dir's README).
3. Add one `s.ok(...)` line to `streamhub-core-go/cmd/smoke/prod.go` for the live surface
   (GET-only checks also run under `-read-only`).
4. Catalogue the new suite in [UNIT-TESTS.md](./UNIT-TESTS.md).
5. Add the by-hand case to [MANUAL-QA.md](./MANUAL-QA.md) if a tester can
   exercise it; for real media/GPU, script a functional check.

---

## 2. The deploy gate

Run from `streamhub-core-go/` (the CI `core-go` + `parity` jobs):

```bash
test -z "$(gofmt -l cmd internal)" && go vet ./...
go test -count=1 ./...                         # every package — no external infra
go build -o bin/streamhub ./cmd/streamhub
go run ./cmd/parity -go ./bin/streamhub        # HTTP contract vs the recorded oracle
```

Properties that make this a *real* gate rather than a rubber stamp:

- **No external infra.** Redis, LiveKit, S3, SMTP, MQTT, ffmpeg and outbound
  HTTP sit behind small interfaces with in-memory fakes; SQLite is a real,
  migrated temp `DATA_DIR`. A test that dials the network is a bug.
- **Cross-runtime vectors.** Hashes, ciphertexts, JWTs, validation messages,
  YAML dumps, spawn specs and WS frames are checked against values the 2.x core
  generated (frozen in `testdata/`).
- **Contract replay.** The parity replay boots the real binary and diffs ~1.3k
  requests against the recorded 2.x responses.
- **Fast.** The Go suite runs in well under a minute; the replay in ~10 s.

If the gate is red, the fix is the deploy — you do not ship around it.

---

## 3. How to run the tests

From `streamhub-core-go/`:

```bash
go test ./...                                   # the gate
go test -race -count=1 ./internal/edge/         # one package
go test ./internal/plugins -run TestCatalogVector -v
go test -cover ./...                            # per-package coverage
go run ./cmd/parity -go ./bin/streamhub -module auth -v   # one parity module
```

No env setup required: tests build their own temp `DATA_DIR` and config. The
parity replay needs `<repo>/plugins-vendor` composed (`streamhub-core apps pull`).

---

## 4. Coverage

`go test -cover ./...` reports per-package statement coverage. What stays
uncovered by design: media-path glue that only runs against real
LiveKit/ffmpeg (the functional simulations cover it), process lifecycle, and
defensive branches. The invariant-heavy packages (auth, tenancy, authz,
quotas, streams, recording, s3, apps) are the well-covered core; see
UNIT-TESTS.md.

---

## 5. What each layer is allowed to prove

- **Unit/integration** proves *logic and invariants*: canonical stream keys,
  quota bypass rules, HMAC signing, tenant isolation, VOD state machine, config
  editor safety (never write a broken YAML). It does **not** prove that a real
  camera produces a viewable frame.
- **Functional simulations** prove *the media actually flows and is watchable*:
  real frame (not black), glass-to-glass latency, viewer fan-out counts, chat,
  simulcast, snapshots and recordings landing in S3. They also surface
  **capacity** — where a 4c/8GB node saturates.
- **Smoke** proves *it boots and is reachable* after a deploy.

Together: green gate = safe to deploy; simulations = confidence the pipeline is
watchable and a read on how many concurrent streams the node can carry.
