package recording

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/livekit"
)

// A5: recording.local_dir must stay inside the app dir — "../x" sent the
// egress output (and the MkdirAll) outside it. Whatever slipped past the raw
// editor (hand-edited config.yaml, older install) is refused at launch: a
// 400, no egress, no directory created.
func TestStartRefusesEscapingLocalDir(t *testing.T) {
	ctx := context.Background()
	for _, bad := range []string{"../x", "..", ".", "/tmp/evil", "a/../../x", "x/y"} {
		h := newRC(t, func(c *contracts.AppConfig) { c.Recording.LocalDir = bad })
		_, err := h.s.StartRecording(ctx, StartInput{AppName: "live", RoomName: "r"})
		if st, msg := httpStatus(err); st != 400 {
			t.Fatalf("local_dir %q: %d %s", bad, st, msg)
		}
		if len(h.lk.started) != 0 {
			t.Fatalf("local_dir %q: egress started %+v", bad, h.lk.started)
		}
		if _, err := os.Stat(filepath.Join(h.apps.AppDir("live"), "..", "x")); err == nil {
			t.Fatalf("local_dir %q: created a directory outside the app dir", bad)
		}
	}
	h := newRC(t, func(c *contracts.AppConfig) { c.Recording.LocalDir = "vault" })
	if _, err := h.s.StartRecording(ctx, StartInput{AppName: "live", RoomName: "r"}); err != nil {
		t.Fatal(err)
	}
	if out := h.lk.started[0].(livekit.StartEgressInput).OutputFilepath; filepath.Dir(out) != filepath.Join(h.apps.AppDir("live"), "vault") {
		t.Fatalf("output %s", out)
	}
}
