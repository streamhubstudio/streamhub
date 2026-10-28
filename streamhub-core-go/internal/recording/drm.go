package recording

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of recording/drm/*: features.drm resolution, the pluggable content-key
// provider (Noop / External SPEKE-style key server), the shaka-packager argv
// builders + shell-out, and DrmService.decide — the per-run guard chain that
// picks clear | skip | clear-degraded | encrypt packaging.
//
// SECURITY: DrmContentKey.Key is the raw content key; it is never logged,
// persisted or serialized into callbacks/variant rows (only key ids are).

// DrmSystems are every DRM system StreamHub can signal for.
var DrmSystems = []string{"widevine", "playready", "fairplay"}

// ---------------------------------------------------------------------------
// drm-config.ts
// ---------------------------------------------------------------------------

// DrmFeatureDefaults is the resolved block with the master switch OFF.
func DrmFeatureDefaults() contracts.DrmFeatures {
	return contracts.DrmFeatures{
		Enabled: false, Provider: "none", Systems: append([]string{}, DrmSystems...), Scheme: "cbcs",
	}
}

// ResolveDrmFeatures is resolveDrmFeatures over the on-disk snake_case block
// (as loaded by yamljs; nil / non-object → defaults). enabled / fail_open are
// strict booleans; unknown systems are dropped (deduped, case-insensitive),
// an empty list means all three; unknown provider → none, scheme → cbcs.
func ResolveDrmFeatures(disk any) contracts.DrmFeatures {
	d, _ := disk.(*yamljs.Map)
	if d == nil {
		d = yamljs.NewMap()
	}
	str := func(v any) string {
		s, ok := v.(string)
		if !ok {
			return ""
		}
		return jsTrim(s)
	}
	f := contracts.DrmFeatures{Provider: "none", Scheme: "cbcs"}
	if strings.ToLower(str(d.Get("provider"))) == "external" {
		f.Provider = "external"
	}
	if strings.ToLower(str(d.Get("scheme"))) == "cenc" {
		f.Scheme = "cenc"
	}
	seen := map[string]bool{}
	if arr, ok := d.Get("systems").([]any); ok {
		for _, s := range arr {
			v := strings.ToLower(str(s))
			if isDrmSystem(v) && !seen[v] {
				seen[v] = true
				f.Systems = append(f.Systems, v)
			}
		}
	}
	if len(f.Systems) == 0 {
		f.Systems = append([]string{}, DrmSystems...)
	}
	f.Enabled = d.Get("enabled") == true
	f.FailOpen = d.Get("fail_open") == true
	f.KeyServerURL = str(d.Get("key_server_url"))
	f.KeyServerTokenEnv = str(d.Get("key_server_token_env"))
	if urls, ok := d.Get("license_urls").(*yamljs.Map); ok {
		f.LicenseUrls = contracts.DrmLicenseUrls{
			Widevine: str(urls.Get("widevine")), Playready: str(urls.Get("playready")), Fairplay: str(urls.Get("fairplay")),
		}
	}
	f.FairplayCertURL = str(d.Get("fairplay_cert_url"))
	return f
}

// DrmFeaturesToDisk serializes a resolved block back to the snake_case shape.
func DrmFeaturesToDisk(f contracts.DrmFeatures) *yamljs.Map {
	m := yamljs.NewMap()
	m.Set("enabled", f.Enabled)
	m.Set("provider", f.Provider)
	sys := make([]any, len(f.Systems))
	for i, s := range f.Systems {
		sys[i] = s
	}
	m.Set("systems", sys)
	m.Set("scheme", f.Scheme)
	m.Set("key_server_url", f.KeyServerURL)
	m.Set("key_server_token_env", f.KeyServerTokenEnv)
	urls := yamljs.NewMap()
	urls.Set("widevine", f.LicenseUrls.Widevine)
	urls.Set("playready", f.LicenseUrls.Playready)
	urls.Set("fairplay", f.LicenseUrls.Fairplay)
	m.Set("license_urls", urls)
	m.Set("fairplay_cert_url", f.FairplayCertURL)
	m.Set("fail_open", f.FailOpen)
	return m
}

func isDrmSystem(s string) bool {
	for _, x := range DrmSystems {
		if x == s {
			return true
		}
	}
	return false
}

func licenseURLFor(f contracts.DrmFeatures, system string) string {
	switch system {
	case "widevine":
		return f.LicenseUrls.Widevine
	case "playready":
		return f.LicenseUrls.Playready
	case "fairplay":
		return f.LicenseUrls.Fairplay
	}
	return ""
}

// ---------------------------------------------------------------------------
// drm-provider.ts + external-drm.provider.ts
// ---------------------------------------------------------------------------

// DrmContentKey is one CENC/CBCS content key (lowercase hex, 32 chars).
type DrmContentKey struct {
	KeyID string `json:"keyId"`
	Key   string `json:"key"` // SECRET
	IV    string `json:"iv,omitempty"`
}

// DrmPsshBox is a per-system PSSH box (base64).
type DrmPsshBox struct {
	System    string `json:"system"`
	BoxBase64 string `json:"boxBase64"`
}

// DrmContentKeys is everything the packager needs to encrypt one asset.
type DrmContentKeys struct {
	AssetID   string          `json:"assetId"`
	Keys      []DrmContentKey `json:"keys"`
	Pssh      []DrmPsshBox    `json:"pssh,omitempty"`
	HlsKeyURI string          `json:"hlsKeyUri,omitempty"`
}

// DrmProvider is the pluggable content-key seam.
type DrmProvider interface {
	ID() string
	Ready() bool
	// GetContentKeys returns nil when keys are unavailable; never errors.
	GetContentKeys(ctx context.Context, assetID string) *DrmContentKeys
	// GetLicenseURL returns "" when not configured.
	GetLicenseURL(system string) string
	PackagingArgs(keys DrmContentKeys, scheme string) []string
}

// NoopDrmProvider is the default: DRM off / unconfigured.
type NoopDrmProvider struct{}

func (NoopDrmProvider) ID() string                                             { return "none" }
func (NoopDrmProvider) Ready() bool                                            { return false }
func (NoopDrmProvider) GetContentKeys(context.Context, string) *DrmContentKeys { return nil }
func (NoopDrmProvider) GetLicenseURL(string) string                            { return "" }
func (NoopDrmProvider) PackagingArgs(DrmContentKeys, string) []string          { return []string{} }

// keyRequestTimeout is KEY_REQUEST_TIMEOUT_MS.
const keyRequestTimeout = 10 * time.Second

var hex16 = regexp.MustCompile(`^[0-9a-f]{32}$`)
var hexPrefix = regexp.MustCompile(`(?i)^0x`)

// normHex: trim, strip 0x / dashes, lowercase ("" for non-strings).
func normHex(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return strings.ToLower(strings.ReplaceAll(hexPrefix.ReplaceAllString(jsTrim(s), ""), "-", ""))
}

// ExternalDrmProvider is the SPEKE-style key-server client: POST
// {asset_id, systems, scheme} (+ bearer) → keys / pssh / hls_key_uri.
type ExternalDrmProvider struct {
	cfg    contracts.DrmFeatures
	token  string
	client *http.Client
}

// NewExternalDrmProvider builds the client (client nil → a default one).
func NewExternalDrmProvider(cfg contracts.DrmFeatures, token string, client *http.Client) *ExternalDrmProvider {
	if client == nil {
		client = &http.Client{}
	}
	return &ExternalDrmProvider{cfg: cfg, token: token, client: client}
}

func (p *ExternalDrmProvider) ID() string { return "external" }

// Ready: enabled + provider external + a key server URL.
func (p *ExternalDrmProvider) Ready() bool {
	return p.cfg.Enabled && p.cfg.Provider == "external" && p.cfg.KeyServerURL != ""
}

// keyRequest keeps Node's JSON.stringify key order.
type keyRequest struct {
	AssetID string   `json:"asset_id"`
	Systems []string `json:"systems"`
	Scheme  string   `json:"scheme"`
}

// GetContentKeys fetches the asset keys; any failure → nil.
func (p *ExternalDrmProvider) GetContentKeys(ctx context.Context, assetID string) *DrmContentKeys {
	if !p.Ready() {
		return nil
	}
	systems := p.cfg.Systems
	if systems == nil {
		systems = []string{}
	}
	body, _ := json.Marshal(keyRequest{assetID, systems, p.cfg.Scheme})
	ctx, cancel := context.WithTimeout(ctx, keyRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.cfg.KeyServerURL, bytes.NewReader(body))
	if err != nil {
		return nil
	}
	req.Header.Set("content-type", "application/json")
	if p.token != "" {
		req.Header.Set("authorization", "Bearer "+p.token)
	}
	res, err := p.client.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil
	}
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil
	}
	parsed, err := yamljs.ParseJSON(raw)
	if err != nil {
		return nil
	}
	b, _ := parsed.(*yamljs.Map)
	if b == nil {
		b = yamljs.NewMap()
	}
	out := &DrmContentKeys{AssetID: assetID}
	if arr, ok := b.Get("keys").([]any); ok {
		for _, e := range arr {
			k, _ := e.(*yamljs.Map)
			if k == nil {
				k = yamljs.NewMap()
			}
			id := k.Get("key_id")
			if yamljs.IsNullish(id) {
				id = k.Get("keyId")
			}
			ck := DrmContentKey{KeyID: normHex(id), Key: normHex(k.Get("key")), IV: normHex(k.Get("iv"))}
			if hex16.MatchString(ck.KeyID) && hex16.MatchString(ck.Key) && (ck.IV == "" || hex16.MatchString(ck.IV)) {
				out.Keys = append(out.Keys, ck)
			}
		}
	}
	if len(out.Keys) == 0 {
		return nil
	}
	if arr, ok := b.Get("pssh").([]any); ok {
		for _, e := range arr {
			pm, _ := e.(*yamljs.Map)
			if pm == nil {
				pm = yamljs.NewMap()
			}
			sys := strings.ToLower(yamljs.ToString(yamljs.Coalesce(pm.Get("system"), "")))
			box := yamljs.Coalesce(pm.Get("box"), yamljs.Coalesce(pm.Get("boxBase64"), ""))
			bs := jsTrim(yamljs.ToString(box))
			if isDrmSystem(sys) && bs != "" {
				out.Pssh = append(out.Pssh, DrmPsshBox{sys, bs})
			}
		}
	}
	uri := b.Get("hls_key_uri")
	if yamljs.IsNullish(uri) {
		uri = b.Get("hlsKeyUri")
	}
	if s, ok := uri.(string); ok && jsTrim(s) != "" {
		out.HlsKeyURI = jsTrim(s)
	}
	return out
}

// GetLicenseURL is the configured URL for an enabled system ("" otherwise).
func (p *ExternalDrmProvider) GetLicenseURL(system string) string {
	for _, s := range p.cfg.Systems {
		if s == system {
			return licenseURLFor(p.cfg, system)
		}
	}
	return ""
}

// PackagingArgs is buildRawKeyArgs.
func (p *ExternalDrmProvider) PackagingArgs(keys DrmContentKeys, scheme string) []string {
	return BuildRawKeyArgs(keys, scheme)
}

// ---------------------------------------------------------------------------
// drm-packager.util.ts
// ---------------------------------------------------------------------------

// DefaultPackagerBin is the shaka-packager binary name on PATH.
const DefaultPackagerBin = "packager"

const (
	packageTimeout = 30 * time.Minute
	probeTimeout   = 10 * time.Second
)

// ShakaPackagerBin is SHAKA_PACKAGER_BIN (trimmed) or `packager`.
func ShakaPackagerBin() string {
	if b := jsTrim(os.Getenv("SHAKA_PACKAGER_BIN")); b != "" {
		return b
	}
	return DefaultPackagerBin
}

var (
	shakaMu    sync.Mutex
	shakaCache = map[string]bool{}
)

// ResetShakaAvailabilityCache forgets cached probe results (tests).
func ResetShakaAvailabilityCache() {
	shakaMu.Lock()
	defer shakaMu.Unlock()
	shakaCache = map[string]bool{}
}

// IsShakaPackagerAvailable probes `<bin> --version` once per bin (cached).
func IsShakaPackagerAvailable(ctx context.Context, r Runner, bin string) bool {
	if bin == "" {
		bin = ShakaPackagerBin()
	}
	shakaMu.Lock()
	if v, ok := shakaCache[bin]; ok {
		shakaMu.Unlock()
		return v
	}
	shakaMu.Unlock()
	_, err := r.Run(ctx, bin, []string{"--version"}, probeTimeout)
	shakaMu.Lock()
	shakaCache[bin] = err == nil
	shakaMu.Unlock()
	return err == nil
}

// BuildRawKeyArgs is the raw-key encryption argv: first key is the default
// (empty label), extras label=key<i>; clear_lead 0; one hex --pssh.
func BuildRawKeyArgs(keys DrmContentKeys, scheme string) []string {
	specs := make([]string, len(keys.Keys))
	for i, k := range keys.Keys {
		label := ""
		if i > 0 {
			label = fmt.Sprintf("key%d", i)
		}
		iv := ""
		if k.IV != "" {
			iv = ":iv=" + k.IV
		}
		specs[i] = "label=" + label + ":key_id=" + k.KeyID + ":key=" + k.Key + iv
	}
	args := []string{"--enable_raw_key_encryption", "--protection_scheme", scheme, "--clear_lead", "0", "--keys", strings.Join(specs, ",")}
	var psshHex strings.Builder
	for _, p := range keys.Pssh {
		psshHex.WriteString(hex.EncodeToString(nodeBase64(p.BoxBase64)))
	}
	if psshHex.Len() > 0 {
		args = append(args, "--pssh", psshHex.String())
	}
	if keys.HlsKeyURI != "" {
		args = append(args, "--hls_key_uri", keys.HlsKeyURI)
	}
	return args
}

// nodeBase64 is Buffer.from(s, 'base64'): lenient (url-safe chars accepted,
// junk and padding ignored, a dangling 6-bit tail dropped).
func nodeBase64(s string) []byte {
	var b strings.Builder
	for _, c := range s {
		if c == '=' {
			break
		}
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '+', c == '/':
			b.WriteRune(c)
		case c == '-':
			b.WriteRune('+')
		case c == '_':
			b.WriteRune('/')
		}
	}
	clean := b.String()
	if len(clean)%4 == 1 {
		clean = clean[:len(clean)-1]
	}
	out, _ := base64.RawStdEncoding.DecodeString(clean) // non-strict: trailing bits ignored, like Node
	return out
}

// ShakaRendition is one video mezzanine input.
type ShakaRendition struct {
	Height float64
	MP4    string
}

// ShakaHlsJob is a full encrypt-and-package job.
type ShakaHlsJob struct {
	Renditions      []ShakaRendition
	AudioSourcePath string
	OutDir          string
	SegmentSeconds  float64 // 0 → 4
	KeyArgs         []string
	Bin             string // "" → ShakaPackagerBin()
}

// BuildShakaHlsArgs is the CMAF HLS packaging argv.
func BuildShakaHlsArgs(job ShakaHlsJob) []string {
	var args []string
	for _, r := range job.Renditions {
		h := jsNum(r.Height)
		args = append(args, "in="+r.MP4+",stream=video,output="+filepath.Join(job.OutDir, h+"p.mp4")+",playlist_name="+h+"p.m3u8")
	}
	args = append(args, "in="+job.AudioSourcePath+",stream=audio,output="+filepath.Join(job.OutDir, "audio.mp4")+
		",playlist_name=audio.m3u8,hls_group_id=audio,hls_name=default")
	seg := job.SegmentSeconds
	if seg == 0 {
		seg = 4
	}
	args = append(args, "--segment_duration", jsNum(seg), "--hls_master_playlist_output", filepath.Join(job.OutDir, "master.m3u8"))
	return append(args, job.KeyArgs...)
}

// PackageDrmHls runs shaka-packager; true when master.m3u8 exists after.
// Never errors and never logs the argv (it carries key material).
func PackageDrmHls(ctx context.Context, r Runner, job ShakaHlsJob) bool {
	if err := os.MkdirAll(job.OutDir, 0o777); err != nil {
		return false
	}
	bin := job.Bin
	if bin == "" {
		bin = ShakaPackagerBin()
	}
	if _, err := r.Run(ctx, bin, BuildShakaHlsArgs(job), packageTimeout); err != nil {
		return false
	}
	return xcExists(filepath.Join(job.OutDir, "master.m3u8"))
}

func xcExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// ---------------------------------------------------------------------------
// drm.service.ts
// ---------------------------------------------------------------------------

// LicenseURLs are per-system license URLs in features.drm.systems order.
type LicenseURLs []struct{ System, URL string }

// MarshalJSON keeps the insertion (systems) order.
func (l LicenseURLs) MarshalJSON() ([]byte, error) {
	m := yamljs.NewMap()
	for _, e := range l {
		m.Set(e.System, e.URL)
	}
	s, err := yamljs.Stringify(m)
	return []byte(s), err
}

func (l LicenseURLs) toMap() *yamljs.Map {
	m := yamljs.NewMap()
	for _, e := range l {
		m.Set(e.System, e.URL)
	}
	return m
}

// DrmPackagingContext is everything the packaging step needs.
type DrmPackagingContext struct {
	Scheme      string
	Systems     []string
	Keys        DrmContentKeys
	KeyArgs     []string // contains key material
	LicenseURLs LicenseURLs
	HlsKeyURI   string
}

// DrmDecision modes.
const (
	DrmClear         = "clear"
	DrmSkip          = "skip"
	DrmClearDegraded = "clear-degraded"
	DrmEncrypt       = "encrypt"
)

// DrmDecision is the outcome of the guard chain (Ctx only for encrypt,
// Reason only for skip / clear-degraded).
type DrmDecision struct {
	Mode   string
	Reason string
	Ctx    *DrmPackagingContext
}

// DrmService decides clear vs encrypted packaging per VOD run.
type DrmService struct {
	secrets Secrets
	runner  Runner
	log     *slog.Logger
	// Client is the key-server HTTP client (tests inject a fake transport).
	Client *http.Client
}

// NewDrmService builds the service (runner nil → ExecRunner).
func NewDrmService(secrets Secrets, runner Runner, log *slog.Logger) *DrmService {
	if runner == nil {
		runner = ExecRunner{}
	}
	return &DrmService{secrets: secrets, runner: runner, log: log}
}

// FeaturesOf is the resolved features.drm (defaults for pre-block configs).
func (s *DrmService) FeaturesOf(cfg *contracts.AppConfig) contracts.DrmFeatures {
	if cfg.Features.Drm != nil {
		return *cfg.Features.Drm
	}
	return DrmFeatureDefaults()
}

// ProviderFor builds the app's provider (Noop unless external is enabled).
func (s *DrmService) ProviderFor(cfg *contracts.AppConfig) DrmProvider {
	drm := s.FeaturesOf(cfg)
	if !drm.Enabled || drm.Provider != "external" {
		return NoopDrmProvider{}
	}
	token := ""
	if drm.KeyServerTokenEnv != "" && s.secrets != nil {
		token, _ = s.secrets.Get(drm.KeyServerTokenEnv)
	}
	return NewExternalDrmProvider(drm, token, s.Client)
}

// Decide runs the guard chain for one asset; never errors and never puts a
// secret into a reason.
func (s *DrmService) Decide(ctx context.Context, cfg *contracts.AppConfig, assetID string) DrmDecision {
	drm := s.FeaturesOf(cfg)
	if !drm.Enabled {
		return DrmDecision{Mode: DrmClear}
	}
	fail := func(reason string) DrmDecision {
		if s.log != nil {
			s.log.Warn(fmt.Sprintf(`drm unavailable for "%s": %s`, cfg.Name, reason))
		}
		if drm.FailOpen {
			return DrmDecision{Mode: DrmClearDegraded, Reason: reason}
		}
		return DrmDecision{Mode: DrmSkip, Reason: reason}
	}
	provider := s.ProviderFor(cfg)
	if !provider.Ready() {
		return fail(fmt.Sprintf(`drm provider "%s" is not configured (set features.drm.provider=external + key_server_url)`, drm.Provider))
	}
	if !IsShakaPackagerAvailable(ctx, s.runner, "") {
		return fail("shaka-packager binary not found (install it in the core image or set SHAKA_PACKAGER_BIN)")
	}
	keys := provider.GetContentKeys(ctx, assetID)
	if keys == nil || len(keys.Keys) == 0 {
		return fail("key server returned no content keys")
	}
	var urls LicenseURLs
	for _, sys := range drm.Systems {
		if u := provider.GetLicenseURL(sys); u != "" {
			urls = append(urls, struct{ System, URL string }{sys, u})
		}
	}
	return DrmDecision{Mode: DrmEncrypt, Ctx: &DrmPackagingContext{
		Scheme: drm.Scheme, Systems: append([]string{}, drm.Systems...), Keys: *keys,
		KeyArgs: provider.PackagingArgs(*keys, drm.Scheme), LicenseURLs: urls, HlsKeyURI: keys.HlsKeyURI,
	}}
}
