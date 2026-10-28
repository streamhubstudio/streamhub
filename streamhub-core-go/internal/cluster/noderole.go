package cluster

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
)

// Roles a node can play.
const (
	RoleStandalone = "standalone"
	RoleMaster     = "master"
	RoleEdge       = "edge"
)

// _streamhub_meta keys owned by NodeRole.
const (
	metaRole         = "node_role"
	metaMasterURL    = "master_url"
	metaMasterNodeID = "master_node_id"
)

// CoerceRole maps arbitrary input to a known role (default standalone).
func CoerceRole(raw string) string {
	switch v := strings.ToLower(strings.TrimSpace(raw)); v {
	case RoleStandalone, RoleMaster, RoleEdge:
		return v
	}
	return RoleStandalone
}

// NodeRole is NodeRoleService: the role lives in the global _streamhub_meta
// KV; the env only seeds it on first boot. It satisfies authn.NodeRole.
type NodeRole struct {
	db  *sql.DB
	env func(string) string
	log *slog.Logger
}

// NewNodeRole builds the service.
func NewNodeRole(global *sql.DB, env func(string) string, log *slog.Logger) *NodeRole {
	return &NodeRole{db: global, env: env, log: log}
}

// Seed is onModuleInit: write node_role (and master_url) from
// STREAMHUB_NODE_ROLE / STREAMHUB_MASTER_URL unless the KV already holds a
// role. Never fails boot.
func (n *NodeRole) Seed(ctx context.Context) {
	if _, ok := n.get(ctx, metaRole); ok {
		return
	}
	role := CoerceRole(n.env("STREAMHUB_NODE_ROLE"))
	if err := n.set(ctx, metaRole, role); err != nil {
		n.log.Error("node-role seed failed (continuing): " + err.Error())
		return
	}
	master := strings.TrimRight(strings.TrimSpace(n.env("STREAMHUB_MASTER_URL")), "/")
	if master != "" {
		_ = n.set(ctx, metaMasterURL, master)
	}
	suffix := ""
	if master != "" {
		suffix = fmt.Sprintf(" master='%s'", master)
	}
	n.log.Info(fmt.Sprintf("node-role seeded from env: role='%s'%s", role, suffix))
}

// Role is the current role (KV → standalone).
func (n *NodeRole) Role(ctx context.Context) string {
	v, _ := n.get(ctx, metaRole)
	return CoerceRole(v)
}

// IsEdge reports role edge (login locked).
func (n *NodeRole) IsEdge(ctx context.Context) bool { return n.Role(ctx) == RoleEdge }

// MasterURL is the stored master URL without trailing slashes (nil if blank).
func (n *NodeRole) MasterURL(ctx context.Context) *string {
	v, _ := n.get(ctx, metaMasterURL)
	v = strings.TrimRight(strings.TrimSpace(v), "/")
	if v == "" {
		return nil
	}
	return &v
}

// MasterNodeID is this edge's id at the master (nil if unknown).
func (n *NodeRole) MasterNodeID(ctx context.Context) *string {
	v, _ := n.get(ctx, metaMasterNodeID)
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	return &v
}

// SetRole persists a (coerced) role.
func (n *NodeRole) SetRole(ctx context.Context, role string) error {
	r := CoerceRole(role)
	if err := n.set(ctx, metaRole, r); err != nil {
		return err
	}
	n.log.Info(fmt.Sprintf("node role set to '%s'", r))
	return nil
}

// SetMasterURL persists (or clears, when blank) the master URL.
func (n *NodeRole) SetMasterURL(ctx context.Context, url string) error {
	v := strings.TrimRight(strings.TrimSpace(url), "/")
	if v == "" {
		return n.del(ctx, metaMasterURL)
	}
	return n.set(ctx, metaMasterURL, v)
}

// SetMasterNodeID persists (or clears) this edge's id at the master.
func (n *NodeRole) SetMasterNodeID(ctx context.Context, id string) error {
	v := strings.TrimSpace(id)
	if v == "" {
		return n.del(ctx, metaMasterNodeID)
	}
	return n.set(ctx, metaMasterNodeID, v)
}

func (n *NodeRole) get(ctx context.Context, key string) (string, bool) {
	var v sql.NullString
	if err := n.db.QueryRowContext(ctx, `SELECT value FROM _streamhub_meta WHERE key = ?`, key).Scan(&v); err != nil {
		return "", false
	}
	return v.String, true
}

func (n *NodeRole) set(ctx context.Context, key, value string) error {
	_, err := n.db.ExecContext(ctx, `INSERT INTO _streamhub_meta (key, value, updated_at)
           VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
           updated_at = excluded.updated_at`, key, value)
	return err
}

func (n *NodeRole) del(ctx context.Context, key string) error {
	_, err := n.db.ExecContext(ctx, `DELETE FROM _streamhub_meta WHERE key = ?`, key)
	return err
}
