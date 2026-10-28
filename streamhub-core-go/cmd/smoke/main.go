// Command smoke is the StreamHub ops smoke suite (ex scripts/prod-smoke.mjs,
// deploy.local/go-core/prod-smoke.py and scripts/conference-smoke.mjs).
//
//	smoke [prod] [flags]   API surface checks against a live core (default)
//	smoke conference       headless-Chrome check of the conference sample's pre-join
//	smoke call             two LiveKit bots join a room and exchange a data packet
//
// prod flags (env fallbacks STREAMHUB_BASE / STREAMHUB_TOKEN):
//
//	-base URL       core base URL (default http://127.0.0.1:3020)
//	-token sk_…     global API token (required; exit 2 without it)
//	-read-only      send ONLY GET requests: probe an existing app (-app, else
//	                the first one) instead of creating a throwaway app. The
//	                HTTP client refuses any other method, so the run cannot
//	                mutate the target.
//	-app NAME       app to probe in -read-only mode
//	-routes         also walk every parameter-free GET of the core's OpenAPI
//	                for every app; fail on any 5xx but 503 (ex prod-smoke.py)
//
// Exit 0 = all checks passed; 1 = a check failed (or the suite crashed);
// 2 = bad usage / missing token.
package main

import (
	"fmt"
	"os"
)

func main() {
	args := os.Args[1:]
	cmd := "prod"
	if len(args) > 0 && len(args[0]) > 0 && args[0][0] != '-' {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "prod":
		os.Exit(runProd(args))
	case "conference":
		os.Exit(runConference(args))
	case "call":
		os.Exit(runCall(args))
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q (prod|conference|call)\n", cmd)
		os.Exit(2)
	}
}
