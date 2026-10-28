package visionapps

import (
	"errors"
	"testing"
)

func settings(t *testing.T, model, body string) any {
	t.Helper()
	var raw any
	if body != "" {
		raw = js(t, body)
	}
	out, err := ValidateModelSettings(model, raw)
	if err != nil {
		t.Fatalf("%s %s: %v", model, body, err)
	}
	return out
}

func rejects(t *testing.T, model, body string) {
	t.Helper()
	_, err := ValidateModelSettings(model, js(t, body))
	var se *SettingsError
	if err == nil || !errors.As(err, &se) {
		t.Fatalf("%s %s: want SettingsError, got %v", model, body, err)
	}
}

func TestSettingsZonesNormalize(t *testing.T) {
	out := settings(t, "occupancy", `{"zones":[{"id":"z1","tag":"store-a","detect":"personas","points":[[1.4,-0.2],[0.500009,0.25],[0.1,0.9]],"confidence":0.42,"alertLimit":5,"alertAfterSec":30,"evil":"nope"}]}`)
	eqJSON(t, out, `{"zones":[{"id":"z1","tag":"store-a","detect":"personas","points":[[1,0],[0.5,0.25],[0.1,0.9]],"confidence":0.42,"alertLimit":5,"alertAfterSec":30}]}`)
}

func TestSettingsZonesDefaults(t *testing.T) {
	out := jstr(t, settings(t, "crowd", `{"zones":[{"points":[[0,0],[1,0],[1,1]]}]}`))
	for _, want := range []string{`"detect":"personas"`, `"id":"zone-1"`} {
		if !contains(out, want) {
			t.Fatalf("%s missing %s", out, want)
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestSettingsZonesRejects(t *testing.T) {
	rejects(t, "occupancy", `{"zones":[{"points":[[0,0],[1,1]]}]}`)
	rejects(t, "occupancy", `{"zones":{}}`)
	rejects(t, "occupancy", `{"zones":[{"points":[[0,0],[1,0],[1,1]],"detect":"cars"}]}`)
}

func TestSettingsEmptyBody(t *testing.T) {
	eqJSON(t, settings(t, "occupancy", `{}`), `{"zones":[]}`)
	eqJSON(t, settings(t, "occupancy", ``), `{"zones":[]}`)
}

func TestSettingsLines(t *testing.T) {
	out := settings(t, "counting", `{"lines":[{"id":"l1","tag":"door","x":0.2,"y":0.5,"length":0.6,"angle":12,"inside":"top"}],"fps":4,"capacity":50}`)
	eqJSON(t, out, `{"lines":[{"id":"l1","tag":"door","x":0.2,"y":0.5,"length":0.6,"angle":12,"inside":"top"}],"fps":4,"capacity":50}`)
	eqJSON(t, settings(t, "counting", `{"lines":[]}`), `{"lines":[],"fps":3.5}`)
	rejects(t, "counting", `{"lines":[{"x":0,"y":0,"length":0.5,"inside":"sideways"}]}`)
	rejects(t, "counting", `{"lines":[{"x":0,"y":0,"length":0,"inside":"top"}]}`)
}

func TestSettingsPois(t *testing.T) {
	out := settings(t, "counting", `{"lines":[],"pois":[{"id":"aisle","tag":"aisle-3","points":[[1.2,-0.1],[0.8,0.2],[0.5,0.9]],"evil":"x"},{"points":[[0,0],[1,0],[1,1]]}]}`)
	eqJSON(t, out, `{"lines":[],"fps":3.5,"pois":[{"id":"aisle","tag":"aisle-3","points":[[1,0],[0.8,0.2],[0.5,0.9]]},{"id":"poi-2","tag":"","points":[[0,0],[1,0],[1,1]]}]}`)
	rejects(t, "counting", `{"lines":[],"pois":[{"points":[[0,0],[1,1]]}]}`)
	rejects(t, "counting", `{"lines":[],"pois":{}}`)
}

func TestSettingsDemography(t *testing.T) {
	out := jstr(t, settings(t, "demography", `{"intervalSec":90,"roi":{"points":[[0,0],[1,0],[1,1]]}}`))
	for _, want := range []string{`"engine":"local"`, `"intervalSec":90`, `"roi":{"points":[[0,0],[1,0],[1,1]]}`} {
		if !contains(out, want) {
			t.Fatalf("%s missing %s", out, want)
		}
	}
	if !contains(jstr(t, settings(t, "demography", `{"engine":"openai"}`)), `"engine":"openai"`) {
		t.Fatal("openai engine")
	}
	rejects(t, "demography", `{"engine":"gemini"}`)
	rejects(t, "demography", `{"roi":{"points":[[0,0]]}}`)
	out = jstr(t, settings(t, "demography", `{"intervalSec":120,"roi":{"points":[[0,0],[1,0],[1,1]]},"pois":[{"id":"till","tag":"checkout","points":[[0.6,0],[1,0],[1,1],[0.6,1]]}]}`))
	if !contains(out, `"tag":"checkout"`) {
		t.Fatal(out)
	}
	if contains(jstr(t, settings(t, "demography", `{}`)), "pois") {
		t.Fatal("pois must be omitted when absent")
	}
}

func TestSettingsUnknownModel(t *testing.T) { rejects(t, "facerec", `{}`) }

func TestEmptyModelSettings(t *testing.T) {
	eqJSON(t, EmptyModelSettings("occupancy"), `{"zones":[]}`)
	eqJSON(t, EmptyModelSettings("counting"), `{"lines":[],"fps":3.5}`)
	eqJSON(t, EmptyModelSettings("demography"), `{"intervalSec":120,"engine":"local"}`)
}
