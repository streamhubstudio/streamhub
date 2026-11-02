# TAGS — dynamic stream/room tagging with per-tag config

A **tag** is a small operator-created **entity** with a settings blob. You create
tags per app, apply them to streams (or every stream in a room), and consumers
read per-tag settings out of the tag's `config_json`. The first consumer is the
[Vision Edge](./vision-edge.md) suite — a tag of kind `store` carries per-model
vision settings that merge into every stream it is applied to — but the system is
generic and API-first.

Shipped in **2.13.0** (Vision-Edge Wave 1B), `modules/tags`.

---

## The model

- **Tag** — `{ slug, label, kind, config_json, createdAt, updatedAt }`, stored in
  a per-app **`tags`** table (`apps/<app>/app.db`).
  - `slug` — kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), **immutable**, unique per
    app;
  - `kind` — `store` | `zone` | `custom` (free-form; defaults to `custom`);
  - `config_json` — an arbitrary settings object; its schema is owned by the tag's
    **consumer** (vision reads per-model blocks from it).
- **Application** — a `streams.tags` JSON-array column holds the tag **slugs**
  applied to a stream row (the precedent is the `disabled_plugins` column). A
  stream references tags by slug; applying tags to a *room* replaces the slug
  array on every existing stream row of that room.

Deleting a tag **prunes its slug from every stream** that referenced it, in one
transaction — so a stream can never point at a dead tag.

Ingress create accepts a `tags: []` array, so a stream can be born tagged.

---

## Settings merge (precedence)

A stream's **effective** settings for a consumer (e.g. a vision model) are a deep
merge of three layers, lowest precedence first:

```
1. model defaults        (the consumer's built-in defaults)
2. tag configs           (each applied tag's config_json, in array order — a later tag wins)
3. per-stream override   (an explicit override on the stream)
```

Merge rules:

- plain **objects** merge **recursively** (a nested key set only in a lower layer
  survives);
- **arrays** are **replaced wholesale** (never concatenated) — a higher layer's
  array is the final value;
- primitives / `null` replace lower layers;
- the result is a **deep clone** — no input is shared into the output.

A malformed `config_json` is treated as an empty layer (never throws). The pure
resolver (`resolveStreamSettings`) is reused by the vision scheduler when it
resolves an assignment's config.

---

## API

Two controllers under the app, Bearer + RBAC. Tag CRUD uses `config` permission
(a tag configures how an app's streams are processed — the same trust plane as
app config); the stream/room application uses `stream` permission.

### Tag CRUD — `/apps/:app/tags`

| Method + path | Perm | Purpose |
|---|---|---|
| `GET /apps/:app/tags?kind=` | `config:read` | list tags (optionally filtered by kind) |
| `POST /apps/:app/tags` | `config:write` | create `{slug, label, kind?, config_json?}` (`409` on dup slug, `400` on bad slug) |
| `GET /apps/:app/tags/:slug` | `config:read` | one tag (`404` if absent) |
| `PATCH /apps/:app/tags/:slug` | `config:write` | update `label` / `kind` / `config_json` (slug is immutable) |
| `DELETE /apps/:app/tags/:slug` | `config:write` | delete + prune from all streams (`204`) |
| `PATCH /apps/:app/tags/room/:room` | `stream:write` | apply tag slugs to every stream row of a room → `{room, tags, updated}` |

### Stream application — `/apps/:app/streams/:id`

| Method + path | Perm | Purpose |
|---|---|---|
| `GET /apps/:app/streams/:id/tags` | `stream:read` | the stream's applied tag slugs |
| `PATCH /apps/:app/streams/:id/tags` | `stream:write` | replace the stream's applied tags (every slug must exist, `400` otherwise) |

On apply, every slug is validated against the app's existing tags — an unknown
slug is a `400`. Slug arrays are normalized (trimmed, de-duplicated, order
preserved).

---

## Tests

`internal/tags` (`go test`): `tags_test.go` — CRUD, slug validation,
dup/`404`, stream/room apply + unknown-slug reject, delete-prune transaction, the
settings merge (recursive object merge, wholesale array replace, no mutation of the
layers, three-layer precedence; vectors from the 2.x core) and the DTO messages. The
HTTP surface (routes, RBAC) is pinned by the parity harness (`test/parity/cases/tags.json`).
See [../testing/UNIT-TESTS.md](../testing/UNIT-TESTS.md).
