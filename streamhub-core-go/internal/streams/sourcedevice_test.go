package streams

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// INVARIANT (E6): sourceDevice is attached only to streams whose room a
// device channel feeds, and is absent from the JSON otherwise (the Node
// contract of the listing is unchanged without the device plane).
func TestSourceDeviceAnnotation(t *testing.T) {
	s := &Service{}
	recs := []StreamRecord{{StreamID: "a", Room: "live-truck"}, {StreamID: "b", Room: "live-other"}}
	s.annotateSources(context.Background(), "live", recs) // no plane bound
	if recs[0].SourceDevice != nil {
		t.Fatal("annotated without a device plane")
	}
	js, _ := json.Marshal(recs[1])
	if strings.Contains(string(js), "sourceDevice") {
		t.Fatalf("absent sourceDevice serialized: %s", js)
	}
	s.SetSourceDevices(func(_ context.Context, app string) map[string]SourceDevice {
		if app != "live" {
			return nil
		}
		return map[string]SourceDevice{"live-truck": {DeviceID: "dev_1", Name: "Truck", Channel: "1"}}
	})
	s.annotateSources(context.Background(), "live", recs)
	if sd := recs[0].SourceDevice; sd == nil || sd.DeviceID != "dev_1" || sd.Channel != "1" {
		t.Fatalf("annotated: %+v", recs[0].SourceDevice)
	}
	if recs[1].SourceDevice != nil {
		t.Fatal("unlinked room annotated")
	}
	js, _ = json.Marshal(recs[0])
	if !strings.Contains(string(js), `"sourceDevice":{"deviceId":"dev_1","name":"Truck","channel":"1"}`) {
		t.Fatalf("json: %s", js)
	}
}
