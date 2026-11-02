package cluster

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"log/slog"
	"strings"
	"sync"
)

// Per-node credential (security, 3.3.4 — C5.3). The shared cluster token is
// only the JOIN secret: at join the master hands each node its own
// nodeSecret = hex(HMAC-SHA256(cluster token, "node:"+nodeId)), and every
// later call (heartbeat, the edge WS, master→node grid calls, bundle
// downloads) is authenticated with it. It is derived, not stored: the master
// re-computes it per request, rotating the cluster token rotates every node
// secret, and deleting a node's row revokes it (a re-join mints a new id).
//
// Migration: while STREAMHUB_CLUSTER_LEGACY_TOKEN is on (the 3.3.x default)
// the raw cluster token is still accepted where a node secret is expected,
// with a warning — so nodes joined before 3.3.4 keep working until they are
// re-joined. Turn it off once every node has re-joined (no more warnings).

// NodeSecretHeader carries a node's own credential. X-Cluster-Token (and the
// WS ?token=) carrying a node secret are accepted too, for runtimes that only
// know that header.
const NodeSecretHeader = "X-Node-Secret"

// LegacyTokenEnv toggles accepting the raw cluster token where a node secret
// is expected (default on in 3.3.x; "0"/"false"/"off"/"no" turns it off).
const LegacyTokenEnv = "STREAMHUB_CLUSTER_LEGACY_TOKEN"

// NodeSecret derives a node's credential ("" when either input is blank).
// The "node:" prefix keeps it disjoint from the scoped ingest tokens
// (HMAC(cluster token, "app:plugin:room"), two colons).
func NodeSecret(clusterToken, nodeID string) string {
	if clusterToken == "" || nodeID == "" {
		return ""
	}
	m := hmac.New(sha256.New, []byte(clusterToken))
	m.Write([]byte("node:" + nodeID))
	return hex.EncodeToString(m.Sum(nil))
}

// LegacyTokenAllowed reads STREAMHUB_CLUSTER_LEGACY_TOKEN (default on).
func LegacyTokenAllowed(env func(string) string) bool {
	if env == nil {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(env(LegacyTokenEnv))) {
	case "0", "false", "off", "no":
		return false
	}
	return true
}

// Credential is what a node presented.
type Credential int

const (
	// CredNone: nothing valid.
	CredNone Credential = iota
	// CredNode: the node's own secret.
	CredNode
	// CredLegacy: the raw cluster token (legacy mode only).
	CredLegacy
)

// NodeAuth verifies node credentials on the master.
type NodeAuth struct {
	db     *sql.DB
	token  func() string
	legacy bool
	log    *slog.Logger
	warned sync.Map
}

// NewNodeAuth builds the verifier. token returns STREAMHUB_CLUSTER_TOKEN;
// legacy is LegacyTokenAllowed at boot.
func NewNodeAuth(global *sql.DB, token func() string, legacy bool, log *slog.Logger) *NodeAuth {
	return &NodeAuth{db: global, token: token, legacy: legacy, log: log}
}

// Enabled reports a cluster token is configured (else the plane is 503).
func (a *NodeAuth) Enabled() bool { return a.token() != "" }

// Legacy reports whether the raw cluster token is still accepted.
func (a *NodeAuth) Legacy() bool { return a.legacy }

// Check matches provided values (blanks ignored) against nodeID's secret,
// then — legacy mode only — against the raw cluster token. surface names the
// caller in the legacy warning (logged once per surface and node).
func (a *NodeAuth) Check(surface, nodeID string, provided ...string) Credential {
	token := a.token()
	if token == "" {
		return CredNone
	}
	if want := NodeSecret(token, nodeID); want != "" {
		for _, p := range provided {
			if TokenMatches(p, want) {
				return CredNode
			}
		}
	}
	if a.legacy {
		for _, p := range provided {
			if TokenMatches(p, token) {
				a.warnLegacy(surface, nodeID)
				return CredLegacy
			}
		}
	}
	return CredNone
}

// CheckAny is Check for calls that carry no node id (bundle download): the
// secret of ANY registered node, or the raw token in legacy mode.
func (a *NodeAuth) CheckAny(ctx context.Context, surface string, provided ...string) Credential {
	token := a.token()
	if token == "" {
		return CredNone
	}
	if a.db != nil {
		rows, err := a.db.QueryContext(ctx, `SELECT id FROM nodes`)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var id string
				if rows.Scan(&id) != nil {
					continue
				}
				want := NodeSecret(token, id)
				for _, p := range provided {
					if TokenMatches(p, want) {
						return CredNode
					}
				}
			}
		}
	}
	return a.Check(surface, "", provided...)
}

func (a *NodeAuth) warnLegacy(surface, nodeID string) {
	if a.log == nil {
		return
	}
	if _, seen := a.warned.LoadOrStore(surface+"\x00"+nodeID, true); seen {
		return
	}
	who := ""
	if nodeID != "" {
		who = " (node " + nodeID + ")"
	}
	a.log.Warn("cluster: " + surface + " authenticated with the shared STREAMHUB_CLUSTER_TOKEN" + who +
		" — legacy mode; re-join the node to get its per-node secret, then set " + LegacyTokenEnv + "=off")
}
