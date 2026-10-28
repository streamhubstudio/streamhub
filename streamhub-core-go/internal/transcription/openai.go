package transcription

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// Port of openai.client.ts: POST /v1/audio/transcriptions (multipart);
// whisper-* gets verbose_json (segment timing), other models plain json.

// OpenAIOptions configure one transcription call.
type OpenAIOptions struct {
	APIKey, Model, FilePath, FileName, Language, BaseURL string
	Client                                               *http.Client
	Timeout                                              time.Duration
}

// OpenAIResult is one transcription.
type OpenAIResult struct {
	Text     string
	Language *string
	Segments []Segment // nil = model without segment timing
}

// SupportsVerboseJSON reports whisper-family models.
func SupportsVerboseJSON(model string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(model)), "whisper")
}

// TranscribeOpenAI uploads one audio file; the API key never appears in errors.
func TranscribeOpenAI(ctx context.Context, o OpenAIOptions) (*OpenAIResult, error) {
	if strings.TrimSpace(o.APIKey) == "" {
		return nil, fmt.Errorf("OpenAI API key is not configured")
	}
	base := strings.TrimRight(o.BaseURL, "/")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	verbose := SupportsVerboseJSON(o.Model)
	buf, err := os.ReadFile(o.FilePath)
	if err != nil {
		return nil, err
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	name := o.FileName
	if name == "" {
		name = filepath.Base(o.FilePath)
	}
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename=%q`, name))
	h.Set("Content-Type", "audio/mpeg")
	part, _ := w.CreatePart(h)
	_, _ = part.Write(buf)
	_ = w.WriteField("model", o.Model)
	format := "json"
	if verbose {
		format = "verbose_json"
	}
	_ = w.WriteField("response_format", format)
	if lang := strings.ToLower(strings.TrimSpace(o.Language)); lang != "" && lang != "auto" {
		_ = w.WriteField("language", lang)
	}
	_ = w.Close()
	timeout := o.Timeout
	if timeout == 0 {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/audio/transcriptions", &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("authorization", "Bearer "+o.APIKey)
	req.Header.Set("content-type", w.FormDataContentType())
	client := o.Client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("OpenAI transcription request failed: %s", strings.ReplaceAll(err.Error(), o.APIKey, "***"))
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		detail, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		d := jsx.UTF16Slice(string(detail), 300)
		if d != "" {
			return nil, fmt.Errorf("OpenAI transcription failed (HTTP %d): %s", res.StatusCode, d)
		}
		return nil, fmt.Errorf("OpenAI transcription failed (HTTP %d)", res.StatusCode)
	}
	var parsed struct {
		Text     any `json:"text"`
		Language any `json:"language"`
		Segments []struct {
			Start, End any
			Text       any
		} `json:"segments"`
	}
	raw, _ := io.ReadAll(res.Body)
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	out := &OpenAIResult{Text: anyString(parsed.Text)}
	if l := anyString(parsed.Language); l != "" {
		out.Language = &l
	}
	if parsed.Segments != nil {
		out.Segments = []Segment{}
		for _, s := range parsed.Segments {
			out.Segments = append(out.Segments, Segment{Start: anyNum(s.Start), End: anyNum(s.End), Text: strings.TrimSpace(anyString(s.Text))})
		}
	}
	return out, nil
}

func anyString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func anyNum(v any) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return 0
}
