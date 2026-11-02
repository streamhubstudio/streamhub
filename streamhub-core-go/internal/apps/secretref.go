package apps

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// Secret refs are DERIVED by the server, never chosen by the config author
// (security 3.3.3, C3): an app's credentials live in data/secrets.json under
// APP_<SLUG>_<KIND>, and every reader and writer of an app secret goes
// through SecretRef. A *_env value in config.yaml is only a mirror of the
// derived name — a foreign one is ignored on load and rejected on save, so
// app A can neither read nor overwrite app B's (or the platform's) secrets.

// SecretKind is one per-app credential.
type SecretKind string

const (
	SecretS3Key        SecretKind = "S3_KEY"
	SecretS3Secret     SecretKind = "S3_SECRET"
	SecretSmtpPass     SecretKind = "SMTP_PASS"
	SecretMqttPassword SecretKind = "MQTT_PASSWORD"
	SecretDrmToken     SecretKind = "DRM_TOKEN"
)

// secretField is where a kind's ref is mirrored in config.yaml.
type secretField struct {
	kind  SecretKind
	path  []string // block path below the root
	key   string   // the *_env key
	route string   // the setter that owns the value ("" = none)
}

var secretFields = []secretField{
	{SecretS3Key, []string{"s3"}, "access_key_env", "s3"},
	{SecretS3Secret, []string{"s3"}, "secret_key_env", "s3"},
	{SecretMqttPassword, []string{"mqtt"}, "password_env", "mqtt"},
	{SecretSmtpPass, []string{"smtp"}, "pass_env", "smtp"},
	{SecretDrmToken, []string{"features", "drm"}, "key_server_token_env", ""},
}

// optional reports whether the ref may be empty (an empty DRM token ref
// means "no bearer token"; the other refs always exist).
func (f secretField) optional() bool { return f.kind == SecretDrmToken }

func (f secretField) label() string { return strings.Join(f.path, ".") + "." + f.key }

// SecretRef is the secrets.json key of an app credential:
// APP_<SLUG>_<KIND>.
func SecretRef(app string, kind SecretKind) string {
	return "APP_" + secretSlug(app) + "_" + string(kind)
}

// secretSlug is the app name upper-cased with every non-alphanumeric
// character replaced by '_', one for one. App names are [a-z0-9-] (the
// create slug), for which the mapping is injective: "a-b" → A_B and
// "a--b" → A__B never collide (the legacy envSlug collapsed runs, so both
// were A_B). A name outside [a-z0-9-] (never created by the API) could
// collide after normalization ("a_b" vs "a-b"), so it gets a suffix with a
// lower-case marker — "_x" + 10 hex of sha256(name) — that no valid name can
// produce (valid slugs have no lower-case letters).
func secretSlug(app string) string {
	var b strings.Builder
	plain := app != ""
	for _, r := range app {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r - 'a' + 'A')
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-':
			b.WriteByte('_')
		default:
			plain = false
			if r >= 'A' && r <= 'Z' {
				b.WriteRune(r)
			} else {
				b.WriteByte('_')
			}
		}
	}
	if !plain {
		sum := sha256.Sum256([]byte(app))
		b.WriteString("_x" + hex.EncodeToString(sum[:5]))
	}
	return b.String()
}

// legacySecretRef is the ref the pre-3.3.3 scaffold wrote
// ("APP_"+envSlug(name)+"_<KIND>"): equal to SecretRef for every name
// without consecutive hyphens; the boot migration moves the value when not.
func legacySecretRef(app string, kind SecretKind) string {
	return "APP_" + envSlug(app) + "_" + string(kind)
}

// blockAt walks path below m (nil when a step is not a mapping).
func blockAt(m *y.Map, path []string) *y.Map {
	cur := m
	for _, k := range path {
		if cur = y.MapAt(cur, k); cur == nil {
			return nil
		}
	}
	return cur
}

// pinSecretRefs rewrites every *_env mirror of the merged tree to the
// derived ref, so a foreign ref in a legacy config.yaml never resolves and
// never survives a structured save. Returns the foreign refs it dropped.
func pinSecretRefs(app string, disk *y.Map) []string {
	var dropped []string
	for _, f := range secretFields {
		b := blockAt(disk, f.path)
		if b == nil {
			continue
		}
		cur := b.Get(f.key)
		want := SecretRef(app, f.kind)
		if f.optional() && (y.IsUndefined(cur) || cur == nil || y.Trim(y.ToString(cur)) == "") {
			continue
		}
		if y.ToString(cur) != want {
			if y.Truthy(cur) {
				dropped = append(dropped, f.label()+"="+y.ToString(cur))
			}
			b.Set(f.key, want)
		}
	}
	return dropped
}

// errManagedRef is the 400 of a foreign ref on save.
func errManagedRef(app string, f secretField) error {
	if f.route != "" {
		return httpx.BadRequest("secret refs are managed by the server; use PUT /apps/:app/" + f.route)
	}
	return httpx.BadRequest(fmt.Sprintf(`secret refs are managed by the server; %s must be empty or "%s" `+
		`(store the token in data/secrets.json under that key)`, f.label(), SecretRef(app, f.kind)))
}

// validateSecretRefs is the raw editor's half of C3: a present, non-empty
// *_env must be the derived ref (omit it and the server fills it in).
func validateSecretRefs(app string, obj *y.Map) error {
	for _, f := range secretFields {
		b := blockAt(obj, f.path)
		if b == nil {
			continue
		}
		cur := b.Get(f.key)
		if y.IsUndefined(cur) || cur == nil {
			continue
		}
		if s, ok := cur.(string); ok && (y.Trim(s) == "" || s == SecretRef(app, f.kind)) {
			continue
		}
		return errManagedRef(app, f)
	}
	return nil
}

// validateDrmTokenRef is the PATCH /config half: features.drm is the only
// block whose ref the structured patch carries.
func validateDrmTokenRef(app string, patch *contracts.AppConfigPatch) error {
	if patch == nil || patch.Features == nil || patch.Features.Drm == nil {
		return nil
	}
	if ref := y.Trim(patch.Features.Drm.KeyServerTokenEnv); ref != "" && ref != SecretRef(app, SecretDrmToken) {
		return errManagedRef(app, secretFields[len(secretFields)-1])
	}
	return nil
}
