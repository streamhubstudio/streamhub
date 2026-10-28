package tenancy

import (
	"context"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
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
