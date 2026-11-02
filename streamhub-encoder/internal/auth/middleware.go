package auth

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net"
	"net/http"
	"net/netip"
	"path"
	"strings"
	"time"
)

// reqState is shared between Middleware and the auth handlers of one request
// so the handlers can enrich the audit line (login user, event name).
type reqState struct {
	principal *Principal
	viaCookie bool
	sessionID string
	event     string // overrides "request"
	name      string // principal name to audit when no principal (login attempts)
	ip        string
}

type stateKey struct{}

func stateFrom(ctx context.Context) *reqState {
	st, _ := ctx.Value(stateKey{}).(*reqState)
	if st == nil {
		st = &reqState{}
	}
	return st
}

// Middleware authenticates every request, enforces the role policy, the
// mustChangePassword gate and the CSRF header, attaches the Principal to the
// context and writes the audit log. Wrap the whole ServeMux with it.
func (a *Auth) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := a.now()
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")

		st := &reqState{ip: a.clientIP(r)}
		rec := &statusRecorder{ResponseWriter: w}
		ctx := context.WithValue(r.Context(), stateKey{}, st)
		r = r.WithContext(ctx)
		defer func() {
			if st.event != "" || !isRead(r.Method) {
				a.writeAudit(st, r, rec.code(), a.now().Sub(start))
			}
		}()

		p := cleanPath(r.URL.Path)
		isAPI := p == "/api" || strings.HasPrefix(p, "/api/")
		if isAPI && strings.Contains(strings.ToLower(r.URL.EscapedPath()), "%2f") {
			writeProblem(rec, http.StatusBadRequest, "encoded slashes are not allowed in API paths")
			return
		}
		acc, role := a.classify(r.Method, p)

		pr, viaCookie, authErr := a.authenticate(r, st)
		if pr != nil {
			st.principal, st.viaCookie = pr, viaCookie
			r = r.WithContext(WithPrincipal(r.Context(), *pr))
		}
		if acc == accessPublic {
			// Login does not use the cookie, so it is exempt; logout is not.
			if pr != nil && viaCookie && !isRead(r.Method) && p != "/api/v1/auth/login" && !csrfOK(r) {
				writeProblem(rec, http.StatusForbidden, "missing header X-Requested-With: "+UIHeaderValue+" (CSRF protection)")
				return
			}
			next.ServeHTTP(rec, r)
			return
		}
		if pr == nil {
			detail := "authentication required"
			if authErr != "" {
				detail = authErr
			}
			rec.Header().Set("WWW-Authenticate", `Bearer realm="encoderd"`)
			writeProblem(rec, http.StatusUnauthorized, detail)
			return
		}
		if viaCookie && !isRead(r.Method) && !csrfOK(r) {
			writeProblem(rec, http.StatusForbidden, "missing header X-Requested-With: "+UIHeaderValue+" (CSRF protection)")
			return
		}
		if acc == accessRole {
			if pr.MustChangePassword {
				writeProblem(rec, http.StatusForbidden, "password change required: POST /api/v1/auth/password")
				return
			}
			if !pr.Role.AtLeast(role) {
				writeProblem(rec, http.StatusForbidden, "role "+string(pr.Role)+" is not allowed to "+r.Method+" "+p+" (needs "+string(role)+")")
				return
			}
		}
		next.ServeHTTP(rec, r)
	})
}

func csrfOK(r *http.Request) bool { return r.Header.Get("X-Requested-With") == UIHeaderValue }

// cleanPath canonicalizes like ServeMux (which would redirect anyway), so the
// policy can not be bypassed with "//", "/./" or "/../" tricks.
func cleanPath(p string) string {
	if p == "" {
		return "/"
	}
	if p[0] != '/' {
		p = "/" + p
	}
	np := path.Clean(p)
	if strings.HasSuffix(p, "/") && np != "/" {
		np += "/"
	}
	return np
}

// authenticate resolves the caller: an Authorization bearer token (API token
// or legacy token) takes precedence over the session cookie. It returns a
// non-empty reason when credentials were presented but rejected.
func (a *Auth) authenticate(r *http.Request, st *reqState) (*Principal, bool, string) {
	if hdr := r.Header.Get("Authorization"); hdr != "" {
		scheme, tok, ok := strings.Cut(hdr, " ")
		tok = strings.TrimSpace(tok)
		if !ok || !strings.EqualFold(scheme, "Bearer") || tok == "" {
			return nil, false, "unsupported Authorization scheme (use Bearer)"
		}
		if p, ok := a.tokenPrincipal(tok); ok {
			return p, false, ""
		}
		return nil, false, "invalid, revoked or unknown bearer token"
	}
	c, err := r.Cookie(SessionCookie)
	if err != nil || c.Value == "" {
		return nil, false, ""
	}
	user, ok := a.sessions.get(c.Value)
	if !ok {
		return nil, false, "session expired or invalid; log in again"
	}
	u, ok := a.store.getUser(user)
	if !ok || u.Disabled {
		a.sessions.delete(c.Value)
		return nil, false, "session expired or invalid; log in again"
	}
	st.sessionID = c.Value
	return &Principal{Name: u.Name, Role: u.Role, Kind: KindUser, MustChangePassword: u.MustChangePassword}, true, ""
}

func (a *Auth) tokenPrincipal(tok string) (*Principal, bool) {
	if a.legacyMatches(tok) {
		return &Principal{Name: "legacy-token", Role: RoleAdmin, Kind: KindLegacy}, true
	}
	if !strings.HasPrefix(tok, TokenPrefix) || len(tok) > 256 {
		return nil, false
	}
	t, ok := a.store.tokenByHash(sha256.Sum256([]byte(tok)))
	if !ok || t.Revoked || !t.Role.Valid() {
		return nil, false
	}
	if err := a.store.touchToken(t.ID, a.now()); err != nil {
		a.log.Warn("auth: persist token lastUsedAt", "err", err)
	}
	return &Principal{Name: t.Name, Role: t.Role, Kind: KindToken, TokenID: t.ID}, true
}

// clientIP is the peer address, or — when the peer is a trusted proxy — the
// right-most X-Forwarded-For hop that is not itself a trusted proxy.
func (a *Auth) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	peer = peer.Unmap()
	if !a.isTrusted(peer) {
		return peer.String()
	}
	xff := r.Header.Values("X-Forwarded-For")
	var hops []string
	for _, v := range xff {
		for _, h := range strings.Split(v, ",") {
			if h = strings.TrimSpace(h); h != "" {
				hops = append(hops, h)
			}
		}
	}
	for i := len(hops) - 1; i >= 0; i-- {
		ip, err := netip.ParseAddr(hops[i])
		if err != nil {
			break // garbage: stop trusting the chain here
		}
		ip = ip.Unmap()
		if !a.isTrusted(ip) {
			return ip.String()
		}
		peer = ip
	}
	return peer.String()
}

func (a *Auth) isTrusted(ip netip.Addr) bool {
	for _, p := range a.trusted {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// isHTTPS decides the cookie Secure flag.
func (a *Auth) isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip, err := netip.ParseAddr(host)
	return err == nil && a.isTrusted(ip.Unmap()) && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func (a *Auth) writeAudit(st *reqState, r *http.Request, status int, d time.Duration) {
	e := AuditEntry{At: a.now().UTC(), Event: st.event, IP: st.ip, Method: r.Method,
		Path: truncate(r.URL.Path, 512), Status: status, DurationMs: d.Milliseconds()}
	if e.Event == "" {
		e.Event = "request"
	}
	if p := st.principal; p != nil {
		e.Principal, e.Role, e.Kind, e.TokenID = p.Name, p.Role, p.Kind, p.TokenID
	} else {
		e.Principal = truncate(st.name, 64)
	}
	if err := a.audit.Write(e); err != nil {
		a.log.Error("auth: audit write failed", "err", err)
	}
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// statusRecorder captures the response status for the audit log.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

// Flush keeps streaming responses working through the recorder.
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		if s.status == 0 {
			s.status = http.StatusOK
		}
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func (s *statusRecorder) code() int {
	if s.status == 0 {
		return http.StatusOK
	}
	return s.status
}

// writeProblem writes an RFC 7807-style error like huma does.
func writeProblem(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"title": http.StatusText(status), "status": status, "detail": detail})
}
