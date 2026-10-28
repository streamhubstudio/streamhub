package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/devtools/cdp"
)

// latencyMode drives the G1 glass-to-glass harness page (test/bench/latency)
// in headless Chrome and prints window.__RESULT as one JSON line (ex
// bench/latency/run-latency.js). Page console lines go to stderr.
func latencyMode(args []string) int {
	fs := flag.NewFlagSet("latency", flag.ExitOnError)
	chrome := fs.String("chrome", cdp.FindChrome(), "Chrome/Chromium binary ($CHROME_PATH)")
	timeout := fs.Duration("timeout", 4*time.Minute, "max wait for the page result")
	_ = fs.Parse(args)
	if fs.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: loadgen latency [-chrome PATH] '<latency-page URL with query>'")
		return 2
	}
	if *chrome == "" {
		fmt.Fprintln(os.Stderr, "no Chrome binary found (set CHROME_PATH)")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	b, err := cdp.Launch(ctx, *chrome, "--autoplay-policy=no-user-gesture-required",
		"--disable-background-timer-throttling", "--disable-renderer-backgrounding",
		"--disable-backgrounding-occluded-windows")
	if err != nil {
		fmt.Fprintln(os.Stderr, "runner error:", err)
		return 1
	}
	defer b.Close()
	p, err := b.NewPage(ctx)
	if err == nil {
		defer p.Close()
		_, err = p.CollectErrors(ctx, func(line string) { fmt.Fprintln(os.Stderr, "[page] "+line) })
	}
	if err == nil {
		err = p.Navigate(ctx, fs.Arg(0))
	}
	if err == nil {
		err = p.WaitTrue(ctx, "window.__RESULT !== undefined", *timeout, time.Second)
	}
	var result json.RawMessage
	if err == nil {
		err = p.Eval(ctx, "window.__RESULT", &result)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "runner error:", err)
		return 1
	}
	fmt.Println(string(result))
	return 0
}
