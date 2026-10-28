package metricshistory

import (
	"context"
	"fmt"
	"time"

	"github.com/robfig/cron/v3"
)

// catchUpAfter: how stale the newest sample may be before boot runs a
// catch-up sample (slightly over an hour so a healthy schedule never
// double-samples).
const catchUpAfter = 70 * time.Minute

var cronParser = cron.NewParser(cron.SecondOptional | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)

// Start is MetricsHistoryScheduler.onModuleInit: the repeatable `hourly`
// job on Settings.Cron (5 fields, or 6 with seconds first, as cron-parser)
// plus a one-shot `catch-up` at boot when the newest sample is stale. Runs
// never overlap (Sample holds the service mutex). Stops with ctx.
func (s *Service) Start(ctx context.Context) {
	if !s.Settings.Enabled {
		s.log.Info("resource-usage sampler disabled (STREAMHUB_METRICS_HISTORY_ENABLED)")
		return
	}
	// Decide catch-up BEFORE any run can land a fresh sample.
	age, ok := s.NewestSampleAge(ctx, time.Now().UnixMilli())
	needsCatchUp := !ok || time.Duration(age)*time.Millisecond > catchUpAfter
	sched, err := cronParser.Parse(s.Settings.Cron)
	if err != nil {
		s.log.Warn(fmt.Sprintf("metrics-history scheduling failed: %s", err.Error()))
		return
	}
	s.log.Info(fmt.Sprintf("resource-usage sampler ready (cron '%s', retention %dd)", s.Settings.Cron, s.Settings.RetentionDays))
	go s.run(ctx, sched, needsCatchUp)
}

func (s *Service) run(ctx context.Context, sched cron.Schedule, catchUp bool) {
	if catchUp {
		s.job(ctx, "catch-up")
	}
	for {
		next := sched.Next(time.Now())
		t := time.NewTimer(time.Until(next))
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
			s.job(ctx, "hourly")
		}
	}
}

func (s *Service) job(ctx context.Context, name string) {
	defer func() {
		if r := recover(); r != nil {
			s.log.Error(fmt.Sprintf("metrics-history job %s failed: %v", name, r))
		}
	}()
	s.Sample(ctx, time.Now().UnixMilli())
}
