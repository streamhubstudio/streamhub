package samples

import (
	"embed"
	"encoding/json"
	"regexp"
)

// The nine wave-4 / G4 sample templates, exactly as Node's TEMPLATES holds
// them at runtime (placeholders unresolved; exported by templates/gen.js,
// historical). Since the NestJS core's retirement these files are the
// source: edit them directly.

//go:embed templates/*.html templates/files.json
var templateFS embed.FS

// SampleFiles is SAMPLE_FILES (generation order).
var SampleFiles []string

// Templates is TEMPLATES (file name → raw template).
var Templates = map[string]string{}

func init() {
	raw, err := templateFS.ReadFile("templates/files.json")
	if err != nil {
		panic(err)
	}
	if err := json.Unmarshal(raw, &SampleFiles); err != nil {
		panic(err)
	}
	for _, f := range SampleFiles {
		b, err := templateFS.ReadFile("templates/" + f)
		if err != nil {
			panic(err)
		}
		Templates[f] = string(b)
	}
}

// IsSampleFile is SAMPLE_FILES.includes(name).
func IsSampleFile(name string) bool {
	_, ok := Templates[name]
	return ok
}

var placeholderRe = regexp.MustCompile(`\{\{([A-Z_]+)\}\}`)

// RenderPlaceholders resolves every {{KEY}} present in ctx; unknown keys are
// left as-is (renderPlaceholders in sample-templates.ts).
func RenderPlaceholders(template string, ctx map[string]string) string {
	return placeholderRe.ReplaceAllStringFunc(template, func(m string) string {
		if v, ok := ctx[m[2:len(m)-2]]; ok {
			return v
		}
		return m
	})
}
