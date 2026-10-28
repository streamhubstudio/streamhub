package apps

import (
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of config-presets.spec.ts + apps.presets.spec.ts.

func parse(t *testing.T, src string) *y.Map {
	t.Helper()
	v, err := y.Load(src)
	if err != nil {
		t.Fatal(err)
	}
	return v.(*y.Map)
}

func TestPresetCatalogue(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range ConfigPresets() {
		if seen[p.Name] {
			t.Errorf("duplicate id %s", p.Name)
		}
		seen[p.Name] = true
		if p.Title == "" || p.Description == "" || p.UseCase == "" || len(p.Sets) == 0 {
			t.Errorf("%s: incomplete metadata", p.Name)
		}
		for _, k := range p.Patch.Keys() {
			for _, prot := range PresetProtectedKeys {
				if k == prot {
					t.Errorf("%s touches protected key %s", p.Name, k)
				}
			}
			if _, ok := PresetDefaultConfig().Lookup(k); !ok && k != "distribution" && k != "hls" {
				t.Errorf("%s: %s has no factory default and is not forward-looking", p.Name, k)
			}
		}
	}
	for _, id := range []string{"low-latency", "high-quality-recording", "mass-audience-HLS", "rtmp-passthrough"} {
		if FindPreset(id) == nil {
			t.Errorf("missing %s", id)
		}
	}
	if FindPreset("nope") != nil {
		t.Error("unknown preset found")
	}
	pt := FindPreset("rtmp-passthrough").Patch
	if at(pt, "rtmp", "passthrough") != true || at(pt, "rtmp", "transcode") != false || at(pt, "transcoding", "enabled") != false || at(pt, "webrtc", "adaptive") != false {
		t.Error("rtmp-passthrough = remux, everything else off")
	}
	ll := FindPreset("low-latency").Patch
	if at(ll, "transcoding", "enabled") != false || at(ll, "webrtc", "adaptive") != true || at(ll, "distribution", "mode") != "edge" {
		t.Error("low-latency = passthrough + simulcast")
	}
	mass := FindPreset("mass-audience-HLS").Patch
	if at(mass, "distribution", "mode") != "cdn" || at(mass, "hls", "list_size") != 10.0 {
		t.Error("mass-audience-HLS = HLS behind a CDN")
	}
}

func TestDeepMerge(t *testing.T) {
	base := parse(t, "a: {x: 1, y: 2}\nkeep: true\n")
	patch := parse(t, "a: {y: 9, z: 3}\n")
	out := DeepMerge(base, patch)
	if y.Dump(out, 120) != "a:\n  x: 1\n  'y': 9\n  z: 3\nkeep: true\n" {
		t.Errorf("merge = %q", y.Dump(out, 120))
	}
	if y.Dump(base, 120) != "a:\n  x: 1\n  'y': 2\nkeep: true\n" || y.Dump(patch, 120) != "a:\n  'y': 9\n  z: 3\n" {
		t.Error("inputs mutated")
	}
	out = DeepMerge(parse(t, "layers: [{h: 720}, {h: 480}]\n"), parse(t, "layers: [{h: 1080}]\n"))
	if len(out.Get("layers").([]any)) != 1 {
		t.Error("arrays replace wholesale")
	}
	p := obj("a", 5.0, "b", y.Undefined)
	if out = DeepMerge(obj("a", 1.0, "b", 2.0), p); out.Get("a") != 5.0 || out.Get("b") != 2.0 {
		t.Error("undefined patch values are ignored")
	}
}

func TestPresetProtection(t *testing.T) {
	clean := StripProtected(parse(t, "s3: {bucket: x}\ncallbacks: {secret: y}\nname: r\ndisplay_name: X\nroom_prefix: y\ntranscoding: {enabled: true}\n"))
	if strings.Join(clean.Keys(), ",") != "transcoding" {
		t.Errorf("stripped = %v", clean.Keys())
	}
	merged := ApplyPresetPatch(
		parse(t, "name: live\ns3: {bucket: real-bucket}\ncallbacks: {url: 'https://hook', secret: topsecret}\ntranscoding: {enabled: false}\n"),
		parse(t, "s3: {bucket: HACKED}\ncallbacks: {secret: HACKED}\nname: HACKED\ntranscoding: {enabled: true}\n"))
	if at(merged, "s3", "bucket") != "real-bucket" || at(merged, "callbacks", "secret") != "topsecret" || at(merged, "name") != "live" || at(merged, "transcoding", "enabled") != true {
		t.Errorf("protection broken: %s", y.Dump(merged, 120))
	}
}

func TestIsPresetApplied(t *testing.T) {
	for _, p := range ConfigPresets() {
		if IsPresetApplied(y.NewMap(), p.Patch) {
			t.Errorf("%s applied on {}", p.Name)
		}
		if !IsPresetApplied(ApplyPresetPatch(y.NewMap(), p.Patch), p.Patch) {
			t.Errorf("%s not applied after apply", p.Name)
		}
	}
	ll := FindPreset("low-latency").Patch
	m := ApplyPresetPatch(y.NewMap(), ll)
	m.Set("some_unrelated_key", "whatever")
	m.Set("recording", obj("enabled", false))
	if !IsPresetApplied(m, ll) {
		t.Error("drift on keys the preset does not own must be ignored")
	}
	y.MapAt(m, "rtmp").Set("transcode", true)
	if IsPresetApplied(m, ll) {
		t.Error("one owned leaf drifting flips it false")
	}
	hq, mass := FindPreset("high-quality-recording").Patch, FindPreset("mass-audience-HLS").Patch
	hqApplied := ApplyPresetPatch(y.NewMap(), hq)
	if !IsPresetApplied(hqApplied, hq) || IsPresetApplied(hqApplied, mass) {
		t.Error("overlapping presets told apart by their ladders")
	}
	tr := y.MapAt(hqApplied, "transcoding")
	l := tr.Get("vod_renditions").([]any)
	tr.Set("vod_renditions", []any{l[2], l[1], l[0]})
	if IsPresetApplied(hqApplied, hq) {
		t.Error("array leaves are order-sensitive")
	}
}

func TestDeactivatePatch(t *testing.T) {
	ll := FindPreset("low-latency").Patch
	patch, unset := BuildDeactivatePatch(ll, PresetDefaultConfig())
	if at(patch, "rtmp", "transcode") != true || at(patch, "webrtc", "adaptive") != true || at(patch, "transcoding", "enabled") != false || at(patch, "features", "adaptive_player") != true {
		t.Errorf("revert patch = %s", y.Dump(patch, 120))
	}
	if patch.Has("distribution") || patch.Has("hls") {
		t.Error("forward-looking keys are unset, not reverted")
	}
	want := [][]string{{"distribution", "mode"}, {"hls", "segment_seconds"}, {"hls", "list_size"}}
	if !reflect.DeepEqual(unset, want) {
		t.Errorf("unset = %v", unset)
	}

	mass := FindPreset("mass-audience-HLS").Patch
	before := y.Dump(mass, 120)
	defBefore := y.Dump(PresetDefaultConfig(), 120)
	BuildDeactivatePatch(mass, PresetDefaultConfig())
	if y.Dump(mass, 120) != before || y.Dump(PresetDefaultConfig(), 120) != defBefore {
		t.Error("inputs mutated")
	}

	for _, p := range ConfigPresets() {
		applied := ApplyPresetPatch(y.NewMap(), p.Patch)
		revert, unset := BuildDeactivatePatch(p.Patch, PresetDefaultConfig())
		reverted := ApplyPresetPatch(applied, revert)
		for _, path := range unset {
			DeleteAtPath(reverted, path)
		}
		walkLeaves(p.Patch, func(path []string, _ any) {
			def, hasDefault := getAtPath(PresetDefaultConfig(), path)
			got, present := getAtPath(reverted, path)
			if hasDefault && !deepEqual(got, def) {
				t.Errorf("%s: %v = %v, want factory %v", p.Name, path, got, def)
			}
			if !hasDefault && present {
				t.Errorf("%s: %v must be removed", p.Name, path)
			}
		}, nil)
		if reverted.Has("distribution") || reverted.Has("hls") {
			t.Errorf("%s: empty forward-looking blocks must be pruned", p.Name)
		}
	}
}

func TestDeleteAtPath(t *testing.T) {
	m := parse(t, "a: {b: 1}\nkeep: 1\n")
	DeleteAtPath(m, []string{"a", "b"})
	if m.Has("a") {
		t.Error("empty parent pruned")
	}
	m = parse(t, "a: {b: 1, c: 2}\n")
	DeleteAtPath(m, []string{"a", "b"})
	if !y.MapAt(m, "a").Has("c") {
		t.Error("non-empty parent kept")
	}
	m = parse(t, "a: 5\n")
	DeleteAtPath(m, []string{"a", "b", "c"})
	if m.Get("a") != 5.0 {
		t.Error("no-op on an unresolvable path")
	}
	m = parse(t, "d: {cdn: {base_url: '', vod_base_url: '', provider: x}, mode: cdn}\n")
	for _, p := range [][]string{{"d", "cdn", "provider"}, {"d", "mode"}, {"d", "cdn", "base_url"}, {"d", "cdn", "vod_base_url"}} {
		DeleteAtPath(m, p)
	}
	if m.Len() != 0 {
		t.Errorf("order-independent prune left %v", m.Keys())
	}
}

func TestPresetDefaultsMatchFreshApp(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "fresh"})
	_, disk := readYAML(t, s, "fresh")
	defaults := PresetDefaultConfig()
	for _, block := range defaults.Keys() {
		def := defaults.Get(block).(*y.Map)
		for _, k := range def.Keys() {
			if !deepEqual(at(disk, block, k), def.Get(k)) {
				t.Errorf("PRESET_DEFAULT_CONFIG.%s.%s drifted from a fresh app", block, k)
			}
		}
	}
}

func TestPresetService(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "live"})
	list, err := s.ListConfigPresets(bg, "live")
	if err != nil || len(list) != 4 {
		t.Fatalf("list = %v, %v", list, err)
	}
	for _, p := range list {
		if p.Applied {
			t.Errorf("%s applied on a fresh app", p.Name)
		}
	}
	_, err = s.ListConfigPresets(bg, "ghost")
	wantStatus(t, err, http.StatusNotFound)

	_, _ = s.SetS3(bg, "live", SetS3Input{Bucket: sp("real-bucket"), Key: "AKIAKEEP", Secret: "SECRETKEEP"})
	_, _ = s.UpdateConfig(bg, "live", contracts.AppConfigPatch{Callbacks: &contracts.CallbacksPatch{Secret: sp("cb-secret")}})

	res, err := s.ApplyConfigPreset(bg, "live", "low-latency")
	if err != nil || !res.Applied || !res.Reloaded || !res.Changed || res.Diff == "" {
		t.Fatalf("apply = %+v, %v", res, err)
	}
	cfg, _ := s.GetConfig(bg, "live")
	if cfg.Transcoding.Enabled || !cfg.Webrtc.Adaptive || cfg.Rtmp.Transcode {
		t.Errorf("low-latency not applied: %+v", cfg)
	}
	list, _ = s.ListConfigPresets(bg, "live")
	for _, p := range list {
		if p.Applied != (p.Name == "low-latency") {
			t.Errorf("applied flag of %s = %v", p.Name, p.Applied)
		}
	}
	if backups, _ := s.ListConfigBackups(bg, "live"); len(backups) == 0 {
		t.Error("apply takes a backup first")
	}
	if cfg.S3.Bucket != "real-bucket" || cfg.S3.AccessKey != "AKIAKEEP" || cfg.S3.SecretKey != "SECRETKEEP" || cfg.Callbacks.Secret != "cb-secret" {
		t.Error("INVARIANT: presets never touch S3 credentials / the callbacks secret")
	}

	res, _ = s.ApplyConfigPreset(bg, "live", "high-quality-recording")
	cfg, _ = s.GetConfig(bg, "live")
	if !cfg.Transcoding.Enabled || !cfg.Transcoding.VodAdaptive || cfg.Transcoding.VodRenditions[0].Height != 1080 {
		t.Errorf("hq ladder = %+v", cfg.Transcoding)
	}

	res, err = s.DeactivateConfigPreset(bg, "live", "high-quality-recording")
	if err != nil || res.Applied || !res.Changed {
		t.Fatalf("deactivate = %+v, %v", res, err)
	}
	cfg, _ = s.GetConfig(bg, "live")
	if cfg.Transcoding.Enabled || cfg.Transcoding.VodAdaptive || len(cfg.Transcoding.VodRenditions) != 0 || !cfg.Rtmp.Transcode || cfg.Webrtc.Layers[0].Height != 720 {
		t.Errorf("factory defaults not restored: %+v", cfg)
	}
	res, _ = s.DeactivateConfigPreset(bg, "live", "mass-audience-HLS")
	if raw, _ := s.GetRawConfig(bg, "live"); strings.Contains(raw, "\ndistribution:") || strings.Contains(raw, "\nhls:") {
		t.Error("forward-looking blocks removed on deactivate")
	}
	if cfg, _ = s.GetConfig(bg, "live"); cfg.S3.AccessKey != "AKIAKEEP" || cfg.Callbacks.Secret != "cb-secret" {
		t.Error("INVARIANT: deactivate never touches credentials")
	}

	_, err = s.ApplyConfigPreset(bg, "live", "nope")
	wantStatus(t, err, http.StatusNotFound)
	_, err = s.DeactivateConfigPreset(bg, "ghost", "low-latency")
	wantStatus(t, err, http.StatusNotFound)

	_ = os.WriteFile(s.configPath("live"), []byte("a: [unclosed"), 0o644)
	_, err = s.ApplyConfigPreset(bg, "live", "low-latency")
	wantStatus(t, err, http.StatusBadRequest)
	if !strings.HasPrefix(err.Error(), "current config.yaml is not parseable; fix it before applying a preset: ") {
		t.Errorf("message = %q", err)
	}
	_, err = s.DeactivateConfigPreset(bg, "live", "low-latency")
	wantStatus(t, err, http.StatusBadRequest)
	list, err = s.ListConfigPresets(bg, "live")
	if err != nil || list[0].Applied {
		t.Error("an unparseable config lists every preset as not applied")
	}
	_ = os.WriteFile(s.configPath("live"), []byte("- a\n"), 0o644)
	_, err = s.ApplyConfigPreset(bg, "live", "low-latency")
	if status(err) != http.StatusBadRequest || err.Error() != "current config.yaml is not a YAML mapping" {
		t.Errorf("non-mapping = %v", err)
	}
}
