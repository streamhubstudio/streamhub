package streamflow

import (
	_ "embed"
	"encoding/json"
)

// The box palette (boxes/catalogue.ts) and the event catalogue
// (boxes/event-catalogue.ts) are static metadata the UI renders. They are
// embedded verbatim from the Node build (testdata/gen-catalogue.js, historical)
// so the JSON stays byte-identical; this file only serves and indexes them.
// Since the NestJS core's retirement the embedded JSON is the source: edit it.

var (
	//go:embed boxes.json
	boxesJSON []byte
	//go:embed dangerous.json
	dangerousJSON []byte
	//go:embed events.json
	eventsJSON []byte

	boxSpecs, dangerousSpecs []json.RawMessage
	knownTypes               = map[string]bool{}
)

func init() {
	if err := json.Unmarshal(boxesJSON, &boxSpecs); err != nil {
		panic(err)
	}
	if err := json.Unmarshal(dangerousJSON, &dangerousSpecs); err != nil {
		panic(err)
	}
	for _, s := range append(append([]json.RawMessage{}, boxSpecs...), dangerousSpecs...) {
		var t struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(s, &t)
		knownTypes[t.Type] = true
	}
}

// boxCatalogue is the palette; dangerous execution boxes only when enabled.
func boxCatalogue(dangerous bool) []json.RawMessage {
	if dangerous {
		return append(append([]json.RawMessage{}, boxSpecs...), dangerousSpecs...)
	}
	return boxSpecs
}

// eventCatalogue is EVENT_CATALOGUE.
func eventCatalogue() json.RawMessage { return eventsJSON }
