package tags

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

const app = "live"

var bg = context.Background()

type fixture struct {
	t     *testing.T
	repo  *Repository
	adb   *sql.DB
	dir   string
	appID int64
}

func newFixture(t *testing.T) *fixture {
	store, g, dir := testutil.Store(t)
	res, err := g.Exec("INSERT INTO apps (name, livekit_room_prefix) VALUES (?, ?)", app, app)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	adb, err := store.App(bg, app)
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{t, New(store, g), adb, dir, id}
}

func (f *fixture) insertStream(streamID, room string, tags []string) {
	b, _ := json.Marshal(tags)
	testutil.Exec(f.t, f.adb, `INSERT INTO streams (app_id, stream_id, type, room, participant, status, tags)
		VALUES (?, ?, 'webrtc', ?, NULL, 'active', ?)`, f.appID, streamID, room, string(b))
}

func (f *fixture) rawTags(streamID string) []string {
	var s string
	if err := f.adb.QueryRow("SELECT tags FROM streams WHERE stream_id = ?", streamID).Scan(&s); err != nil {
		f.t.Fatal(err)
	}
	var out []string
	_ = json.Unmarshal([]byte(s), &out)
	return out
}

func obj(t *testing.T, s string) *y.Map {
	t.Helper()
	v, err := y.ParseJSON([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return v.(*y.Map)
}

func str(s string) *string { return &s }

func wantStatus(t *testing.T, err error, status int, msg string) {
	t.Helper()
	var he *httpx.Error
	if !errors.As(err, &he) || he.Status != status || (msg != "" && he.Error() != msg) {
		t.Fatalf("want %d %q, got %v", status, msg, err)
	}
}

func TestCRUD(t *testing.T) {
	f := newFixture(t)
	tag, err := f.repo.Create(bg, app, CreateInput{Slug: "store-downtown", Label: "Downtown", Kind: str("store"), ConfigJSON: obj(t, `{"fps":3,"roi":{"x":1}}`)})
	if err != nil {
		t.Fatal(err)
	}
	if s, _ := y.Stringify(tag.ConfigJSON); tag.Slug != "store-downtown" || tag.Kind != "store" || s != `{"fps":3,"roi":{"x":1}}` || tag.CreatedAt == "" || tag.UpdatedAt == "" {
		t.Fatalf("%+v %s", tag, s)
	}
	// Defaults: kind custom, config {}.
	def, _ := f.repo.Create(bg, app, CreateInput{Slug: "zone-a", Label: "Zone A"})
	if def.Kind != "custom" || def.ConfigJSON.Len() != 0 {
		t.Fatalf("%+v", def)
	}
	_, _ = f.repo.Create(bg, app, CreateInput{Slug: "zone-b", Label: "Zone B", Kind: str("zone")})
	all, _ := f.repo.List(bg, app, "")
	if len(all) != 3 || all[0].Slug != "zone-b" { // newest first (id DESC on ties)
		t.Fatalf("%+v", all)
	}
	stores, _ := f.repo.List(bg, app, "store")
	if len(stores) != 1 || stores[0].Slug != "store-downtown" {
		t.Fatalf("%+v", stores)
	}

	// Partial update.
	up, err := f.repo.Update(bg, app, "zone-a", UpdateInput{Label: str("  Zone A2 ")})
	if err != nil || up.Label != "Zone A2" || up.Kind != "custom" {
		t.Fatalf("%+v %v", up, err)
	}
	up, _ = f.repo.Update(bg, app, "zone-a", UpdateInput{Kind: str(" "), ConfigJSON: obj(t, `{"k":[1]}`)})
	if s, _ := y.Stringify(up.ConfigJSON); up.Kind != "custom" || s != `{"k":[1]}` {
		t.Fatalf("%+v", up)
	}
	_, err = f.repo.Update(bg, app, "zone-a", UpdateInput{Label: str("  ")})
	wantStatus(t, err, 400, "label cannot be empty")

	// Validation, conflicts, missing.
	_, err = f.repo.Create(bg, app, CreateInput{Slug: "Not Kebab", Label: "x"})
	wantStatus(t, err, 400, "invalid slug (kebab-case: lowercase a-z, 0-9, hyphen-separated)")
	_, err = f.repo.Create(bg, app, CreateInput{Slug: "zone-c", Label: "  "})
	wantStatus(t, err, 400, "label is required")
	_, err = f.repo.Create(bg, app, CreateInput{Slug: " zone-a ", Label: "dup"})
	wantStatus(t, err, 409, "tag 'zone-a' already exists")
	if got, err := f.repo.Get(bg, app, "nope"); got != nil || err != nil {
		t.Fatal("missing tag should be nil")
	}
	_, err = f.repo.Update(bg, app, "nope", UpdateInput{})
	wantStatus(t, err, 404, "tag 'nope' not found")

	// Unknown app → 404 and no stray app.db.
	_, err = f.repo.List(bg, "ghost", "")
	wantStatus(t, err, 404, "app 'ghost' not found")
	if _, err := os.Stat(filepath.Join(f.dir, "apps", "ghost", "app.db")); err == nil {
		t.Fatal("stray app.db")
	}
}

func TestDeletePrunesStreams(t *testing.T) {
	f := newFixture(t)
	_, _ = f.repo.Create(bg, app, CreateInput{Slug: "a", Label: "A"})
	_, _ = f.repo.Create(bg, app, CreateInput{Slug: "b", Label: "B"})
	f.insertStream("r/1", "r", []string{"a", "b"})
	f.insertStream("r/2", "r", []string{"b"})
	if err := f.repo.Remove(bg, app, "a"); err != nil {
		t.Fatal(err)
	}
	if got := f.rawTags("r/1"); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatal(got)
	}
	if got := f.rawTags("r/2"); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatal(got)
	}
	if tag, _ := f.repo.Get(bg, app, "a"); tag != nil {
		t.Fatal("not deleted")
	}
	wantStatus(t, f.repo.Remove(bg, app, "a"), 404, "tag 'a' not found")
	if got := f.rawTags("r/1"); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatal("missing-tag delete touched streams")
	}
}

func TestStreamAndRoomTagging(t *testing.T) {
	f := newFixture(t)
	_, _ = f.repo.Create(bg, app, CreateInput{Slug: "store-a", Label: "A"})
	_, _ = f.repo.Create(bg, app, CreateInput{Slug: "zone-1", Label: "Z"})
	f.insertStream("room-a/cam1", "room-a", nil)
	f.insertStream("room-a/cam2", "room-a", nil)

	st, err := f.repo.SetStreamTags(bg, app, "room-a/cam1", []any{" store-a", "zone-1", "store-a", "", 3.0})
	if err != nil || !reflect.DeepEqual(st.Tags, []string{"store-a", "zone-1"}) {
		t.Fatalf("%+v %v", st, err)
	}
	if got := f.rawTags("room-a/cam1"); !reflect.DeepEqual(got, []string{"store-a", "zone-1"}) {
		t.Fatal(got)
	}
	got, _ := f.repo.GetStreamTags(bg, app, "room-a/cam1")
	if !reflect.DeepEqual(got.Tags, []string{"store-a", "zone-1"}) {
		t.Fatal(got)
	}
	_, err = f.repo.SetStreamTags(bg, app, "room-a/cam1", []any{"store-a", "ghost", "ghost2"})
	wantStatus(t, err, 400, "unknown tag slug(s): ghost, ghost2")
	if got := f.rawTags("room-a/cam1"); len(got) != 2 {
		t.Fatal("unknown slug changed the stream")
	}
	_, err = f.repo.SetStreamTags(bg, app, "nope", []any{"store-a"})
	wantStatus(t, err, 404, "stream 'nope' not found")
	_, err = f.repo.GetStreamTags(bg, app, "nope")
	wantStatus(t, err, 404, "stream 'nope' not found")
	if st, _ := f.repo.SetStreamTags(bg, app, "room-a/cam1", []any{}); len(st.Tags) != 0 || st.Tags == nil || len(f.rawTags("room-a/cam1")) != 0 {
		t.Fatal("empty array must clear")
	}

	room, err := f.repo.SetRoomTags(bg, app, "room-a", []any{"zone-1"})
	if err != nil || room.Updated != 2 || !reflect.DeepEqual(f.rawTags("room-a/cam2"), []string{"zone-1"}) {
		t.Fatalf("%+v %v", room, err)
	}
	if room, _ := f.repo.SetRoomTags(bg, app, "empty-room", []any{"zone-1"}); room.Updated != 0 {
		t.Fatal("no rows → 0")
	}
	_, err = f.repo.SetRoomTags(bg, app, "room-a", []any{"ghost"})
	wantStatus(t, err, 400, "unknown tag slug(s): ghost")
}

func TestParseTagsAndStoredJSON(t *testing.T) {
	for raw, want := range map[string][]string{"": {}, "null": {}, "{}": {}, "nope": {}, `["a"," a ","",1,"b"]`: {"a", "b"}} {
		if got := ParseTags(raw); !reflect.DeepEqual(got, want) {
			t.Errorf("%q → %v", raw, got)
		}
	}
	if s := jsonArray([]string{"a<b", "é"}); s != `["a<b","é"]` {
		t.Fatal(s)
	}
}

// node_vectors.json is generated by testdata/gen.js from the Node dist.
type vectors struct {
	Config []struct{ Input, Output string } `json:"config"`
	Merge  []struct {
		Defaults  json.RawMessage `json:"defaults"`
		Tags      json.RawMessage `json:"tags"`
		Overrides json.RawMessage `json:"overrides"`
		Output    string          `json:"output"`
	} `json:"merge"`
}

func loadVectors(t *testing.T) vectors {
	b, err := os.ReadFile("testdata/node_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestConfigJSONRoundTripMatchesNode(t *testing.T) {
	f := newFixture(t)
	for i, c := range loadVectors(t).Config {
		slug := "t-" + string(rune('a'+i))
		tag, err := f.repo.Create(bg, app, CreateInput{Slug: slug, Label: "x", ConfigJSON: obj(t, c.Input)})
		if err != nil {
			t.Fatal(err)
		}
		var stored string
		_ = f.adb.QueryRow("SELECT config_json FROM tags WHERE slug = ?", slug).Scan(&stored)
		served, _ := y.Stringify(tag.ConfigJSON)
		if stored != c.Output || served != c.Output {
			t.Errorf("vector %d:\n stored %s\n served %s\n want   %s", i, stored, served, c.Output)
		}
	}
}

func TestResolveStreamSettingsMatchesNode(t *testing.T) {
	parse := func(raw json.RawMessage) any {
		v, err := y.ParseJSON(raw)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	for i, m := range loadVectors(t).Merge {
		d, _ := parse(m.Defaults).(*y.Map)
		o, _ := parse(m.Overrides).(*y.Map)
		tagsArr, _ := parse(m.Tags).([]any)
		got, _ := y.Stringify(ResolveStreamSettings(d, tagsArr, o))
		if got != m.Output {
			t.Errorf("vector %d: got %s want %s", i, got, m.Output)
		}
	}
}

func TestDeepMergeDoesNotMutate(t *testing.T) {
	base := obj(t, `{"a":{"b":1},"arr":[1,{"x":1}]}`)
	over := obj(t, `{"a":{"c":2}}`)
	before, _ := y.Stringify(base)
	out := DeepMergeSettings(base, over)
	out.Get("a").(*y.Map).Set("b", 99.0)
	out.Get("arr").([]any)[1].(*y.Map).Set("x", 5.0)
	if after, _ := y.Stringify(base); after != before {
		t.Fatalf("base mutated: %s", after)
	}
	if s, _ := y.Stringify(over); s != `{"a":{"c":2}}` {
		t.Fatal(s)
	}
}

func TestDtoMessages(t *testing.T) {
	cases := []struct {
		name string
		dto  func(*validate.Body)
		body string
		want []string
	}{
		{"create empty", CreateTagDto, `{}`, []string{
			"slug must be kebab-case (lowercase a-z, 0-9, hyphen-separated)", "slug must be shorter than or equal to 64 characters",
			"slug must be longer than or equal to 1 characters", "slug must be a string",
			"label must be shorter than or equal to 200 characters", "label must be longer than or equal to 1 characters", "label must be a string",
		}},
		{"create config array", CreateTagDto, `{"slug":"a","label":"b","config_json":[1]}`, []string{"config_json must be an object"}},
		{"update types", UpdateTagDto, `{"label":"","kind":5,"config_json":"x"}`, []string{
			"label must be longer than or equal to 1 characters", "kind must be shorter than or equal to 64 characters", "kind must be a string", "config_json must be an object",
		}},
		{"apply none", ApplyTagsDto, `{}`, []string{"All tags's elements must be unique", "each value in tags must be a string", "tags must be an array"}},
		{"apply dupes", ApplyTagsDto, `{"tags":["a","a"]}`, []string{"All tags's elements must be unique"}},
		{"apply distinct objects", ApplyTagsDto, `{"tags":[{},{}]}`, []string{"each value in tags must be a string"}},
		{"apply null dupes", ApplyTagsDto, `{"tags":[null,null]}`, []string{"All tags's elements must be unique", "each value in tags must be a string"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := validate.MustParse(tc.body)
			tc.dto(b)
			if got := b.Messages(); strings.Join(got, "|") != strings.Join(tc.want, "|") {
				t.Fatalf("got %q", got)
			}
		})
	}
}
