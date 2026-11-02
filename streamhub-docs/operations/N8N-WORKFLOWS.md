# N8N-WORKFLOWS — automatización de builds y soporte

Six n8n workflows drive StreamHub's release/publish pipeline and the AI support
assistants. They were created **via the n8n public API**, all **INACTIVE**: the
public API cannot create or bind credentials, so every workflow references
credentials **by name only** — the owner must create those credentials in the
n8n UI, open each node, select the credential, and only then activate.

- n8n instance: `https://automation.digitalhub.com.ar/` (public API under `/api/v1`,
  header `X-N8N-API-KEY`).
- **Secrets policy:** the n8n API key (JWT), SSH keys, SMTP/IMAP passwords, the
  OpenAI key, the Ploi deploy-webhook URL and the GitHub PAT live in the
  gitignored `Access.md` / on the hosts themselves — **never in this file, never
  in a workflow**.

## Workflow inventory

| Workflow | id | Trigger | Status |
|---|---|---|---|
| `build-platform` | `PbaCXsoSoYk5wkQA` | webhook `POST /webhook/streamhub-build-platform` + manual | inactive |
| `build-agent` | `M5vic3Mm3PIZdS8p` | webhook `POST /webhook/streamhub-build-agent` + manual | inactive |
| `build-docs` | `drtajES5NlK8lLTl` | webhook `POST /webhook/streamhub-build-docs` + manual + daily 06:00 | inactive |
| `build-github-clean` | `h7KQ9obRcA1UX3Fy` | **manual only** (deliberate) | inactive — **owner sign-off required** |
| `chatbot-imap-inquiries` | `TCJL1XxVVlYPfGTW` | IMAP polling trigger | inactive |
| `chatbot-tickets` | `0roNDOQJbky77xXD` | schedule (every 5 min) | inactive |

Webhook URLs become live only after activation:
`https://automation.digitalhub.com.ar/webhook/<path>` (while testing in the
editor, `/webhook-test/<path>`).

## Credentials to create in the n8n UI (checklist)

Create these under **Credentials → Add credential**, with these exact names
(the workflows reference them by name; secret values are in `Access.md`):

- [ ] **`StreamHub Build Host SSH`** — type *SSH (private key)*. Key pair for the
  build host user that owns `/opt/streamhub/src/`. Used by `build-platform`,
  `build-agent`, `build-github-clean`.
- [ ] **`StreamHub Landing Host SSH`** — type *SSH (private key)*. Ploi user on the
  Laravel landing host (`/home/ploi/streamhub.studio`). Used by `build-docs`.
- [ ] **`StreamHub SMTP (no-reply)`** — type *SMTP*. `mail.streamhub.studio`,
  user `no-reply@streamhub.studio`. Used by every build workflow (notifications)
  and by `chatbot-imap-inquiries` (drafts/replies).
- [ ] **`StreamHub Support IMAP`** — type *IMAP*. `imap.streamhub.studio`, the
  support/inquiries mailbox (the no-reply box or a dedicated `support@`).
  Used by `chatbot-imap-inquiries`.
- [ ] **`OpenAI - StreamHub`** — type *OpenAI API*. Used by both chatbot
  workflows' model nodes. (Swappable: replace the "OpenAI Chat Model" node with
  any other n8n chat-model node — Anthropic, Google, or an n8n-provided model —
  and reconnect it to the AI Agent node.)
- [ ] **`StreamHub Tickets API`** — type *Header Auth*. Header (e.g.
  `X-Internal-Token`) + static token that the Laravel internal API checks.
  Used by `chatbot-tickets`.
- [ ] **GitHub fine-grained PAT** — *not an n8n credential.* Placed on the build
  host at `~/.config/streamhub/github_token` (chmod 600), scope
  `contents:write` on `streamhubstudio/streamhub` only. Used by
  `build-github-clean`.
- [ ] **Ploi deploy webhook URL** — *not an n8n credential* (it is a secret URL).
  Paste it into the "Trigger Ploi deploy" HTTP node of `build-docs`, replacing
  `REPLACE-WITH-PLOI-DEPLOY-WEBHOOK-TOKEN`.

Notification recipient defaults to `dev@greenflame.com.ar` in all "Notify"
nodes — change there if the ops inbox moves.

## Execution model / build-host assumptions

All build steps run **over SSH on a build host**, not inside the n8n container
(n8n only orchestrates). Assumptions baked into the SSH nodes — adjust the
commands in the nodes if the layout differs:

- Build host has clones at `/opt/streamhub/src/vision-media-server` and
  `/opt/streamhub/src/vision-agent`, with docker/node/make toolchains, and its
  SSH key is authorized on the landing host so `rsync` can publish.
- Landing host (Ploi) serves `https://streamhub.studio/` from
  `/home/ploi/streamhub.studio/public/` — static files dropped there are served
  at the domain root (`/install.sh`, `/latest.json`, `/agent/...`).
- The production `stream01` box can act as build host, but a dedicated builder
  is preferred so releases never compete with live media traffic.

## 1. `build-platform` (id `PbaCXsoSoYk5wkQA`)

**Purpose:** build the StreamHub core release artifact and publish it so
`curl -fsSL https://streamhub.studio/install.sh | sh` installs the new version.

**Flow:**
1. **Webhook Trigger** (`POST /webhook/streamhub-build-platform`) / **Manual Trigger**.
2. **SSH - Build release artifact** — `git pull --ff-only` then
   `deploy/make-release-artifact.sh` → `dist/streamhub-<ver>.tar.gz`,
   `dist/latest.json`, `dist/install.sh`, `dist/uninstall.sh` (secret-free by
   construction, see the script header).
3. **SSH - Publish to landing** — `rsync` the whole `dist/` payload to the
   landing `public/` root.
4. **Notify success** / **Notify failure** — email via SMTP; every SSH step's
   error output is wired to the failure mail.

**Manual steps remaining:** bind `StreamHub Build Host SSH` + `StreamHub SMTP
(no-reply)` in the nodes; confirm repo path and rsync target; run once manually
from the editor; then **Activate** (toggle in the editor header, or
`POST /api/v1/workflows/PbaCXsoSoYk5wkQA/activate`).

## 2. `build-agent` (id `M5vic3Mm3PIZdS8p`)

**Purpose:** build the StreamHub Agent (repo `vision-agent`, branch
`streamhub-agent`) and publish the binary where the agent installer downloads
it: `https://streamhub.studio/agent/streamhub-agent-linux-<arch>`.

**Flow:** Webhook/Manual → **SSH - Build agent (linux-x64)** (`git checkout
streamhub-agent && make build-linux-x64`) → **SSH - Publish agent binaries**
(rsync `streamhub-agent-linux-*` → landing `public/agent/`) → notify
success/failure.

**Known limitation (documented in the workflow's sticky note):** only
`linux-x64` is automated. The **luckfox (ARM)** and **windows** targets need
their own cross-toolchains/CI boxes; build them where the toolchain lives and
publish to the same `public/agent/` dir. Verify the Makefile's output dir
(the publish step assumes `dist/`).

**Manual steps remaining:** same two credentials as `build-platform`; verify
vision-agent clone path + output dir; test run; activate.

## 3. `build-docs` (id `drtajES5NlK8lLTl`)

**Purpose:** regenerate the docs snapshot on the Laravel landing repo and
redeploy `docs.streamhub.studio`.

**Flow:** Webhook/Manual/**Daily 06:00 schedule** → **SSH - docs:sync + commit**
(`php artisan docs:sync`, commit the snapshot if changed, push) → **Trigger
Ploi deploy** (HTTP POST to the Ploi deploy-webhook URL) → notify
success/failure.

**Manual steps remaining:** bind `StreamHub Landing Host SSH` + SMTP; paste the
real Ploi webhook URL into the HTTP node (placeholder committed instead);
confirm the Laravel repo path; test run; activate.

## 4. `build-github-clean` (id `h7KQ9obRcA1UX3Fy`) — OWNER SIGN-OFF REQUIRED

**Purpose:** publish a **clean public snapshot** to
`github.com/streamhubstudio/streamhub`.

**Safety design — read before first run:**
- The private repo's **git history contains secrets → history is NEVER
  mirrored**.
- The workflow builds the **secret-free tarball** via
  `deploy/make-release-artifact.sh` (excludes `.git`, `.env*`, `Access.md`,
  `deploy-streamhub.sh`, `data/`, build output), extracts it into a fresh temp
  dir, re-scans the tree for secret-looking files (aborts if any), and pushes it
  as a **single squashed commit on a fresh orphan `main`** (`git init` +
  `git push --force`). Each run replaces the previous snapshot; no history, no
  secrets.
- **Manual trigger only, by design.** There is no webhook and no schedule, so
  this workflow cannot be activated at all — it can only be run by a human from
  the editor. Keep it that way.
- **Before the first run the owner must:** create the fine-grained PAT
  (contents:write on `streamhubstudio/streamhub` only), place it at
  `~/.config/streamhub/github_token` on the build host, build a tarball locally
  and **inspect its contents**, and sign off.

**Flow:** Manual → **SSH - Build secret-free tarball** → **SSH - Push clean
snapshot (no history)** → notify success/failure.

## 5. `chatbot-imap-inquiries` (id `TCJL1XxVVlYPfGTW`)

**Purpose:** answer inbound support/inquiry emails with an AI-drafted reply
grounded in the public docs (`docs.streamhub.studio`) — with a human approving
every draft by default.

**Flow:**
1. **Email Trigger (IMAP)** — polls the support mailbox (marks mail as read).
2. **Config** (Set node) — `auto_send = false`,
   `support_review_inbox = support@streamhub.studio`. **This is the safety
   toggle.**
3. **AI Agent - classify + draft** (+ **OpenAI Chat Model** sub-node) — system
   prompt embeds a StreamHub product summary + docs URL; returns JSON
   `{category, confidence, needs_human, reply_subject, reply_body}`. Categories:
   install/api/streaming/agent/billing/bug-report/sales-lead/spam/other;
   billing, sales, bugs, legal and low-confidence answers are always flagged
   `needs_human`.
4. **Parse draft** (Code) — parses/validates the JSON (any parse failure ⇒
   human review) and computes `auto_send = toggle && !needs_human && body`.
5. **Auto-send enabled?** (IF) — *true* → **Send reply to customer** (SMTP
   no-reply); *false (default)* → **Send draft for human review**: the draft +
   original message are emailed to `support_review_inbox` with a
   `[DRAFT for approval]` subject; a human edits and sends it.

**Manual steps remaining:** create + bind `StreamHub Support IMAP`,
`StreamHub SMTP (no-reply)`, `OpenAI - StreamHub`; adjust the review inbox in
`Config` if needed; test with a real email; activate. Flip `auto_send` to
`true` only after the drafts have earned trust.

## 6. `chatbot-tickets` (id `0roNDOQJbky77xXD`)

**Purpose:** post an AI first-response **suggestion** on new support tickets as
an **internal note** — the agent never contacts the customer (human-in-the-loop
is structural, not a toggle).

**Flow:** Every 5 min → **Fetch open tickets** (HTTP GET, header auth) →
**Split Out Tickets** (`data[]`) → **AI Agent - draft first response**
(+ OpenAI model sub-node; plain-text suggestion, asks diagnostics when info is
missing, punts billing/legal/sales to the human) → **Post suggestion as
internal note** (HTTP POST).

**Integration point — must be built in the Laravel landing repo** (over the
existing `tickets`, `ticket_messages`, `consulting_leads` models), protected by
a static header token (middleware) matching the `StreamHub Tickets API`
credential:

```
GET  /api/internal/tickets?status=open&needs_first_response=1
     → { "data": [ { id, subject, customer_email, last_message, created_at } ] }
POST /api/internal/tickets/{id}/suggestions
     { body, author, visibility: "internal" }   → internal ticket_messages row
```

`consulting_leads` can reuse the pattern later: clone this workflow and point
it at `GET /api/internal/consulting-leads?new=1`.

**Manual steps remaining:** implement the two Laravel endpoints; create + bind
`StreamHub Tickets API` and `OpenAI - StreamHub`; test run; activate.

## Activation (per workflow, after credentials are bound)

1. Open the workflow in the editor → each node with a credential shows a
   warning → select the credential created above (names match).
2. Run once with **Execute workflow** (manual path) and check the execution log.
3. Toggle **Active** in the editor header — or via API:
   `POST /api/v1/workflows/<id>/activate` (deactivate:
   `POST /api/v1/workflows/<id>/deactivate`). `build-github-clean` has no
   activatable trigger — it is always run manually, which is intentional.

## Notes

- **AI model nodes**: both chatbots ship wired to an OpenAI chat-model node
  (`gpt-4o-mini`). If the instance has the `@n8n/n8n-nodes-langchain` package
  disabled (it is bundled by default), the AI nodes will show as unknown —
  upgrade/enable before activating.
- **n8n MCP server**: n8n can be driven from an AI client (Claude Code/Desktop)
  via an MCP server that wraps this same public API (e.g. the community
  `n8n-mcp` server, or n8n's native MCP Server Trigger for exposing workflows
  as tools). Point it at `https://automation.digitalhub.com.ar/api/v1` with the
  API key from `Access.md` — useful for creating/editing these workflows
  conversationally instead of via raw curl.
- The n8n public API cannot set `active` on create and cannot manage credential
  secrets — that is why the flows above ship inactive with name-only credential
  references.
