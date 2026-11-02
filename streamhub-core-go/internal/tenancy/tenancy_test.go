package tenancy

import (
	"context"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/db"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

func TestBootstrapIdempotent(t *testing.T) {
	_, g, _ := testutil.Store(t)
	ctx := context.Background()
	s := New(g, "root@x.io", testutil.Log())
	s.Init(ctx)
	s.Init(ctx)
	for _, c := range userAuthColumns {
		if has, _ := db.HasColumn(ctx, g, "users", c.name); !has {
			t.Errorf("users.%s missing", c.name)
		}
	}
	if q := s.GetQuota(ctx, "platform"); q == nil || q.MaxApps != 100000 || q.MaxRecordingMinutesMonth != 100000000 {
		t.Fatalf("platform quota %+v", q)
	}
	admin := s.GetUser(ctx, AdminUserID)
	if admin == nil || !admin.IsSuperadmin || *admin.Email != "root@x.io" || admin.Status != "active" {
		t.Fatalf("admin mirror %+v", admin)
	}
	if s.RoleInTenant(ctx, AdminUserID, "platform") != RoleOwner || !s.IsSuperadmin(ctx, AdminUserID) {
		t.Fatal("admin membership")
	}
	// ADMIN_USER change re-mirrors the email.
	New(g, "new@x.io", testutil.Log()).Init(ctx)
	if *s.GetUser(ctx, AdminUserID).Email != "new@x.io" {
		t.Fatal("email not refreshed")
	}
	// No ADMIN_USER → nothing mirrored.
	_, g2, _ := testutil.Store(t)
	s2 := New(g2, "", testutil.Log())
	s2.Init(ctx)
	if s2.GetUser(ctx, AdminUserID) != nil {
		t.Fatal("admin mirrored without ADMIN_USER")
	}
}

func TestUsersTeamsMemberships(t *testing.T) {
	_, g, _ := testutil.Store(t)
	ctx := context.Background()
	s := New(g, "", testutil.Log())
	s.Init(ctx)
	hash := "scrypt$x"
	id, err := s.CreateUser(ctx, CreateUserInput{Email: "Ana@X.io", PasswordHash: &hash})
	if err != nil || len(id) != len("usr_")+36 {
		t.Fatalf("%s %v", id, err)
	}
	if u := s.GetUserByEmail(ctx, "ana@x.io"); u == nil || u.ID != id || u.Status != "active" {
		t.Fatal("case-insensitive lookup")
	}
	pending, _ := s.CreateUser(ctx, CreateUserInput{Email: "p@x.io", Status: "pending"})
	if u := s.GetUser(ctx, pending); u.Status != "pending" || u.PasswordHash != nil {
		t.Fatal("pending user")
	}
	s.SetPassword(ctx, pending, "scrypt$y")
	if s.GetUser(ctx, pending).Status != "active" {
		t.Fatal("SetPassword must activate")
	}

	team, _ := s.CreateTeam(ctx, "Acme", "")
	if tt := s.GetTenant(ctx, team); tt == nil || tt.Name != "Acme" || tt.Plan != "free" {
		t.Fatalf("%+v", tt)
	}
	if q := s.GetQuota(ctx, team); *q != FreePlanQuota {
		t.Fatalf("free quota %+v", q)
	}
	other, _ := s.EnsureTenant(ctx, "tnt_other", "", "")
	if s.GetTenant(ctx, other).Name != "tnt_other" {
		t.Fatal("name defaults to id")
	}

	s.AddMembership(ctx, id, other, RoleViewer)
	s.AddMembership(ctx, id, team, RoleEditor)
	g.Exec(`UPDATE memberships SET created_at = '2000-01-01 00:00:00' WHERE tenant_id = ?`, other)
	if m := s.PrimaryMembership(ctx, id); m.TenantID != other {
		t.Fatalf("earliest membership first: %+v", m)
	}
	s.AddMembership(ctx, id, team, RoleOwner) // upgrade
	if m := s.PrimaryMembership(ctx, id); m.TenantID != team || m.Role != RoleOwner {
		t.Fatalf("owner membership wins: %+v", m)
	}
	if s.MembershipCount(ctx, id) != 2 {
		t.Fatal("count")
	}
	s.AddMembership(ctx, pending, team, RoleViewer)
	members, _ := s.ListMembers(ctx, team)
	if len(members) != 2 || members[0].UserID != id || members[1].Role != RoleViewer || *members[0].Email != "Ana@X.io" {
		t.Fatalf("%+v", members)
	}
	if ok, _ := s.RemoveMembership(ctx, pending, team); !ok {
		t.Fatal("remove")
	}
	if ok, _ := s.RemoveMembership(ctx, pending, team); ok {
		t.Fatal("double remove")
	}
	s.DeleteUser(ctx, pending)
	if s.GetUser(ctx, pending) != nil {
		t.Fatal("delete")
	}

	name := "Ana"
	email := "ana2@x.io"
	s.UpdateProfile(ctx, id, ProfilePatch{SetName: true, Name: &name, Email: &email})
	if u := s.GetUser(ctx, id); *u.Name != "Ana" || *u.Email != "ana2@x.io" {
		t.Fatal("profile")
	}
	s.UpdateProfile(ctx, id, ProfilePatch{SetName: true})
	if s.GetUser(ctx, id).Name != nil {
		t.Fatal("name not cleared")
	}

	s.SetTotpPending(ctx, id, "enc")
	s.ActivateTotp(ctx, id)
	if st := s.GetTotpState(ctx, id); !st.Enabled || *st.Secret != "enc" || st.PendingSecret != nil {
		t.Fatalf("%+v", st)
	}
	s.ClearTotp(ctx, id)
	if st := s.GetTotpState(ctx, id); st.Enabled || st.Secret != nil {
		t.Fatal("clear")
	}

	on, host, port := true, "smtp.x", int64(2525)
	s.SetUserSmtp(ctx, id, SmtpPatch{Enabled: &on, Host: &host, Port: &port})
	if m := s.GetUserSmtp(ctx, id); !m.Enabled || m.Host != "smtp.x" || *m.Port != 2525 || m.PassEnc != nil {
		t.Fatalf("%+v", m)
	}
	if s.GetUserSmtp(ctx, "ghost") != nil {
		t.Fatal("unknown user smtp")
	}

	g.Exec(`INSERT INTO apps (id, name, tenant_id) VALUES (7, 'live', ?)`, team)
	if s.TenantForApp(ctx, "live") != team || s.TenantForAppID(ctx, 7) != team || s.TenantForApp(ctx, "nope") != "" {
		t.Fatal("app tenant lookups")
	}
}

// 3.3.3: users.email is unique case-insensitively — unless legacy duplicates
// (the email change used to be unverified) exist: then the index is NOT
// applied (logged) until an operator resolves them.
func TestEmailUniqueIndex(t *testing.T) {
	_, g, _ := testutil.Store(t)
	ctx := context.Background()
	s := New(g, "root@x.io", testutil.Log())
	hasIndex := func() bool {
		var n int
		g.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_email_lower'`).Scan(&n)
		return n == 1
	}
	g.Exec(`INSERT INTO users (id, email) VALUES ('u1', 'dup@x.io'), ('u2', 'DUP@X.io'), ('u3', NULL), ('u4', NULL)`)
	s.Init(ctx)
	if hasIndex() {
		t.Fatal("index applied over duplicates")
	}
	if a := s.GetUser(ctx, AdminUserID); a == nil || !a.IsSuperadmin {
		t.Fatal("the rest of the bootstrap still runs")
	}
	g.Exec(`UPDATE users SET email = 'other@x.io' WHERE id = 'u2'`)
	s.Init(ctx)
	if !hasIndex() {
		t.Fatal("index not applied once the duplicates are gone")
	}
	if _, err := g.Exec(`INSERT INTO users (id, email) VALUES ('u5', 'Other@X.io')`); err == nil {
		t.Fatal("case-insensitive duplicate accepted")
	}
	if _, err := g.Exec(`INSERT INTO users (id, email) VALUES ('u6', NULL)`); err != nil {
		t.Fatalf("NULL emails stay allowed: %v", err)
	}
	s.Init(ctx) // idempotent
	if !hasIndex() {
		t.Fatal("idempotent")
	}
}

// M2 (3.3.4): an invitation of an existing account is a pending membership —
// no role until accepted — and accepting it, even as owner, never moves the
// account's primary tenant.
func TestPendingMembershipLifecycle(t *testing.T) {
	_, g, _ := testutil.Store(t)
	ctx := context.Background()
	s := New(g, "", testutil.Log())
	s.Init(ctx)
	s.Init(ctx) // the column migration is idempotent
	for _, c := range membershipColumns {
		if has, _ := db.HasColumn(ctx, g, "memberships", c.name); !has {
			t.Fatalf("memberships.%s missing", c.name)
		}
	}
	hash := "scrypt$x"
	owner, _ := s.CreateUser(ctx, CreateUserInput{Email: "owner@x.io", PasswordHash: &hash})
	id, _ := s.CreateUser(ctx, CreateUserInput{Email: "bob@x.io", PasswordHash: &hash})
	own, _ := s.CreateTeam(ctx, "Bob", "")
	s.AddMembership(ctx, id, own, RoleEditor) // his first team, only as editor
	g.Exec(`UPDATE memberships SET created_at = '2000-01-01 00:00:00'`)
	other, _ := s.CreateTeam(ctx, "Other", "")
	if err := s.InviteMembership(ctx, id, other, RoleOwner, owner, MembershipPending); err != nil {
		t.Fatal(err)
	}
	if r := s.RoleInTenant(ctx, id, other); r != "" {
		t.Fatalf("a pending invitation granted %q", r)
	}
	if m := s.PrimaryMembership(ctx, id); m.TenantID != own {
		t.Fatalf("pending invitation became primary: %+v", m)
	}
	if m := s.GetMembership(ctx, id, other); m == nil || m.Status != MembershipPending || m.Role != RoleOwner {
		t.Fatalf("%+v", m)
	}
	members, _ := s.ListMembers(ctx, other)
	if len(members) != 1 || members[0].Status != "pending" {
		t.Fatalf("a pending membership lists as pending: %+v", members)
	}
	inv, _ := s.UserTenants(ctx, id, MembershipPending)
	if len(inv) != 1 || inv[0].TenantID != other || inv[0].TenantName != "Other" || inv[0].InvitedBy == nil || *inv[0].InvitedBy != "owner@x.io" {
		t.Fatalf("%+v", inv)
	}
	// Re-inviting only changes the role, never the status.
	s.InviteMembership(ctx, id, other, RoleViewer, owner, MembershipActive)
	if m := s.GetMembership(ctx, id, other); m.Status != MembershipPending || m.Role != RoleViewer {
		t.Fatalf("re-invite activated the membership: %+v", m)
	}
	s.InviteMembership(ctx, id, other, RoleOwner, owner, MembershipPending)

	if ok, _ := s.AcceptMembership(ctx, id, other); !ok {
		t.Fatal("accept")
	}
	if ok, _ := s.AcceptMembership(ctx, id, other); ok {
		t.Fatal("accept twice")
	}
	if s.RoleInTenant(ctx, id, other) != RoleOwner {
		t.Fatal("an accepted membership grants its role")
	}
	if m := s.PrimaryMembership(ctx, id); m.TenantID != own {
		t.Fatalf("accepting an owner invitation moved the primary tenant: %+v", m)
	}
	if ok, _ := s.DeclineMembership(ctx, id, other); ok {
		t.Fatal("decline must not drop an active membership")
	}

	third, _ := s.CreateTeam(ctx, "Third", "")
	s.InviteMembership(ctx, id, third, RoleViewer, owner, MembershipPending)
	if ok, _ := s.DeclineMembership(ctx, id, third); !ok || s.GetMembership(ctx, id, third) != nil {
		t.Fatal("decline")
	}
}
