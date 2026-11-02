package apps

import (
	"net/http"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
)

// A5: recording.local_dir is joined onto the app dir and egress writes the
// MP4s there; the raw editor accepted "../x" (or "/etc") and recordings
// landed outside the app.
func TestRawConfigRejectsEscapingLocalDir(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "live"})
	before, _ := readYAML(t, s, "live")
	for _, bad := range []string{"../x", "..", ".", "/etc", "a/b", `a\b`, "x..y", "rec dir", strings.Repeat("r", 65), "5"} {
		val := "'" + bad + "'"
		if bad == "5" {
			val = "5" // not a string
		}
		_, err := s.PutRawConfig(bg, "live", "name: live\nroom_prefix: live\nrecording:\n  local_dir: "+val+"\n")
		wantStatus(t, err, http.StatusBadRequest)
		if err != nil && !strings.Contains(err.Error(), "recording.local_dir") {
			t.Errorf("%q: message %q", bad, err)
		}
		if after, _ := readYAML(t, s, "live"); after != before {
			t.Fatalf("rejected local_dir %q touched the file", bad)
		}
	}
	for _, ok := range []string{"recordings", "rec-2024_v1.0", "''", "null"} {
		if _, err := s.PutRawConfig(bg, "live", "name: live\nroom_prefix: live\nrecording:\n  local_dir: "+ok+"\n"); err != nil {
			t.Errorf("local_dir %s rejected: %v", ok, err)
		}
	}
}
