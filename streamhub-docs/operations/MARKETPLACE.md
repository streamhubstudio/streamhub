# Marketplace images — DigitalOcean, Vultr, Hetzner, AWS (G3)

One-click images of a StreamHub origin node, built with Packer over the normal installer.
A server booted from the image has Docker, the source and every container image already on
disk — but **no secrets, no domain and nothing running**: each server generates its own
secrets on first boot, from the user-data or from a prompt on the first SSH login.

| Piece | Path |
|---|---|
| Packer template (4 builders) | `deploy/marketplace/packer/streamhub.pkr.hcl` (+ `example.pkrvars.hcl`) |
| Provisioning steps | `deploy/marketplace/packer/scripts/00-base.sh … 99-img-check.sh` |
| First-boot setup | `deploy/marketplace/first-boot.sh` → `/opt/streamhub/first-boot.sh` |
| cloud-init unit, MOTD, login hook | `deploy/marketplace/image/` |
| User-data examples | `deploy/marketplace/user-data.example.yaml`, `user-data.example.sh` |
| Image build mode of the installer | `install.sh --prepare-image` ([INSTALL-NODE.md](./INSTALL-NODE.md#golden-images---prepare-image)) |

## 1. What the image build does

Every builder boots a stock **Ubuntu 24.04 LTS x64** and runs the same provisioners:

1. **`00-base.sh`** — waits for the provider's own cloud-init, then a full `dist-upgrade`
   (the DO/Vultr checks reject images with pending security updates).
2. Uploads **this checkout's** `install.sh`, `first-boot.sh` and `image/` files.
3. **`10-prepare-image.sh`** — `install.sh --prepare-image --proxy <proxy>`: Docker + compose,
   the source in `/opt/streamhub` (from `src_url`), `docker compose pull` of
   redis/livekit/ingress/egress/caddy and `docker compose build core`. No `.env`, nothing
   started, no telemetry, no `.install_id`. Writes `/opt/streamhub/.image-prepared`
   (version, default proxy, telemetry channel `marketplace-<builder>`) and keeps a copy of the
   installer at `/usr/local/lib/streamhub/install.sh` (outside the install dir).
4. **`20-first-boot.sh`** — installs `first-boot.sh`, `streamhub-first-boot.service`
   (after `cloud-final`, part of `cloud-init.target`), `/etc/update-motd.d/99-streamhub` and
   `/etc/profile.d/streamhub-first-boot.sh`.
5. **`30-firewall.sh`** — `ufw`: deny inbound, `limit 22/tcp`, allow 80, 443, 1935, 7880,
   7881, 8080/tcp and 7882/udp (`enable_ufw=false` to skip, e.g. AWS with security groups).
6. **`90-cleanup.sh`** then **`99-img-check.sh`** — see [§5](#5-cleanup--image-check). The
   check fails the build on anything dirty, so a bad image never becomes a snapshot.

The default proxy baked into the image is **Caddy**: auto-TLS that keeps retrying the ACME
order until DNS points at the server, and no host packages. `proxy = "nginx"` bakes the
nginx + certbot shape instead (required for `--turn`); `first-boot.env` can also switch it
per server (`STREAMHUB_PROXY`). Caddy's image is pulled in both cases.

## 2. Building

Packer ≥ 1.10. From `deploy/marketplace/packer/`:

```bash
packer init .
packer validate .                      # needs the plugins; -syntax-only works without
cp example.pkrvars.hcl local.pkrvars.hcl   # gitignored

export DIGITALOCEAN_TOKEN=… VULTR_API_KEY=… HCLOUD_TOKEN=…   # AWS: the usual AWS_* chain / AWS_PROFILE
packer build -var-file=local.pkrvars.hcl -only='streamhub.digitalocean.streamhub' .
packer build -var-file=local.pkrvars.hcl -only='streamhub.vultr.streamhub' .
packer build -var-file=local.pkrvars.hcl -only='streamhub.hcloud.streamhub' .
packer build -var-file=local.pkrvars.hcl -only='streamhub.amazon-ebs.streamhub' .
```

The snapshot/AMI is named `streamhub-<version>-<YYYYMMDDhhmm>` (version = the repo `VERSION`
unless `streamhub_version` is set) and `packer-manifest.json` records the artifact ids.

**Which code ends up in the image.** `src_url` (default: the published
`https://www.streamhub.studio/streamhub-src.tar.gz`) is what is installed; `repo_url`
defaults to an unreachable URL so images are always built from a release tarball, never a
moving branch. To bake an unreleased build, produce a tarball with
`deploy/make-release-artifact.sh`, serve it over https and point `src_url` at it. The
installer and first-boot files always come from the checkout running Packer — build from the
tag you are releasing so they match the tarball. Decoupled Studio Apps are whatever the
tarball composed (`plugins-vendor/`).

### Variables per provider

| Provider | Credentials | Variables (defaults) | Notes |
|---|---|---|---|
| all | — | `proxy` (`caddy`), `src_url`, `repo_url`, `streamhub_version`, `enable_ufw` (`true`), `zero_free_space` (`true`) | |
| DigitalOcean | `DIGITALOCEAN_TOKEN` / `do_token` | `do_region` (`nyc3`), `do_size` (`s-2vcpu-4gb`), `do_image` (`ubuntu-24-04-x64`), `do_snapshot_regions` (`[]`) | Build on the **smallest** size you will list: the snapshot's disk is the minimum droplet disk. |
| Vultr | `VULTR_API_KEY` / `vultr_api_key` | `vultr_region` (`ewr`), `vultr_plan` (`vc2-2c-4gb`), `vultr_os_id` (`2284` = Ubuntu 24.04 x64) | OS ids: `GET https://api.vultr.com/v2/os`. |
| Hetzner | `HCLOUD_TOKEN` / `hcloud_token` | `hcloud_location` (`fsn1`), `hcloud_server_type` (`cx22`), `hcloud_image` (`ubuntu-24.04`) | Snapshots are per project; share via the Hetzner Apps program (below). |
| AWS | `AWS_PROFILE` / `AWS_ACCESS_KEY_ID`… | `aws_region` (`us-east-1`), `aws_instance_type` (`t3.medium`), `aws_volume_size` (`30`), `aws_ami_regions` (`[]`), `aws_ami_groups` (`[]`; `["all"]` = public) | Login user `ubuntu`. Source AMI: latest Canonical `ubuntu-noble-24.04-amd64-server`. |

Sizing: 2 vCPU / 4 GB is the minimum that runs the whole stack; **egress needs ≥ 4 vCPUs**
for HLS/recording room-composite (the installer clamps `EGRESS_CPUS` to the host). Recommend
4 vCPU / 8 GB in the listings. The image is ~8–9 GB on disk (egress image alone ≈ 3.8 GB).

## 3. First boot

`/opt/streamhub/first-boot.sh` turns the prepared image into a running origin. It reads, in
order: flags → env (`STREAMHUB_DOMAIN`, `STREAMHUB_ACME_EMAIL`/`ACME_EMAIL`,
`STREAMHUB_PROXY`) → `/etc/streamhub/first-boot.env` → the cloud-init user-data (as text:
`KEY=value` or `KEY: value` lines anywhere in it — never executed) → an interactive prompt.
It then runs `/usr/local/lib/streamhub/install.sh --non-interactive --domain … --email …`
over the baked source (no re-fetch), which generates **exactly the secrets a normal install
generates** (LiveKit key/secret, JWT, `sk_` API token, `mtk_` metrics token, `clt_` cluster
token, admin password) into `/opt/streamhub/.env` (mode 600), starts the stack and seeds the
token. `STREAMHUB_DOMAIN=ip` uses the public IP over plain HTTP (no TLS).

**A. Unattended (user-data).** Paste `deploy/marketplace/user-data.example.yaml` (or the
`.sh` variant) when creating the server:

```yaml
#cloud-config
write_files:
  - path: /etc/streamhub/first-boot.env
    permissions: "0600"
    content: |
      STREAMHUB_DOMAIN=media.example.com
      STREAMHUB_ACME_EMAIL=admin@example.com
```

`streamhub-first-boot.service` runs after `cloud-final` and installs the stack; follow it with
`sudo tail -f /var/log/streamhub-first-boot.log`. Point the domain's A record at the server
(DNS-only, no CDN proxy) — Caddy retries the certificate until it resolves.

**B. Interactive (no user-data).** The service exits immediately and the setup stays
*pending*. The MOTD says so, and the first interactive **root** login runs the script: it shows
the public IP, asks for the domain (warns when it does not resolve to this server) and the
email, confirms, installs and prints the dashboard login + API token **on the terminal only**
(never in a log). `later` postpones it; non-root users (AWS `ubuntu`) get a
`sudo /opt/streamhub/first-boot.sh` hint.

**Idempotent.** One run at a time (`flock`; a concurrent login just points at the log). Done
= `/var/lib/streamhub/first-boot.done`; after that the service no longer starts
(`ConditionPathExists`), the login hook goes quiet, the MOTD shows the URL and the script only
prints the status (`--force` re-runs the installer). A failed run is re-run as is — the
installer keeps any `.env` it already wrote and never rotates secrets. A server installed by
hand with `install.sh` is adopted (marker gone + `.env` present → marked done).

| State | File |
|---|---|
| prepared, never installed | `/opt/streamhub/.image-prepared` (removed by the successful install) |
| setup running / done | `/var/lib/streamhub/first-boot.running` / `first-boot.done` |
| first-boot log (credential-free) | `/var/log/streamhub-first-boot.log` |
| installer log | `/opt/streamhub/logs/install.log` |

Telemetry: the install ping of a marketplace server carries
`channel: marketplace-<builder>` (see [INSTALL.md §9](./INSTALL.md#9-telemetry--anonymous-install-ping-opt-out)),
which is what lets us measure installs per channel. `STREAMHUB_NO_TELEMETRY=1` in
`first-boot.env` / user-data disables it. The installs endpoint must accept those channel
values (check before the first listing goes live).

## 4. Testing an image before submitting

1. Create a server from the snapshot **without** user-data; SSH as root: the MOTD shows
   *not configured* and the prompt appears. Answer `later`, log out, log in again: the prompt
   comes back.
2. Run the setup with a real domain; check `https://<domain>/` and `/api/v1/health`, log in
   with the printed credentials, publish RTMP to `rtmp://<domain>:1935/x` and play it.
3. Create a second server **with** the example user-data: it must come up unattended, and its
   `.env` secrets must differ from the first one's.
4. `sudo bash deploy/marketplace/packer/scripts/99-img-check.sh` on an *unconfigured* server
   from the image must report 0 FAIL.

## 5. Cleanup + image check

`90-cleanup.sh` reproduces the essentials of DigitalOcean's `90-cleanup.sh` (the same rules
Vultr and AWS apply): `apt autoremove/autoclean/clean`; StreamHub per-instance state removed
(`.env`, `.install_id`, `.install-profile`, `.join-profile`, `data/`, logs, first-boot state,
`/etc/streamhub/*.env`, Docker `engine-id`); `/tmp` and `/var/tmp` emptied; **all SSH keys**
removed (`authorized_keys` of root and every user, host keys — cloud-init regenerates them) and
`/etc/ssh/revoked_keys` created; shell history removed; `/etc/machine-id` truncated;
`cloud-init clean --logs` + `/var/lib/cloud/instances/*`; rotated logs deleted, the rest
truncated, journal vacuumed; free space zeroed.

`99-img-check.sh` reproduces the essentials of DigitalOcean's `99-img-check.sh` and exits 1 on
any FAIL: supported OS/arch, cloud-init installed and clean, no SSH keys, root password
locked/unset and no other user with a password, no shell history, no rotated log archives,
no pending security updates, firewall active (WARN), plus StreamHub's own invariants — marker
present, no `.env`/`.install_id`/`data/`, first-boot script + unit enabled, no containers, all
six images present.

## 6. Submission checklists

### DigitalOcean Marketplace (vendor portal)

- [ ] Vendor account approved at `marketplace.digitalocean.com/vendors` (needs a DO team).
- [ ] Snapshot built with `do_size` = the smallest size offered (4 GB RAM recommended) and
      `99-img-check.sh` 0 FAIL in the Packer log.
- [ ] Ubuntu 24.04 LTS base, cloud-init present, `ufw` active with only the listed ports.
- [ ] No SSH keys/passwords/history/logs baked (cleanup step) — DO re-runs its own image check
      on submission.
- [ ] First-boot experience documented: MOTD + interactive setup (what DO calls the "one-click
      application setup on first login"), plus user-data for API/Terraform users.
- [ ] Listing: name, logo (SVG/PNG), short + long description, software included with
      versions (StreamHub, LiveKit v1.13.11, Ingress v1.5.0, Egress v1.15.0, Redis 7, Caddy 2,
      Docker), getting-started text (DNS A record, ports, where credentials live), support
      URL/email, docs link (this repo / site), license.
- [ ] Share the snapshot with DO's marketplace account from the vendor portal; respond to
      review; re-submit for every release (new snapshot per version).
- [ ] Optional: a `deploy to DigitalOcean` button + a Terraform/`doctl` snippet with user-data.

### Vultr Marketplace

- [ ] Vendor account at `vultr.com/marketplace/become-a-verified-vendor/` (verification).
- [ ] Snapshot from the Packer build (`vultr_plan` = smallest plan offered), 0 FAIL in
      `99-img-check.sh`.
- [ ] Configuration: the image works with Vultr's user-data box as is (`STREAMHUB_DOMAIN`,
      `STREAMHUB_ACME_EMAIL`). Vultr's own "app variables" (portal-declared, served through
      the instance metadata) are **not** wired yet: using them needs a small hook that copies
      them into `/etc/streamhub/first-boot.env` before the unit runs.
- [ ] Listing: logo, descriptions, category (Media/Streaming), minimum plan, ports, getting
      started, support contact; Vultr also asks for an "application instructions" text shown
      after deploy — use §3 (where credentials are, how to finish the setup).
- [ ] Submit the snapshot for review; new snapshot + re-submission per release.

### Hetzner Cloud

Hetzner has no self-service marketplace: one-click "Apps" are curated by Hetzner from a public
repo (`github.com/hetznercloud/apps`). Until then, share the snapshot via the docs (a snapshot
can't be made public): users build it themselves with this template, or we provide a
cloud-init that runs the one-liner. Proposal to Hetzner = a PR adding a StreamHub app based on
these same provisioning scripts.

### AWS (AMI) — later

The `amazon-ebs` builder produces a private AMI (public with `aws_ami_groups = ["all"]`).
AWS Marketplace needs a registered seller entity (tax/banking), a product listing in the
Marketplace Management Portal, a scan of the AMI (it fails on root passwords, baked keys,
`authorized_keys` — our cleanup covers them) and an AMI shared with the Marketplace account.
Out of scope for G3 — the AMI build is ready for it.

## 7. What is still manual

- Vendor accounts (DO, Vultr), listing assets (logo, screenshots, copy), support contact.
- Running the builds with real credentials (each build costs a few cents of compute).
- Making images public / submitting them; per-release refresh of every listing.
- Confirming the installs endpoint accepts the `marketplace-*` channels.

## 8. Validation status

| What | How | Result |
|---|---|---|
| `install.sh --prepare-image` | Ubuntu 24.04 container + host Docker daemon, source from a local tarball via `file://` | PASS — real pull of the 5 stack images + full core build, marker written, no `.env`/`data`/`.install_id`/log, nothing started; a second run is idempotent |
| shell scripts | `shellcheck` (installer, first-boot, all Packer steps, MOTD, login hook) | clean |
| first boot → installer (fake Docker) | container e2e: pending without user-data, user-data → install, secrets generated, marker removed, re-runs idempotent | **pending** — the test host went down mid-run |
| `packer validate` | `hashicorp/packer` container | **pending** |
| real cloud builds / boots | needs provider accounts | not done (out of scope) |
