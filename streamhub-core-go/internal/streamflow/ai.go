package streamflow

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

// Port of ai.request.ts (pure request shaping) + ai.client.ts: an
// OpenAI-compatible /chat/completions caller (OpenAI or DeepSeek) used by
// action.ai — SSRF-guarded, time-bounded, key never logged, and a per-app
// monthly budget that fails closed.

// AIChatOptions shape one request.
type AIChatOptions struct {
	Provider    string // openai (default) | deepseek
	Model       string
	Prompt      string
	System      string
	ImageURL    string
	ImageBase64 string
	ImageMime   string
	MaxTokens   *float64
	Temperature *float64
	JSONMode    bool
	BaseURL     string
}

func providerBaseURL(provider string) string {
	if provider == "deepseek" {
		return "https://api.deepseek.com/v1"
	}
	return "https://api.openai.com/v1"
}

// resolveImageSource is the image URL / data: URI, or "".
func resolveImageSource(o AIChatOptions) string {
	if s := strings.TrimSpace(o.ImageURL); s != "" {
		return s
	}
	if b := strings.TrimSpace(o.ImageBase64); b != "" {
		if strings.HasPrefix(b, "data:") {
			return b
		}
		mime := strings.TrimSpace(o.ImageMime)
		if o.ImageMime == "" {
			mime = "image/jpeg"
		}
		return "data:" + mime + ";base64," + b
	}
	return ""
}

func buildUserContent(o AIChatOptions) any {
	img := resolveImageSource(o)
	if img == "" {
		return o.Prompt
	}
	return []any{
		obj("type", "text", "text", o.Prompt),
		obj("type", "image_url", "image_url", obj("url", img)),
	}
}

// buildChatRequest returns the URL and the JSON body (no key).
func buildChatRequest(o AIChatOptions) (string, *y.Map) {
	base := strings.TrimSpace(o.BaseURL)
	if base == "" {
		base = providerBaseURL(o.Provider)
	}
	base = strings.TrimRight(base, "/")
	messages := []any{}
	if strings.TrimSpace(o.System) != "" {
		messages = append(messages, obj("role", "system", "content", o.System))
	}
	messages = append(messages, obj("role", "user", "content", buildUserContent(o)))
	body := obj("model", o.Model, "messages", messages)
	if o.MaxTokens != nil && *o.MaxTokens > 0 {
		body.Set("max_tokens", math.Floor(*o.MaxTokens))
	}
	if o.Temperature != nil {
		body.Set("temperature", *o.Temperature)
	}
	if o.JSONMode {
		body.Set("response_format", obj("type", "json_object"))
	}
	return base + "/chat/completions", body
}

// parseChatResponse extracts {text, usageTokens}.
func parseChatResponse(raw any) (string, float64) {
	choices, _ := field(raw, "choices").([]any)
	var content any = y.Undefined
	if len(choices) > 0 {
		content = field(field(choices[0], "message"), "content")
	}
	text := ""
	switch c := content.(type) {
	case string:
		text = c
	default:
		if !y.IsNullish(content) {
			text = y.ToString(content)
		}
	}
	tokens := 0.0
	if t, ok := field(field(raw, "usage"), "total_tokens").(float64); ok && finite(t) {
		tokens = t
	}
	return text, tokens
}

var pricePer1K = map[string]float64{
	"gpt-4o-mini": 0.0006, "gpt-4o": 0.008, "gpt-4.1-mini": 0.0006, "gpt-4.1": 0.006,
	"o4-mini": 0.002, "deepseek-chat": 0.0003, "deepseek-reasoner": 0.001,
}

// estimateUSD is the coarse budget-guard cost heuristic.
func estimateUSD(model string, tokens float64) float64 {
	per, ok := pricePer1K[model]
	if !ok {
		per = 0.002
	}
	if !finite(tokens) {
		tokens = 0
	}
	return math.Max(0, tokens) / 1000 * per
}

// UsageTracker is the budget state (the Store).
type UsageTracker interface {
	MonthlyUSD(ctx context.Context, app, appDir, month string) float64
	AddUsage(ctx context.Context, app, appDir string, tokens, usd float64, month string) error
}

// KeyResolver resolves a SecretsStore ref (s3 secrets.json).
type KeyResolver interface {
	Get(ref string) (string, bool)
}

// AIClient is AiClient.
type AIClient struct {
	Usage   UsageTracker
	Secrets KeyResolver // optional
	HTTP    *http.Client
	Resolve security.HostResolver
	Now     func() time.Time
}

// AIRequest is one chat call.
type AIRequest struct {
	AIChatOptions
	App, AppDir, APIKey, APIKeyRef string
	BudgetUSD                      float64
	Timeout                        time.Duration
}

// Chat runs one completion. Errors carry the Node messages.
func (c *AIClient) Chat(ctx context.Context, in AIRequest) (text string, tokens float64, err error) {
	key := strings.TrimSpace(in.APIKey)
	if key == "" && strings.TrimSpace(in.APIKeyRef) != "" && c.Secrets != nil {
		if v, ok := c.Secrets.Get(strings.TrimSpace(in.APIKeyRef)); ok {
			key = strings.TrimSpace(v)
		}
	}
	if key == "" {
		return "", 0, fmt.Errorf("no AI API key configured (ai_api_key / secret ref)")
	}
	month := currentMonth(c.Now())
	if in.BudgetUSD > 0 {
		if spent := c.Usage.MonthlyUSD(ctx, in.App, in.AppDir, month); spent >= in.BudgetUSD {
			return "", 0, fmt.Errorf("monthly AI budget reached ($%s / $%s)", toFixed2(spent), toFixed2(in.BudgetUSD))
		}
	}
	url, body := buildChatRequest(in.AIChatOptions)
	if err := security.AssertSafeEgressURL(ctx, url, security.EgressOptions{
		AllowedSchemes: security.HTTPSchemes, Label: "AI endpoint", Resolve: c.Resolve,
	}); err != nil {
		return "", 0, err
	}
	timeout := in.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	rctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(rctx, http.MethodPost, url, bytes.NewReader([]byte(jsonString(body))))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+key)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("AI request failed: %s", strings.ReplaceAll(err.Error(), key, "[redacted]"))
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", 0, fmt.Errorf("AI provider returned HTTP %d", res.StatusCode)
	}
	b, _ := io.ReadAll(res.Body)
	raw, perr := y.ParseJSON(b)
	if perr != nil {
		return "", 0, fmt.Errorf("AI provider returned a non-JSON body")
	}
	text, tokens = parseChatResponse(raw)
	_ = c.Usage.AddUsage(ctx, in.App, in.AppDir, tokens, estimateUSD(in.Model, tokens), month)
	return text, tokens, nil
}

// toFixed2 is Number#toFixed(2).
func toFixed2(f float64) string { return fmt.Sprintf("%.2f", math.Floor(f*100+0.5)/100) }
