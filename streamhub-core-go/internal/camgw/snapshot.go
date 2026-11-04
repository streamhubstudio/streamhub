package camgw

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os/exec"
	"strings"
	"time"
)

// snapMinAvailKB: an ffmpeg JPEG grab of a 1080p H.264 camera peaks at
// ~20–30 MB RSS on the RV1106; below this the grab is refused instead of
// letting the OOM killer pick a relay.
const snapMinAvailKB = 24 * 1024

var errLowMemory = errors.New("not enough free memory for a snapshot")

// grabJPEG decodes one keyframe of url into a JPEG at most maxW wide.
func grabJPEG(ctx context.Context, ffmpeg, url string, maxW int) ([]byte, error) {
	if a := memAvailableKB(); a >= 0 && a < snapMinAvailKB {
		return nil, errLowMemory
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error",
		"-rtsp_transport", "tcp", "-timeout", "8000000", "-skip_frame", "nokey", "-i", url, "-an",
		"-frames:v", "1", "-vf", fmt.Sprintf("scale='min(%d,iw)':-2", maxW), "-q:v", "4", "-threads", "1",
		"-f", "image2pipe", "-c:v", "mjpeg", "pipe:1")
	setChildAttrs(cmd)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffmpeg: %s", redactURL(strings.TrimSpace(lastLine(errb.String()))))
	}
	if out.Len() == 0 {
		return nil, errors.New("ffmpeg returned no frame")
	}
	return out.Bytes(), nil
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, "\n"); i >= 0 {
		return s[i+1:]
	}
	return s
}

// thumbnail scales a JPEG to 320 px wide (nearest neighbour; it is a grid tile).
func thumbnail(src []byte) ([]byte, error) {
	img, err := jpeg.Decode(bytes.NewReader(src))
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	w := 320
	h := b.Dy() * w / b.Dx()
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		sy := b.Min.Y + y*b.Dy()/h
		for x := 0; x < w; x++ {
			dst.Set(x, y, img.At(b.Min.X+x*b.Dx()/w, sy))
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 55}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// uploadSnapshot posts the JPEG to the cloud webhook (multipart `file`,
// Bearer token, X-Opencam-Kind, meta {"ts"}): the same request OpenCam's
// upload.sh makes.
func uploadSnapshot(ctx context.Context, url, token, kind string, jpg []byte, at time.Time) error {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="snap-%d.jpg"`, at.Unix()))
	h.Set("Content-Type", "image/jpeg")
	part, _ := mw.CreatePart(h)
	_, _ = part.Write(jpg)
	meta, _ := json.Marshal(map[string]any{"ts": at.Unix(), "time": at.UTC().Format(time.RFC3339)})
	_ = mw.WriteField("meta", string(meta))
	_ = mw.Close()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Opencam-Kind", kind)
	req.Header.Set("Accept", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 300))
		return fmt.Errorf("webhook %d: %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}
