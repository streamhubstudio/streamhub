// Command build-examples regenerates the committed, downloadable example
// bundles in the repo's examples/ (ex scripts/build-examples.mjs) from the
// same source as the served /samples pages and the per-app
// GET /apps/:app/examples/:id.zip download (internal/samples). Run it after
// changing a sample template:
//
//	go generate ./cmd/build-examples       # from streamhub-core-go/
//
// TestCommittedExamplesUpToDate (internal/samples) fails while examples/
// drifts from the templates.
package main

//go:generate go run . -out ../../../examples

import (
	"flag"
	"fmt"
	"os"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/samples"
)

func main() {
	out := flag.String("out", "../examples", "examples/ directory to (re)write")
	flag.Parse()
	if err := samples.WriteExamples(*out); err != nil {
		fmt.Fprintln(os.Stderr, "build-examples:", err)
		os.Exit(1)
	}
	fmt.Printf("Wrote %d example bundle(s) to %s (+ zips in %s/dist/).\n", len(samples.ExampleBundles), *out, *out)
}
