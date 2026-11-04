# Helm chart — `deploy/helm/streamhub` (G3)

StreamHub on Kubernetes, in the same shape as `docker-compose.yml`: the Go core with its
`DATA_DIR` on a volume, LiveKit + ingress + egress on host networking, redis, and one HTTP
entry point for the dashboard/API and `/rtc` signaling.

```
              Ingress (HTTP/S: global.domain)
               /rtc ─────────────┐        / ──────────┐
                                 ▼                     ▼
 media node(s) ┌──────────────────────────┐   ┌──────────────────────┐
 hostNetwork   │ livekit  7880 7881 7882u │◄──│ core (StatefulSet)    │ pod network
               │ ingress  1935 8080       │   │ :3020, PVC /data ◄─┐ │
               └──────────────────────────┘   └────────────────────┼─┘
                       ▲ redis (StatefulSet, password)              │ same RWO claim,
 core's node   ┌───────┴──────────────────┐                         │ same node
 hostNetwork   │ egress  (writes /data) ──┼─────────────────────────┘
               └──────────────────────────┘
```

| Component | Kind | Network | Notes |
|---|---|---|---|
| `core` | StatefulSet, **1 replica** | pod | `HOST=0.0.0.0:3020`; PVC `data-<release>-streamhub-core-0` at `/data`; init container seeds the `sk_` token (`streamhub-core seed-token`, token on stdin); probes on `/api/v1/health` |
| `livekit` | Deployment, `livekit.replicas` | **host** | one pod per node (required anti-affinity + host ports); `LIVEKIT_CONFIG` = the compose config, keys expanded from the Secret by the kubelet; webhook → core Service |
| `ingress` | Deployment, `livekitIngress.replicas` | **host** | RTMP 1935 / WHIP 8080 on the node IP; one per node |
| `egress` | Deployment, 1 replica | **host** | mounts the **core's claim** at `/data`; required pod affinity to the core; `SYS_ADMIN`, 1 GiB `/dev/shm` |
| `redis` | StatefulSet | pod | `--requirepass $(REDIS_PASSWORD)`, AOF on a 1 GiB PVC |
| Ingress | `networking.k8s.io/v1` | — | `global.domain`: `/rtc` → livekit:7880, `/` → core:3020; TLS secret `ingress.tlsSecretName` when `global.tls` |
| Secret | generated | — | `LIVEKIT_API_KEY/SECRET`, `STREAMHUB_JWT_SECRET`, `ADMIN_USER/PASS`, `STREAMHUB_API_TOKEN`, `METRICS_TOKEN`, `STREAMHUB_CLUSTER_TOKEN`, `REDIS_PASSWORD` — the installer's formats; or `secrets.existingSecret` |

## Install

There is **no public core image yet**. Build and push one your cluster can pull:

```bash
docker build -f deploy/Dockerfile -t registry.example.com/streamhub-core:3.4.0 .
docker push registry.example.com/streamhub-core:3.4.0
# kind:  kind load docker-image streamhub-core:3.4.0     k3s:  docker save … | sudo k3s ctr images import -
```

Label (and optionally taint) the media node(s), then install:

```bash
kubectl label node media-1 streamhub.io/media=true
kubectl taint node media-1 streamhub.io/media=true:NoSchedule     # optional: dedicate it

helm install sh deploy/helm/streamhub -n streamhub --create-namespace \
  --set global.domain=media.example.com \
  --set global.mediaHost=rtmp.example.com \
  --set core.image.repository=registry.example.com/streamhub-core \
  --set 'media.nodeSelector.streamhub\.io/media=true' \
  --set ingress.className=nginx \
  --set 'ingress.annotations.cert-manager\.io/cluster-issuer=letsencrypt'

kubectl -n streamhub rollout status statefulset/sh-streamhub-core
helm test sh -n streamhub
kubectl -n streamhub get secret sh-streamhub-secrets -o jsonpath='{.data.ADMIN_PASS}' | base64 -d
```

DNS: `global.domain` → the Ingress controller; `global.mediaHost` → the media node(s)' public
IP(s). Open on the media nodes' firewall/security group: 7881/tcp, 7882/udp, 1935/tcp,
8080/tcp. Everything is documented inline in `values.yaml`.

Secrets are generated on the first install and **kept**: upgrades read the live Secret
(`lookup`), and the Secret carries `helm.sh/resource-policy: keep`, so `helm uninstall` +
reinstall over the same PVC still matches the seeded API token. (`helm template` has no
cluster to look up, so it renders fresh random values each time — expected.) Wipe
everything: `helm uninstall sh`, then delete the Secret and the PVCs by hand.

## Limits (by design)

- **One media pod per node.** LiveKit, ingress and egress use host networking (as in compose):
  WebRTC needs the node's real IP in its ICE candidates and a fixed UDP port, and RTMP/WHIP are
  served on the node IP. Host ports mean at most one LiveKit (and one ingress) per node — the
  chart enforces it with required anti-affinity, and `replicas` must not exceed the eligible
  nodes. Rollouts replace pods in place (`maxSurge: 0`): a node's media drops while its pod
  restarts.
- **Media nodes need public IPs** (or a 1:1 NAT: `livekit.useExternalIP` + `extraConfig`
  `rtc.node_ip`). Behind a cloud load balancer only the HTTP Ingress works; UDP media must
  reach the node directly. `hostNetwork: false` is possible for LiveKit only with a UDP
  LoadBalancer/NodePort per pod and `rtc.node_ip` — not covered by the chart.
- **Single core.** The core owns per-app SQLite DBs (single writer) and spawns plugin workers
  and passthrough ffmpegs inside its pod: `replicas: 1`, no HPA. Scale media with more media
  nodes, not cores.
- **RWO `DATA_DIR` ⇒ egress on the core's node.** The core hands egress paths under `/data`
  and uploads/serves what egress writes there, so both mount the same claim. A
  `ReadWriteOnce` volume is per node, so egress gets required pod affinity to the core: the
  core's node must be able to run egress (≥ 4 CPUs for HLS/recording room-composite — egress
  refuses those jobs below 4 available CPUs; free host port 6791; tolerate its taints — egress
  inherits `core.tolerations`). With an RWX storage class set `egress.colocateWithCore=false`.
- **Not ported to the chart:** the MediaMTX single-port front, RTMPS, the RTMP passthrough
  port pool (`STREAMHUB_RTMP_PASSTHROUGH_*`), TURN (possible via `livekit.extraConfig` + a cert
  mounted by hand), the cluster join flow (`install.sh --join`; the chart's media nodes are
  already one LiveKit cluster through redis), backups (`deploy/backup.sh` assumes the host
  shape — snapshot the PVC instead).
- **`/metrics`** is token-protected by the core (`METRICS_TOKEN`), but the Ingress does not 403
  it the way Caddy/nginx do; add a controller-specific rule if you want it unreachable.

## Validation status

| What | How | Result |
|---|---|---|
| `helm lint` / `helm template` (defaults, existingSecret, external redis, RWX/no-colocate) | `alpine/helm` container | **pending** — the test host went down before this step |
| `helm install` on an ephemeral `kind` cluster, core Ready + `/api/v1/health`, `helm test` | kind in Docker, core image built there and `kind load`ed | **pending** |
| real media (WebRTC/RTMP through host-network pods) | — | not tested; expected to need a real multi-node cluster (k3s on a lab cluster is the roadmap's "done" criterion) |
