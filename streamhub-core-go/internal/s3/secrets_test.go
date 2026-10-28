package s3

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func newStore(t *testing.T, env map[string]string) (*SecretsStore, string) {
	t.Helper()
	dir := t.TempDir()
	return NewSecretsStore(dir, func(k string) string { return env[k] }), dir
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestSecretsPathAndModes(t *testing.T) {
	s, dir := newStore(t, nil)
	if want := filepath.Join(dir, "data", "secrets.json"); s.Path() != want {
		t.Fatalf("path %q", s.Path())
	}
	if err := s.Set("K", "v"); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(s.Path())
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("file mode %o", st.Mode().Perm())
	}
	dst, _ := os.Stat(filepath.Dir(s.Path()))
	if dst.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %o", dst.Mode().Perm())
	}
	// Looser pre-existing perms are tightened.
	_ = os.Chmod(s.Path(), 0o644)
	if err := s.Set("K2", "v"); err != nil {
		t.Fatal(err)
	}
	st, _ = os.Stat(s.Path())
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("file mode after rewrite %o", st.Mode().Perm())
	}
	if _, err := os.Stat(s.Path() + ".tmp-" + strconv.Itoa(os.Getpid())); !os.IsNotExist(err) {
		t.Fatal("tmp file left behind")
	}
}

func TestSecretsGetPrecedence(t *testing.T) {
	env := map[string]string{"A": "from-env", "B": "env-b", "E": ""}
	s, _ := newStore(t, env)
	if err := s.SetMany([][2]string{{"A", "from-store"}, {"C", ""}, {"", "skipped"}}); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		ref  string
		want string
		ok   bool
	}{
		{"A", "from-store", true}, // store wins
		{"B", "env-b", true},      // env fallback
		{"C", "", false},          // empty store value → env → missing
		{"E", "", false},          // empty env = missing
		{"Z", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := s.Get(c.ref)
		if got != c.want || ok != c.ok {
			t.Errorf("Get(%q) = %q,%v want %q,%v", c.ref, got, ok, c.want, c.ok)
		}
	}
	if strings.Contains(readFile(t, s.Path()), "skipped") {
		t.Fatal("empty key persisted")
	}
	ak, sk := s.ResolveS3Credentials("A", "nope")
	if ak != "from-store" || sk != "" {
		t.Fatalf("resolve %q %q", ak, sk)
	}
}

func TestSecretsCacheAndInvalidate(t *testing.T) {
	s, _ := newStore(t, nil)
	_ = s.Set("K", "v1")
	// External write is invisible until Invalidate.
	_ = os.WriteFile(s.Path(), []byte(`{"K":"v2"}`), 0o600)
	if v, _ := s.Get("K"); v != "v1" {
		t.Fatalf("cached %q", v)
	}
	s.Invalidate()
	if v, _ := s.Get("K"); v != "v2" {
		t.Fatalf("after invalidate %q", v)
	}
}

func TestSecretsCorruptOrNonObject(t *testing.T) {
	for _, body := range []string{"", "not json", "[1,2]", "null", `"str"`, `{"a":"b"} trailing`, `{"a":`} {
		s, _ := newStore(t, map[string]string{"a": "env"})
		_ = os.MkdirAll(filepath.Dir(s.Path()), 0o700)
		_ = os.WriteFile(s.Path(), []byte(body), 0o600)
		if v, ok := s.Get("a"); v != "env" || !ok {
			t.Errorf("%q: Get = %q,%v (want env fallback)", body, v, ok)
		}
		if len(s.ReadFresh()) != 0 {
			t.Errorf("%q: ReadFresh not empty", body)
		}
		// A write over a corrupt file starts from empty.
		if err := s.Set("k", "v"); err != nil {
			t.Fatal(err)
		}
		if got := readFile(t, s.Path()); got != "{\n  \"k\": \"v\"\n}" {
			t.Errorf("%q: rewritten %q", body, got)
		}
	}
	// Missing file.
	s, _ := newStore(t, nil)
	if _, ok := s.Get("x"); ok {
		t.Fatal("missing file should be empty")
	}
}

func TestSecretsStringifyVectors(t *testing.T) {
	// testdata generated with Node: JSON.stringify(map, null, 2).
	s, _ := newStore(t, nil)
	pairs := [][2]string{
		{"S3_KEY", "AKIA<&>"},
		{"10", "ten"},
		{"b", "tab\there \"q\" back\\ nl\n ctl\u0001\u001f del\u007f u2028  é 😀 \b\f\r"},
		{"2", "two"},
		{"01", "zero-one"},
		{"4294967295", "max"},
	}
	if err := s.SetMany(pairs); err != nil {
		t.Fatal(err)
	}
	// Separate calls exercise cache-carried ordering.
	_ = s.Set("", "ignored")
	if err := s.SetMany([][2]string{{"", "x"}}); err != nil {
		t.Fatal(err)
	}
	// Node's vector also sets "" (an object key); Set skips empty refs, so
	// write that one through the raw map to compare formatting.
	m := readSecretsFile(s.Path())
	m.set("", "empty-key")
	m.set("S3_KEY", "overwritten")
	if got, want := m.stringify(), readFile(t, "testdata/stringify_set.json"); got != want {
		t.Fatalf("stringify mismatch\n got %q\nwant %q", got, want)
	}

	// Mixed non-string values survive a round-trip; duplicate key keeps
	// first position and last value.
	src := readFile(t, "testdata/source_mixed.json")
	_ = os.WriteFile(s.Path(), []byte(src), 0o600)
	s.Invalidate()
	if err := s.Set("added", "v"); err != nil {
		t.Fatal(err)
	}
	if got, want := readFile(t, s.Path()), readFile(t, "testdata/stringify_mixed.json"); got != want {
		t.Fatalf("mixed mismatch\n got %q\nwant %q", got, want)
	}
	if v, ok := s.Get("n"); v != "12.5" || !ok {
		t.Fatalf("number value %q %v", v, ok)
	}
	if _, ok := s.Get("x"); ok {
		t.Fatal("null value should be missing")
	}

	// Removing everything → "{}".
	for _, k := range []string{"z", "n", "o", "x", "added"} {
		if err := s.Remove(k); err != nil {
			t.Fatal(err)
		}
	}
	if got, want := readFile(t, s.Path()), readFile(t, "testdata/stringify_empty.json"); got != want {
		t.Fatalf("empty %q", got)
	}
}

func TestSecretsRemove(t *testing.T) {
	s, _ := newStore(t, nil)
	if err := s.Remove("absent"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.Path()); !os.IsNotExist(err) {
		t.Fatal("remove of absent key must not create the file")
	}
	_ = s.SetMany([][2]string{{"a", "1"}, {"b", "2"}})
	if err := s.Remove("a"); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, s.Path()); got != "{\n  \"b\": \"2\"\n}" {
		t.Fatalf("%q", got)
	}
	if _, ok := s.Get("a"); ok {
		t.Fatal("removed key still resolvable")
	}
}

func TestSecretsReadFreshWriteSecret(t *testing.T) {
	s, _ := newStore(t, nil)
	_ = s.Set("a", "1")
	if err := s.WriteSecret("b", "2"); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteSecret("", "x"); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, s.Path()); got != "{\n  \"a\": \"1\",\n  \"b\": \"2\"\n}" {
		t.Fatalf("%q", got)
	}
	st, _ := os.Stat(s.Path())
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %o", st.Mode().Perm())
	}
	fresh := s.ReadFresh()
	if fresh["a"] != "1" || fresh["b"] != "2" || len(fresh) != 2 {
		t.Fatalf("fresh %v", fresh)
	}
	// WriteSecret leaves the cache alone (Node calls invalidate() after).
	if _, ok := s.Get("b"); ok {
		t.Fatal("cache should be stale until Invalidate")
	}
	s.Invalidate()
	if v, _ := s.Get("b"); v != "2" {
		t.Fatalf("after invalidate %q", v)
	}
}

func TestSecretsConcurrent(t *testing.T) {
	s, _ := newStore(t, nil)
	done := make(chan struct{})
	for i := 0; i < 20; i++ {
		go func(i int) {
			k := "k" + strconv.Itoa(i)
			if i%2 == 0 {
				_ = s.Set(k, "v")
			} else {
				_ = s.WriteSecret(k, "v")
				s.Invalidate()
			}
			_, _ = s.Get(k)
			done <- struct{}{}
		}(i)
	}
	for i := 0; i < 20; i++ {
		<-done
	}
	if _, err := parseSecrets([]byte(readFile(t, s.Path()))); err != nil {
		t.Fatalf("file corrupted: %v", err)
	}
}
