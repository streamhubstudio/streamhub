package livecontrol

import "testing"

// Port of live-control.logic.spec.ts.

func i64(v int64) *int64  { return &v }
func sp(v string) *string { return &v }

var logicDefaults = AppDefaults{DefaultMode: "text", DefaultCardTitle: "Back soon", DefaultCardText: "Paused.",
	DefaultCardColor: "#0b0b0f", DefaultPauseAssetID: i64(10), DefaultFinishAssetID: i64(20)}

func TestOpTarget(t *testing.T) {
	for op, want := range map[string]string{"pause": "paused", "resume": "live", "finish": "finished"} {
		if got := OpTarget(op); got != want {
			t.Errorf("OpTarget(%s)=%s want %s", op, got, want)
		}
	}
}

func TestCanTransition(t *testing.T) {
	cases := []struct {
		from, to string
		want     bool
	}{
		{"live", "paused", true}, {"live", "finished", true}, {"paused", "live", true},
		{"paused", "finished", true}, {"finished", "live", true}, {"finished", "paused", true},
		{"live", "live", false}, {"finished", "finished", false}, {"paused", "paused", true},
	}
	for _, c := range cases {
		if got := CanTransition(c.from, c.to); got != c.want {
			t.Errorf("CanTransition(%s,%s)=%v", c.from, c.to, got)
		}
	}
}

func TestIsCovered(t *testing.T) {
	if IsCovered("live") || !IsCovered("paused") || !IsCovered("finished") {
		t.Fatal("isCovered must be true only for paused/finished")
	}
}

func eqStr(p *string, want string) bool { return p != nil && *p == want }

func TestResolveCover(t *testing.T) {
	if ResolveCover("live", StateRow{}, logicDefaults) != nil {
		t.Fatal("live → nil cover")
	}
	c := ResolveCover("paused", StateRow{}, logicDefaults)
	if c.Mode != "text" || c.AssetID != nil || !eqStr(c.CardTitle, "Back soon") || !eqStr(c.CardText, "Paused.") || c.CardColor != "#0b0b0f" {
		t.Fatalf("default text card: %+v", c)
	}

	d := logicDefaults
	d.DefaultMode = "image"
	if a := ResolveCover("paused", StateRow{}, d).AssetID; a == nil || *a != 10 {
		t.Fatalf("pause asset: %v", a)
	}
	if a := ResolveCover("finished", StateRow{}, d).AssetID; a == nil || *a != 20 {
		t.Fatalf("finish asset: %v", a)
	}

	c = ResolveCover("paused", StateRow{Mode: sp("video"), AssetID: i64(99), CardColor: sp("#fff")}, logicDefaults)
	if c.Mode != "video" || c.AssetID == nil || *c.AssetID != 99 || c.CardColor != "#fff" {
		t.Fatalf("override wins: %+v", c)
	}

	d.DefaultPauseAssetID = nil
	c = ResolveCover("paused", StateRow{}, d)
	if c.Mode != "text" || c.AssetID != nil {
		t.Fatalf("degrade to text: %+v", c)
	}

	c = ResolveCover("finished", StateRow{Mode: sp("text"), AssetID: i64(5)}, logicDefaults)
	if c.Mode != "text" || c.AssetID != nil {
		t.Fatalf("text never carries asset: %+v", c)
	}
}
