package auth

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Register mounts the auth, users, tokens and audit endpoints on mux:
//
//	POST   /api/v1/auth/login     {user,password} → {user,role,mustChangePassword} + enc_session cookie (public)
//	POST   /api/v1/auth/logout    ends the cookie session (204)
//	GET    /api/v1/auth/me        the current Principal
//	POST   /api/v1/auth/password  {current,new} (users only; new ≥ 10 chars)
//	GET    /api/v1/users          admin
//	POST   /api/v1/users          {name,password,role,mustChangePassword?} admin
//	PATCH  /api/v1/users/{name}   {role?,password?,disabled?,mustChangePassword?} admin
//	DELETE /api/v1/users/{name}   admin (never the last admin)
//	GET    /api/v1/tokens         admin
//	POST   /api/v1/tokens         {name,role} → plaintext token once, admin
//	DELETE /api/v1/tokens/{id}    revoke, admin
//	GET    /api/v1/audit?limit=N  newest first (default 200, max 5000), admin
//
// The handlers re-check the role themselves, but the policy, CSRF and
// mustChangePassword gates live in Middleware: always serve mux through it.
func (a *Auth) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/auth/login", a.handleLogin)
	mux.HandleFunc("POST /api/v1/auth/logout", a.handleLogout)
	mux.HandleFunc("GET /api/v1/auth/me", a.handleMe)
	mux.HandleFunc("POST /api/v1/auth/password", a.handlePassword)
	mux.HandleFunc("GET /api/v1/users", a.admin(a.handleUsersList))
	mux.HandleFunc("POST /api/v1/users", a.admin(a.handleUsersCreate))
	mux.HandleFunc("PATCH /api/v1/users/{name}", a.admin(a.handleUsersPatch))
	mux.HandleFunc("DELETE /api/v1/users/{name}", a.admin(a.handleUsersDelete))
	mux.HandleFunc("GET /api/v1/tokens", a.admin(a.handleTokensList))
	mux.HandleFunc("POST /api/v1/tokens", a.admin(a.handleTokensCreate))
	mux.HandleFunc("DELETE /api/v1/tokens/{id}", a.admin(a.handleTokensDelete))
	mux.HandleFunc("GET /api/v1/audit", a.admin(a.handleAudit))
}

// LoginResponse is the body of a successful login / password change.
type LoginResponse struct {
	User               string `json:"user"`
	Role               Role   `json:"role"`
	MustChangePassword bool   `json:"mustChangePassword"`
}

// CreatedToken is the body of POST /api/v1/tokens: the only time the
// plaintext token is ever shown.
type CreatedToken struct {
	TokenInfo
	Token string `json:"token"`
}

func (a *Auth) handleLogin(w http.ResponseWriter, r *http.Request) {
	st := stateFrom(r.Context())
	st.event = "login_failed"
	// JSON only: a cross-site form/text post would need a CORS preflight.
	if !isJSON(r) {
		writeProblem(w, http.StatusUnsupportedMediaType, "Content-Type must be application/json")
		return
	}
	var body struct {
		User     string `json:"user"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	name := strings.ToLower(strings.TrimSpace(body.User))
	st.name = name
	if wait, blocked := a.limiter.blocked(name, st.ip); blocked {
		secs := int(wait.Round(time.Second) / time.Second)
		if secs < 1 {
			secs = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(secs))
		writeProblem(w, http.StatusTooManyRequests, "too many failed logins; retry in "+strconv.Itoa(secs)+" s")
		return
	}
	u, found := a.store.getUser(name)
	hash := ""
	if found {
		hash = u.PasswordHash
	}
	if ok := a.verifyPassword(hash, body.Password); !ok || !found || u.Disabled {
		a.limiter.fail(name, st.ip)
		writeProblem(w, http.StatusUnauthorized, "invalid user or password")
		return
	}
	a.limiter.success(name, st.ip)
	if c, err := r.Cookie(SessionCookie); err == nil {
		a.sessions.delete(c.Value) // never keep a pre-login session id
	}
	a.setSessionCookie(w, r, a.sessions.create(u.Name))
	st.event = "login"
	st.principal = &Principal{Name: u.Name, Role: u.Role, Kind: KindUser, MustChangePassword: u.MustChangePassword}
	writeJSON(w, http.StatusOK, LoginResponse{User: u.Name, Role: u.Role, MustChangePassword: u.MustChangePassword})
}

func (a *Auth) handleLogout(w http.ResponseWriter, r *http.Request) {
	st := stateFrom(r.Context())
	st.event = "logout"
	if c, err := r.Cookie(SessionCookie); err == nil {
		a.sessions.delete(c.Value)
	}
	a.clearSessionCookie(w, r)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (a *Auth) handleMe(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		writeProblem(w, http.StatusUnauthorized, "authentication required")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (a *Auth) handlePassword(w http.ResponseWriter, r *http.Request) {
	st := stateFrom(r.Context())
	st.event = "password_change"
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		writeProblem(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if p.Kind != KindUser {
		writeProblem(w, http.StatusBadRequest, "only user accounts have a password")
		return
	}
	var body struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if wait, blocked := a.limiter.blocked(p.Name, st.ip); blocked {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(wait/time.Second))))
		writeProblem(w, http.StatusTooManyRequests, "too many failed attempts")
		return
	}
	switch err := a.changeOwnPassword(p.Name, body.Current, body.New); {
	case errors.Is(err, errBadCurrentPassword):
		a.limiter.fail(p.Name, st.ip)
		writeProblem(w, http.StatusForbidden, err.Error())
		return
	case err != nil:
		writeErr(w, err)
		return
	}
	a.limiter.success(p.Name, st.ip)
	// Rotate: end every session of the user (other browsers included) and
	// issue a fresh one to this client.
	a.sessions.deleteUser(p.Name, "")
	a.setSessionCookie(w, r, a.sessions.create(p.Name))
	if p.Name == bootstrapUser {
		if err := os.Remove(a.initialPasswordPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
			a.log.Warn("auth: remove initial-admin-password", "err", err)
		}
	}
	writeJSON(w, http.StatusOK, LoginResponse{User: p.Name, Role: p.Role, MustChangePassword: false})
}

// admin wraps a handler with an admin check (defense in depth behind
// Middleware's policy).
func (a *Auth) admin(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFrom(r.Context())
		if !ok {
			writeProblem(w, http.StatusUnauthorized, "authentication required")
			return
		}
		if !p.Role.AtLeast(RoleAdmin) || p.MustChangePassword {
			writeProblem(w, http.StatusForbidden, "admin role required")
			return
		}
		h(w, r)
	}
}

func (a *Auth) handleUsersList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.Users())
}

func (a *Auth) handleUsersCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name               string `json:"name"`
		Password           string `json:"password"`
		Role               Role   `json:"role"`
		MustChangePassword *bool  `json:"mustChangePassword"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	must := true
	if body.MustChangePassword != nil {
		must = *body.MustChangePassword
	}
	u, err := a.CreateUser(body.Name, body.Password, body.Role, must)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

func (a *Auth) handleUsersPatch(w http.ResponseWriter, r *http.Request) {
	var p UserPatch
	if !decodeBody(w, r, &p) {
		return
	}
	u, err := a.UpdateUser(r.PathValue("name"), p)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (a *Auth) handleUsersDelete(w http.ResponseWriter, r *http.Request) {
	if err := a.DeleteUser(r.PathValue("name")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *Auth) handleTokensList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.Tokens())
}

func (a *Auth) handleTokensCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		Role Role   `json:"role"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	t, plain, err := a.CreateToken(body.Name, body.Role)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, CreatedToken{TokenInfo: t, Token: plain})
}

func (a *Auth) handleTokensDelete(w http.ResponseWriter, r *http.Request) {
	if err := a.RevokeToken(r.PathValue("id")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *Auth) handleAudit(w http.ResponseWriter, r *http.Request) {
	limit := 200
	if s := r.URL.Query().Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > maxAuditLimit {
			writeProblem(w, http.StatusUnprocessableEntity, "limit must be 1-"+strconv.Itoa(maxAuditLimit))
			return
		}
		limit = n
	}
	lines, err := a.audit.Tail(limit)
	if err != nil {
		writeProblem(w, http.StatusInternalServerError, "read audit log: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, lines)
}

func (a *Auth) setSessionCookie(w http.ResponseWriter, r *http.Request, id string) {
	http.SetCookie(w, &http.Cookie{Name: SessionCookie, Value: id, Path: "/", HttpOnly: true,
		Secure: a.isHTTPS(r), SameSite: http.SameSiteStrictMode, MaxAge: int(a.sessions.max / time.Second)})
}

func (a *Auth) clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: SessionCookie, Value: "", Path: "/", HttpOnly: true,
		Secure: a.isHTTPS(r), SameSite: http.SameSiteStrictMode, MaxAge: -1})
}

func isJSON(r *http.Request) bool {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && (mt == "application/json" || strings.HasSuffix(mt, "+json"))
}

// decodeBody strictly decodes a ≤64 KiB JSON body, writing the error itself.
func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeProblem(w, http.StatusRequestEntityTooLarge, "request body too large")
			return false
		}
		if errors.Is(err, io.EOF) {
			writeProblem(w, http.StatusBadRequest, "request body required")
			return false
		}
		writeProblem(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return false
	}
	if dec.More() {
		writeProblem(w, http.StatusBadRequest, "invalid JSON: trailing data")
		return false
	}
	return true
}

func writeErr(w http.ResponseWriter, err error) {
	var (
		ie invalidErr
		ce conflictErr
		ne notFoundErr
	)
	switch {
	case errors.As(err, &ie):
		writeProblem(w, http.StatusUnprocessableEntity, ie.Error())
	case errors.As(err, &ce):
		writeProblem(w, http.StatusConflict, ce.Error())
	case errors.As(err, &ne):
		writeProblem(w, http.StatusNotFound, ne.Error())
	default:
		writeProblem(w, http.StatusInternalServerError, err.Error())
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
