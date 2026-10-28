package samples

import (
	"strings"
	"testing"
)

// video.js 8 already bundles VHS (@videojs/http-streaming). Loading the
// standalone @videojs/http-streaming@3 build on top of it pulled the newest
// 3.x, which reads videojs.Error.NetworkRequestFailed (absent in 8.10) on its
// error path: a missing/404 playlist threw an uncaught TypeError instead of
// surfacing MEDIA_ERR_NETWORK in the player.
func TestHlsPlayerUsesVideoJSBundledVHS(t *testing.T) {
	tpl := Templates["hls-player.html"]
	if !strings.Contains(tpl, "vjs.zencdn.net/8.") {
		t.Fatal("hls-player.html no longer loads video.js 8")
	}
	if strings.Contains(tpl, "@videojs/http-streaming") {
		t.Fatal("hls-player.html loads a standalone @videojs/http-streaming next to video.js 8 (it is bundled; the floating 3.x build breaks the error path)")
	}
}
