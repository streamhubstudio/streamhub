# streamhub-core

Management layer over a self-hosted LiveKit (AntMedia-style). NestJS + TypeScript
(strict). See `../streamhub-docs/SPEC.md` for the full spec.

## Run

```bash
npm install
cp .env.example .env   # fill LiveKit keys, secrets
npm run build
npm run start:prod     # node dist/main.js, binds 127.0.0.1:3020
```

- API base: `/api/v1` (bind `HOST:PORT`, default `127.0.0.1:3020`)
- Swagger UI: `/api/v1/docs` · OpenAPI JSON: `/api/v1/openapi.json`
- Health (public): `GET /api/v1/health`

## Layout — who owns what

**Scaffolder-owned (do NOT edit when filling a module):**

- `src/main.ts`, `src/app.module.ts`
- `src/shared/config/**` — `ConfigService` (env, SPEC §13)
- `src/shared/db/**` — `DbService` (better-sqlite3, migrations, SPEC §4)
- `src/shared/auth/**` — global `StreamHubAuthGuard` + `@Public()` + `AuthValidatorContract`
- `src/shared/contracts/**` — STABLE cross-module types/service interfaces/DI tokens

**Module-owned (fill the stubs here, in parallel):** `src/modules/<name>/`
apps · livekit · recording · s3 · auth · health · streams · transcoding · logs · callbacks

## Rules for parallel agents

1. Implement only inside your `src/modules/<name>/`. Do not touch `shared/` or
   `app.module.ts` (the wiring is already done).
2. Depend on other modules via the **contracts** in `src/shared/contracts`,
   injecting by the DI token (e.g. `@Inject(S3_SERVICE) s3: S3ServiceContract`).
   Never import another module's concrete class.
3. If you need a contract changed, that is a scaffolder change — coordinate;
   only additive changes are safe.
4. Keep DTOs validated (class-validator) and Swagger-annotated.
