package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

func newService(t *testing.T, env map[string]string) (*Service, *sql.DB) {
	t.Helper()
	_, g, _ := testutil.Store(t)
	s := New(g, func(k string) string { return env[k] }, testutil.Log())
	s.Init(context.Background())
	return s, g
}

// testdata/chain_vectors.json: the Node chain hash
// sha256((prev ?? ”) + JSON.stringify([ts, actorType, actorId, tenantId,
// action, targetType, targetId, ip, result, metaJson])) over rows with
// nulls, HTML-ish characters and U+2028 (JSON.stringify leaves both raw).
func TestChainHashMatchesNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/chain_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vecs []struct {
		Prev      *string   `json:"prev"`
		Fields    []*string `json:"fields"`
		Canonical string    `json:"canonical"`
		Hash      string    `json:"hash"`
	}
	if err := json.Unmarshal(raw, &vecs); err != nil {
		t.Fatal(err)
	}
	for i, v := range vecs {
		if got := chainHash(v.Prev, v.Fields); got != v.Hash {
			t.Errorf("vector %d: hash %s, want %s", i, got, v.Hash)
		}
	}
}

func TestInitIdempotent(t *testing.T) {
	s, _ := newService(t, nil)
	s.Init(context.Background())
	if s.Count(context.Background()) != 0 {
		t.Fatal("fresh trail not empty")
	}
}

func TestRecordPersistsAndDefaults(t *testing.T) {
	s, _ := newService(t, nil)
	ctx := context.Background()
	s.Record(ctx, Event{Action: "x.default"})
	s.Record(ctx, Event{
		Action: "token.create", ActorType: ActorToken, ActorID: Str("token:1"), TenantID: Str("platform"),
		TargetType: Str("token"), TargetID: Str("7"), IP: Str("203.0.113.9"), Result: Failure,
		Meta: struct {
			Name string `json:"name"`
		}{"ci"},
	})
	page, err := s.Query(ctx, Query{})
	if err != nil || page.Total != 2 {
		t.Fatalf("%+v %v", page, err)
	}
	full, def := page.Entries[0], page.Entries[1]
	if def.ActorType != "system" || def.Result != "success" || def.ActorID != nil || def.IP != nil || string(def.Meta) != "null" {
		t.Fatalf("defaults %+v", def)
	}
	if full.ActorType != "token" || *full.ActorID != "token:1" || *full.TargetID != "7" || full.Result != "failure" || string(full.Meta) != `{"name":"ci"}` {
		t.Fatalf("full %+v", full)
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", full.Ts); err != nil {
		t.Fatalf("ts %q not toISOString", full.Ts)
	}
	// Never panics / fails on unserializable meta.
	s.Record(ctx, Event{Action: "x.bad", Meta: make(chan int)})
	page, _ = s.Query(ctx, Query{Action: "x.bad"})
	if page.Total != 1 || string(page.Entries[0].Meta) != `{"note":"meta not serializable"}` {
		t.Fatalf("bad meta %+v", page.Entries)
	}
}

func TestAppendOnlyTriggers(t *testing.T) {
	s, g := newService(t, nil)
	s.Record(context.Background(), Event{Action: "a"})
	if _, err := g.Exec(`UPDATE audit_log SET action = 'b'`); err == nil {
		t.Fatal("UPDATE allowed")
	}
	if _, err := g.Exec(`DELETE FROM audit_log`); err == nil {
		t.Fatal("DELETE allowed")
	}
}

func TestChainVerifyAndTamper(t *testing.T) {
	s, g := newService(t, nil)
	ctx := context.Background()
	for _, a := range []string{"a", "b", "c"} {
		s.Record(ctx, Event{Action: a})
	}
	if r := s.VerifyChain(ctx); !r.OK || r.Checked != 3 || r.BrokenAt != nil {
		t.Fatalf("clean chain %+v", r)
	}
	testutil.Exec(t, g, `DROP TRIGGER audit_log_no_update`)
	testutil.Exec(t, g, `UPDATE audit_log SET action = 'evil' WHERE id = 2`)
	if r := s.VerifyChain(ctx); r.OK || r.BrokenAt == nil || *r.BrokenAt != 2 {
		t.Fatalf("tamper not detected %+v", r)
	}
}

func TestQueryFiltersAndPaging(t *testing.T) {
	s, _ := newService(t, nil)
	ctx := context.Background()
	s.Record(ctx, Event{Action: "auth.login", ActorID: Str("alice")})
	s.Record(ctx, Event{Action: "auth.logout", ActorID: Str("bob"), Result: Failure})
	s.Record(ctx, Event{Action: "token.create", ActorID: Str("alice")})
	s.Record(ctx, Event{Action: "auth_x", ActorID: Str("carol")}) // '_' must not wildcard
	count := func(q Query) int {
		p, err := s.Query(ctx, q)
		if err != nil {
			t.Fatal(err)
		}
		return p.Total
	}
	if count(Query{Action: "auth."}) != 2 || count(Query{Actor: "alice"}) != 2 || count(Query{Result: "failure"}) != 1 {
		t.Fatal("filters")
	}
	one := 1
	p, _ := s.Query(ctx, Query{Limit: &one, Offset: &one})
	if p.Total != 4 || len(p.Entries) != 1 || p.Entries[0].Action != "token.create" {
		t.Fatalf("paging %+v", p)
	}
	big, neg := 9999, -5
	p, _ = s.Query(ctx, Query{Limit: &big, Offset: &neg})
	if p.Limit != 500 || p.Offset != 0 {
		t.Fatalf("clamp %+v", p)
	}
	zero := 0
	if p, _ = s.Query(ctx, Query{Limit: &zero}); p.Limit != 1 {
		t.Fatalf("min limit %d", p.Limit)
	}
	if count(Query{From: "2999-01-01"}) != 0 || count(Query{To: "2000-01-01"}) != 0 || count(Query{From: "2000-01-01", To: "2999"}) != 4 {
		t.Fatal("from/to")
	}
}

func TestRetention(t *testing.T) {
	for raw, want := range map[string]int{"": 90, "30": 30, "0": 0, "-3": 90, "abc": 90} {
		s, _ := newService(t, map[string]string{RetentionEnv: raw})
		if got := s.RetentionDays(); got != want {
			t.Errorf("%q → %d", raw, got)
		}
	}

	s, g := newService(t, map[string]string{RetentionEnv: "30"})
	ctx := context.Background()
	s.now = func() time.Time { return time.Now().Add(-40 * 24 * time.Hour) }
	s.Record(ctx, Event{Action: "old"})
	s.now = time.Now
	s.Record(ctx, Event{Action: "new"})
	if n := s.PurgeExpired(ctx); n != 1 {
		t.Fatalf("purged %d", n)
	}
	if s.Count(ctx) != 1 {
		t.Fatal("wrong rows left")
	}
	if _, err := g.Exec(`DELETE FROM audit_log`); err == nil {
		t.Fatal("delete guard not re-armed")
	}
	if r := s.VerifyChain(ctx); !r.OK {
		t.Fatalf("surviving anchor must verify: %+v", r)
	}

	forever, _ := newService(t, map[string]string{RetentionEnv: "0"})
	forever.now = func() time.Time { return time.Now().Add(-400 * 24 * time.Hour) }
	forever.Record(ctx, Event{Action: "ancient"})
	if forever.PurgeExpired(ctx) != 0 || forever.Count(ctx) != 1 {
		t.Fatal("retention 0 purged")
	}
}

func TestActorFromPrincipal(t *testing.T) {
	cases := []struct {
		p    *auth.Principal
		want ActorType
	}{
		{nil, ActorAnonymous},
		{&auth.Principal{UserID: "token:1", Via: auth.ViaAPIToken}, ActorToken},
		{&auth.Principal{UserID: "admin", Via: auth.ViaAdminJWT}, ActorAdmin},
		{&auth.Principal{UserID: "usr_1", Via: auth.ViaUserJWT, TenantID: "t"}, ActorUser},
	}
	for _, c := range cases {
		at, id, tenant := ActorFromPrincipal(c.p)
		if at != c.want || (c.p == nil) != (id == nil) {
			t.Errorf("%+v → %s %v", c.p, at, id)
		}
		if c.p != nil && c.p.TenantID != "" && (tenant == nil || *tenant != c.p.TenantID) {
			t.Errorf("tenant %v", tenant)
		}
	}
}

func TestMetaTruncation(t *testing.T) {
	long := make([]byte, 5000)
	for i := range long {
		long[i] = 'a'
	}
	got := serializeMeta(map[string]string{"x": string(long)})
	var m struct{ Note, Head string }
	if got == nil || json.Unmarshal([]byte(*got), &m) != nil || m.Note != "meta truncated" || len(m.Head) != 512 {
		t.Fatalf("truncation %v", got)
	}
}
