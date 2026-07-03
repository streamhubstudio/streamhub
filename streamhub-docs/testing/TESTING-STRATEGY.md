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

| Layer | Scope | Infra needed | When it runs | Owner |
|-------|-------|--------------|--------------|-------|
| Unit + integration (jest) | Services, guards, controllers, repositories, e2e over an in-memory Nest app | None (Redis/BullMQ/LiveKit/S3 mocked) | **Every commit / every deploy — the gate** | `streamhub-core` |
| Smoke (e2e subset) | Boot + `/health` + fresh migrated DB | None | Part of the jest run; also re-checked post-deploy against the live node | `streamhub-core` |
| Functional simulations | Full media path with real ffmpeg / `lk` / headless Chrome | A running node (LiveKit + ingress/egress + S3 bucket) | Per-wave, and before capacity-sensitive changes | ops / this doc |

See [UNIT-TESTS.md](./UNIT-TESTS.md) for the per-suite catalogue and
[FUNCTIONAL-SIMULATIONS.md](./FUNCTIONAL-SIMULATIONS.md) for the three real
scenarios that have been run against the live node.

---

## 2. The deploy gate

The gate is two commands, run from `streamhub-core/`:

```bash
npm run build     # nest build — TypeScript must compile clean (no emit errors)
npm test          # jest — 429 tests across 22 suites must all pass
```

Both must pass before a deploy proceeds. Properties that make this a *real*
gate rather than a rubber stamp:

- **No external infra.** `jest.config.js` hard-maps `bullmq` and `ioredis` to
  in-memory fakes (`test/helpers/mocks/`), so importing `RecordingService`
  (which opens a BullMQ queue+worker on `onModuleInit`) never dials Redis.
  LiveKit and S3 are mocked per-service via the factories in `test/helpers`, so
  they only "touch the network" in a test that deliberately wires a fake. The
  whole suite runs offline.
- **Deterministic.** Each e2e suite opens a fresh, migrated `streamhub.db` in an
  isolated tmp `DATA_DIR` (see `test/helpers/env.ts`), so suites never share
  state. `clearMocks: true` resets spies between tests.
- **Fast.** Full run is ~6 s wall-clock on an M-series laptop (`Time: 6.161 s`,
  22 suites). Cheap enough to run on every commit.
- **Regression-locked.** The stream-duplication bug (one RTMP ingress being
  counted as three streams) has dedicated regression tests that fail if the
  canonical-key dedupe logic is broken again. See the `REGRESSION` block in
  `streams.service.spec.ts`.

If `npm test` is red, the fix is the deploy — you do not ship around it.

---

## 3. How to run the tests

From `streamhub-core/`:

```bash
# The gate (what CI / deploy runs)
npm run build
npm test

# Watch mode while developing
npm run test:watch

# A single suite
npx jest src/modules/streams/streams.service.spec.ts

# Only the e2e specs (boot a real in-memory Nest app + supertest)
npm run test:e2e

# Coverage report (text-summary + lcov under coverage/)
npm run test:cov
```

Notes:

- Runs on Node with `ts-jest` transpiling against `tsconfig.spec.json`
  (decorators + `emitDecoratorMetadata` already on).
- `forceExit: true` in the jest config is a safety net: `nestjs-pino`'s pretty
  transport and `better-sqlite3` can leave a handle open; the harness still
  exits clean. (You will see a "Force exiting Jest" line — that is expected, not
  a failure.)
- No env setup required. `test/helpers/env.ts` seeds a dummy
  `STREAMHUB_JWT_SECRET`, sets `AUTHZ=log`, disables OIDC and points `DATA_DIR`
  at a per-run tmp dir before the module graph loads.

---

## 4. Coverage

Latest `npm run test:cov` (429 tests):

```
Statements   : 68.59%  ( 2711 / 3952 )
Branches     : 56.76%  ( 1292 / 2276 )
Functions    : 64.98% (  438 /  674 )
Lines        : 69.60%  ( 2480 / 3563 )
```

Coverage collection (per `jest.config.js`) is over `src/**/*.ts` **excluding**
`*.module.ts`, `dto/**` and `main.ts` — i.e. wiring and DTO shapes are not
counted, so the ~68% is real behavioural code.

Where the uncovered ~31% lives (by design, not by neglect):

- **Media-path glue that only runs against real LiveKit/ffmpeg** — the parts
  that the functional simulations cover instead of unit tests.
- **Bootstrap / process-lifecycle** code (`main.ts` excluded; some
  `onModuleInit` seeding paths).
- **Defensive branches** (the "never throws out of onModuleInit", "falls open
  when the enforcer never initialised" style guards) — branch coverage is lower
  (56.76%) precisely because many branches are these belt-and-suspenders paths.

The invariant-heavy modules (auth, tenancy, authz, quotas, streams, recording,
s3, apps) are the well-covered core; see UNIT-TESTS.md.

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
