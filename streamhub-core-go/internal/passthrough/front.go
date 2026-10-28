package passthrough

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
)

const (
	// mediamtxAPITimeout aborts one API probe so a down API never blocks boot.
	mediamtxAPITimeout = 3 * time.Second
	// mediamtxAPIMaxPages caps the /v3/paths/list pages walked.
	mediamtxAPIMaxPages = 100
)

// AppLister lists every app name (APPS_SERVICE.list, internal caller).
type AppLister func(ctx context.Context) ([]string, error)

// MediamtxPath is one /v3/paths/list item we care about.
type MediamtxPath struct {
	Name  string `json:"name"`
	Ready bool   `json:"ready"`
}

type mediamtxPage struct {
	PageCount *float64       `json:"pageCount"`
	Items     []MediamtxPath `json:"items"`
}

// Front is PassthroughRtmpServer: the boot re-arm of persisted ingresses
// (and, under the MediaMTX single-port switch, of the pull remuxes +
// forwards already publishing) and the shutdown teardown.
type Front struct {
	svc    *Service
	keys   KeyStore
	apps   AppLister
	log    *slog.Logger
	client *http.Client
}

// NewFront builds the front; apps nil skips the classic re-arm.
func NewFront(svc *Service, keys KeyStore, apps AppLister, log *slog.Logger) *Front {
	if log == nil {
		log = slog.Default()
	}
	return &Front{svc: svc, keys: keys, apps: apps, log: log, client: &http.Client{}}
}

// Start is OnApplicationBootstrap (+ OnApplicationShutdown on ctx end). It
// returns immediately; the re-arm runs in the background.
func (f *Front) Start(ctx context.Context) {
	cfg := f.svc.cfg
	if !cfg.RtmpPassthroughEnable {
		f.log.Info("RTMP passthrough front is OFF (STREAMHUB_RTMP_PASSTHROUGH_ENABLE unset)")
		return
	}
	go func() {
		<-ctx.Done()
		f.svc.remux.Close()
	}()
	if cfg.MediamtxEnable {
		f.log.Info(fmt.Sprintf("RTMP passthrough front ON — MediaMTX single-port on :%d "+
			"(RTMP arming driven by MediaMTX hooks; SRT keeps its own listener)", cfg.MediamtxRtmpPort))
		go f.RearmAll(ctx)
		go f.RearmFromMediamtx(ctx)
		return
	}
	f.log.Info(fmt.Sprintf("RTMP passthrough front ON — base port %d (remux, no transcode)", cfg.RtmpPassthroughPort))
	go f.RearmAll(ctx)
}

// RearmAll re-arms every persisted passthrough ingress of every app (RTMP
// is skipped under the MediaMTX switch: its ready hook arms it). Never fails.
func (f *Front) RearmAll(ctx context.Context) int {
	if f.apps == nil {
		return 0
	}
	apps, err := f.apps(ctx)
	if err != nil {
		f.log.Warn("passthrough re-arm skipped: " + err.Error())
		return 0
	}
	armed := 0
	for _, app := range apps {
		rows, err := f.keys.ListPassthrough(ctx, app)
		if err != nil {
			continue
		}
		for _, row := range rows {
			if row.StreamKey == nil || *row.StreamKey == "" {
				continue
			}
			if f.svc.cfg.MediamtxEnable && livekit.PassthroughTransportOf(row.IngressID) == TransportRTMP {
				continue
			}
			if f.svc.HandlePublish(ctx, app, *row.StreamKey, nil).Accepted {
				armed++
			}
		}
	}
	if armed > 0 {
		f.log.Info(fmt.Sprintf("re-armed %d passthrough ingress(es) on boot", armed))
	}
	return armed
}

// RearmFromMediamtx re-arms what MediaMTX reports as already publishing: a
// pull remux per passthrough path, a forward per live/ path. A down API
// warns and continues. Returns (pull, forward) counts.
func (f *Front) RearmFromMediamtx(ctx context.Context) (int, int) {
	items, err := f.fetchPaths(ctx)
	if err != nil {
		f.log.Warn(fmt.Sprintf("MediaMTX boot re-arm skipped (API %s unreachable): %s", f.svc.cfg.MediamtxAPIURL, err))
		return 0, 0
	}
	pull, fwd := 0, 0
	for _, it := range items {
		if !it.Ready || it.Name == "" {
			continue
		}
		switch cls := ClassifyMediamtxPath(it.Name); cls.Kind {
		case PathPassthrough:
			if f.svc.HandlePublish(ctx, cls.App, cls.Key, nil).Accepted {
				pull++
			}
		case PathLivekit:
			f.svc.HandleForwardPublish(cls.Key)
			fwd++
		}
	}
	if pull > 0 || fwd > 0 {
		f.log.Info(fmt.Sprintf("re-armed %d pull remux(es) + %d forward(s) from MediaMTX", pull, fwd))
	}
	return pull, fwd
}

func (f *Front) fetchPaths(ctx context.Context) ([]MediamtxPath, error) {
	base := strings.TrimRight(f.svc.cfg.MediamtxAPIURL, "/")
	items := []MediamtxPath{}
	for page := 0; page < mediamtxAPIMaxPages; page++ {
		var body mediamtxPage
		if err := f.getJSON(ctx, base+"/v3/paths/list?page="+strconv.Itoa(page)+"&itemsPerPage=100", &body); err != nil {
			return nil, err
		}
		items = append(items, body.Items...)
		pageCount := 1.0
		if body.PageCount != nil {
			pageCount = *body.PageCount
		}
		if float64(page+1) >= pageCount {
			break
		}
	}
	return items, nil
}

func (f *Front) getJSON(ctx context.Context, url string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, mediamtxAPITimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("accept", "application/json")
	res, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(out)
}
