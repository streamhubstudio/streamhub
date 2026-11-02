package auth

import (
	"fmt"
	"net/http"
	"strings"
)

// DefaultOperatorRoutes are the mutating routes an operator may call ('*'
// matches exactly one path segment). Every other non-GET route needs admin.
var DefaultOperatorRoutes = []string{
	"POST /api/v1/channels/*/start",
	"POST /api/v1/channels/*/stop",
	"POST /api/v1/channels/*/restart",
	"POST /api/v1/channels/*/outputs/*/restart",
	"POST /api/v1/channels/*/scte35",
	"POST /api/v1/alarms/*/ack",
}

// DefaultAdminReadPrefixes are read routes reserved to admins because they
// expose secrets or security data (prefix match on a path-segment boundary).
var DefaultAdminReadPrefixes = []string{
	"/api/v1/users",
	"/api/v1/tokens",
	"/api/v1/audit",
	"/api/v1/config/backup",
}

type routePattern struct {
	method string
	segs   []string
}

type policy struct {
	operator   []routePattern
	adminReads []string
}

func newPolicy(extraOps, extraAdminReads []string) (*policy, error) {
	p := &policy{}
	for _, r := range append(append([]string{}, DefaultOperatorRoutes...), extraOps...) {
		m, path, ok := strings.Cut(strings.TrimSpace(r), " ")
		if !ok || m == "" || !strings.HasPrefix(path, "/") {
			return nil, fmt.Errorf("auth: bad operator route %q (want \"METHOD /path\")", r)
		}
		p.operator = append(p.operator, routePattern{method: strings.ToUpper(m), segs: splitPath(path)})
	}
	for _, pre := range append(append([]string{}, DefaultAdminReadPrefixes...), extraAdminReads...) {
		p.adminReads = append(p.adminReads, strings.TrimSuffix(pre, "/"))
	}
	return p, nil
}

func splitPath(p string) []string { return strings.Split(strings.Trim(p, "/"), "/") }

func (rp routePattern) match(method string, segs []string) bool {
	if rp.method != method || len(rp.segs) != len(segs) {
		return false
	}
	for i, s := range rp.segs {
		if s == "*" {
			if segs[i] == "" {
				return false
			}
		} else if s != segs[i] {
			return false
		}
	}
	return true
}

func isRead(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions
}

func hasSegPrefix(path, prefix string) bool {
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

// minRole returns the role needed for an authenticated API request.
func (p *policy) minRole(method, path string) Role {
	if isRead(method) {
		for _, pre := range p.adminReads {
			if hasSegPrefix(path, pre) {
				return RoleAdmin
			}
		}
		return RoleViewer
	}
	segs := splitPath(path)
	for _, rp := range p.operator {
		if rp.match(method, segs) {
			return RoleOperator
		}
	}
	return RoleAdmin
}

// access is the outcome of classifying a request.
type access int

const (
	accessPublic   access = iota // no principal needed
	accessAuthOnly               // any principal; exempt from the mustChangePassword gate
	accessRole                   // principal with at least the returned role
)

// classify decides how a (cleaned) request path is protected.
func (a *Auth) classify(method, path string) (access, Role) {
	read := isRead(method)
	isAPI := path == "/api" || strings.HasPrefix(path, "/api/")
	if !isAPI {
		if path == "/metrics" {
			if read && a.metrics.Load() {
				return accessPublic, ""
			}
			if read {
				return accessRole, RoleViewer
			}
			return accessRole, RoleAdmin
		}
		if read { // static web UI
			return accessPublic, ""
		}
		return accessRole, RoleAdmin
	}
	switch {
	case read && path == "/api/v1/health",
		read && hasSegPrefixLoose(path, "/api/v1/docs"),
		read && hasSegPrefixLoose(path, "/api/v1/openapi"),
		read && hasSegPrefixLoose(path, "/api/v1/schemas"),
		method == http.MethodPost && path == "/api/v1/auth/login",
		method == http.MethodPost && path == "/api/v1/auth/logout":
		return accessPublic, ""
	case hasSegPrefix(path, "/api/v1/auth"):
		return accessAuthOnly, ""
	}
	return accessRole, a.policy.minRole(method, path)
}

// hasSegPrefixLoose matches huma's doc routes: /api/v1/openapi.json,
// /api/v1/openapi-3.0.yaml, /api/v1/schemas/X.json, /api/v1/docs.
func hasSegPrefixLoose(path, prefix string) bool { return strings.HasPrefix(path, prefix) }
