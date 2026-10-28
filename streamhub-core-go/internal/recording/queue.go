package recording

import (
	"context"
	"fmt"
	"sync"
)

// jobQueue replaces a BullMQ queue+worker: a bounded set of workers fed by a
// channel, with BullMQ's jobId dedupe (an id already queued or running is
// not added twice). Before start() it has no workers and runs jobs inline.
type jobQueue struct {
	workers int
	run     func(context.Context, uploadJob)

	mu      sync.Mutex
	started bool
	pending map[string]bool
	ch      chan uploadJob
}

type uploadJob struct {
	app   string
	vodID int64
}

func (j uploadJob) id() string { return fmt.Sprintf("vod-%s-%d", j.app, j.vodID) }

func newJobQueue(workers int, run func(context.Context, uploadJob)) *jobQueue {
	return &jobQueue{workers: workers, run: run, pending: map[string]bool{}, ch: make(chan uploadJob, 1024)}
}

func (q *jobQueue) start(ctx context.Context) {
	q.mu.Lock()
	q.started = true
	q.mu.Unlock()
	for i := 0; i < q.workers; i++ {
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case j := <-q.ch:
					q.run(ctx, j)
					q.mu.Lock()
					delete(q.pending, j.id())
					q.mu.Unlock()
				}
			}
		}()
	}
}

// enqueue adds a job (true) or runs it inline when there are no workers
// (false, Node's "queue unavailable; processing inline").
func (q *jobQueue) enqueue(ctx context.Context, j uploadJob) bool {
	q.mu.Lock()
	if !q.started {
		q.mu.Unlock()
		q.run(context.WithoutCancel(ctx), j)
		return false
	}
	if q.pending[j.id()] {
		q.mu.Unlock()
		return true
	}
	q.pending[j.id()] = true
	q.mu.Unlock()
	q.ch <- j
	return true
}
