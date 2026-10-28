package backups

import (
	"context"
	"fmt"
	"time"

	"github.com/robfig/cron/v3"
)

// CatchUpAfter is how stale the newest snapshot may be before boot runs a
// catch-up (slightly over a day so a healthy daily schedule never doubles).
const CatchUpAfter = 26 * time.Hour

// cronParser accepts the 5-field form and the 6-field one with leading
// seconds, as BullMQ's cron-parser does (local time zone).
var cronParser = cron.NewParser(cron.SecondOptional | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)

// Scheduler is BackupsScheduler without Redis: an in-process cron running
// the 'daily' job on Settings.Cron plus a one-shot 'catch-up' at boot when
// the newest snapshot is older than CatchUpAfter. Runs are serialized by the
// service's lock (concurrency 1, like the BullMQ worker).
type Scheduler struct {
	svc *Service
}

// NewScheduler builds the scheduler.
func NewScheduler(svc *Service) *Scheduler { return &Scheduler{svc: svc} }

// Start arms the schedule until ctx ends. Disabled entirely with
// STREAMHUB_BACKUPS_ENABLED=false; an unparseable cron leaves only the
// on-demand API (BullMQ rejects the repeatable job the same way).
func (s *Scheduler) Start(ctx context.Context) {
	log := s.svc.log
	if !s.svc.Settings.Enabled {
		log.Info("scheduled backups disabled (STREAMHUB_BACKUPS_ENABLED)")
		return
	}
	// Decide catch-up before any job can run.
	needsCatchUp := s.svc.NewestSnapshotAge(s.svc.now()) > CatchUpAfter
	sched, err := cronParser.Parse(s.svc.Settings.Cron)
	if err != nil {
		log.Warn("backup scheduling failed: " + err.Error())
		return
	}
	log.Info(fmt.Sprintf("backups queue ready (daily '%s', retention %dd)", s.svc.Settings.Cron, s.svc.Settings.RetentionDays))
	go func() {
		if needsCatchUp {
			s.run(ctx, "catch-up")
		}
		for {
			next := sched.Next(s.svc.now())
			t := time.NewTimer(time.Until(next))
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case <-t.C:
				s.run(ctx, "daily")
			}
		}
	}()
}

func (s *Scheduler) run(ctx context.Context, job string) {
	defer func() {
		if r := recover(); r != nil {
			s.svc.log.Error(fmt.Sprintf("backup job %s failed: %v", job, r))
		}
	}()
	s.svc.RunBackup(context.WithoutCancel(ctx), job, "")
}
