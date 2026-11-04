// Command streamhub-agent is the edge gateway for standard RTSP/ONVIF
// cameras: every camera in the config becomes an OpenCam device (api: 1) on
// the cloud's MQTT broker, with its video relayed (stream copy) to the RTMP
// ingest, MP4 segments on local storage, snapshots to the upload webhook and
// PTZ over ONVIF. One static binary; ffmpeg is the only runtime dependency.
//
//	streamhub-agent -config /mnt/sdcard/streamhub/agent.json
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	_ "golang.org/x/crypto/x509roots/fallback" // CA roots for boards without /etc/ssl/certs (Luckfox)

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/camgw"
)

var version = "dev"

func main() {
	cfgPath := flag.String("config", "agent.json", "gateway config (JSON)")
	showVersion := flag.Bool("version", false, "print the version")
	flag.Parse()
	if *showVersion {
		fmt.Println("streamhub-agent", version)
		return
	}
	camgw.Version = version
	log.SetFlags(log.LstdFlags | log.LUTC)
	cfg, err := camgw.Load(*cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	log.Printf("streamhub-agent %s: %d camera(s), data_dir=%q", version, len(cfg.Cameras), cfg.DataDir)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	var wg sync.WaitGroup
	for i := range cfg.Cameras {
		d := camgw.NewDevice(cfg, &cfg.Cameras[i], log.Printf)
		wg.Add(1)
		go func() { defer wg.Done(); d.Run(ctx) }()
	}
	if cfg.DataDir != "" {
		go func() {
			t := time.NewTicker(time.Minute)
			defer t.Stop()
			for {
				camgw.PruneDisk(cfg.DataDir, cfg.DiskHighPct, cfg.DiskLowPct, log.Printf)
				select {
				case <-ctx.Done():
					return
				case <-t.C:
				}
			}
		}()
	}
	<-ctx.Done()
	log.Printf("shutting down")
	wg.Wait()
	os.Exit(0)
}
