// Package cluster ports modules/cluster: the global `nodes` registry (edge
// join + heartbeat over X-Cluster-Token, the dashboard manager), the origin's
// boot self-registration, the DB-driven node ROLE (standalone|master|edge,
// seeded from STREAMHUB_NODE_ROLE on first boot) and the standalone↔cluster
// conversion (join-master / leave).
package cluster

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// DisabledMessage is the 503 text of the node-facing plane when
// STREAMHUB_CLUSTER_TOKEN is unset.
const DisabledMessage = "cluster joining disabled (STREAMHUB_CLUSTER_TOKEN unset)"

// TokenMatches is a constant-time compare over SHA-256 digests; an empty
// provided token never matches.
func TokenMatches(provided, expected string) bool {
	if provided == "" {
		return false
	}
	a := sha256.Sum256([]byte(provided))
	b := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

// ErrorBody is the {error} body Nest emits for an exception built from an
// object (`new NotFoundException({ error: 'unknown node' })`).
type ErrorBody struct {
	Error string `json:"error"`
}

// ObjErr is an HTTP error whose body is exactly {error: msg}.
func ObjErr(status int, msg string) *httpx.Error {
	return &httpx.Error{Status: status, Body: ErrorBody{msg}}
}

// AssertToken enforces X-Cluster-Token against expected: unset → 503
// (disabledMessage, "" = DisabledMessage), wrong/absent → 401 after calling
// onInvalid (the auto-ban hook; never on the 503 path).
func AssertToken(r *http.Request, expected, disabledMessage string, onInvalid func()) error {
	if expected == "" {
		if disabledMessage == "" {
			disabledMessage = DisabledMessage
		}
		return ObjErr(http.StatusServiceUnavailable, disabledMessage)
	}
	if !TokenMatches(r.Header.Get("X-Cluster-Token"), expected) {
		if onInvalid != nil {
			onInvalid()
		}
		return ObjErr(http.StatusUnauthorized, "invalid cluster token")
	}
	return nil
}
