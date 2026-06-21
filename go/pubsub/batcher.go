package pubsub

import (
	"context"
	"sync"
	"time"

	"cloud.google.com/go/pubsub"

	"github.com/sns45/anyq/go/core"
)

// batcher accumulates concurrently-delivered Pub/Sub messages into batches and
// dispatches them to a BatchHandler, either when batchSize is reached or after
// batchTimeout. Pub/Sub's Receive callback is invoked from multiple goroutines,
// so all access to the pending slices is mutex-guarded.
type batcher struct {
	c       *Consumer
	handler core.BatchHandler
	size    int
	timeout time.Duration

	mu      sync.Mutex
	msgs    []core.Message
	raws    []*pubsub.Message
	ctx     context.Context
	timer   *time.Timer
	stopped bool
}

func newBatcher(c *Consumer, handler core.BatchHandler, size int, timeout time.Duration) *batcher {
	return &batcher{c: c, handler: handler, size: size, timeout: timeout}
}

// add appends a message to the pending batch, flushing if full or arming the
// timeout timer for partial batches.
func (b *batcher) add(ctx context.Context, msg core.Message, raw *pubsub.Message) {
	b.mu.Lock()
	if b.stopped {
		b.mu.Unlock()
		raw.Nack()
		return
	}
	b.ctx = ctx
	b.msgs = append(b.msgs, msg)
	b.raws = append(b.raws, raw)

	if len(b.msgs) >= b.size {
		msgs, raws, fctx := b.takeLocked()
		b.mu.Unlock()
		b.process(fctx, msgs, raws)
		return
	}
	if b.timer == nil {
		b.timer = time.AfterFunc(b.timeout, b.flush)
	}
	b.mu.Unlock()
}

// flush dispatches whatever is currently pending (timer-driven).
func (b *batcher) flush() {
	b.mu.Lock()
	msgs, raws, fctx := b.takeLocked()
	b.mu.Unlock()
	if len(msgs) == 0 {
		return
	}
	b.process(fctx, msgs, raws)
}

// takeLocked drains the pending batch. Caller must hold b.mu.
func (b *batcher) takeLocked() ([]core.Message, []*pubsub.Message, context.Context) {
	msgs := b.msgs
	raws := b.raws
	fctx := b.ctx
	b.msgs = nil
	b.raws = nil
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	if fctx == nil {
		fctx = context.Background()
	}
	return msgs, raws, fctx
}

// process runs the batch handler and applies per-message retry strategy on error,
// mirroring the TS subscribeBatch behaviour.
func (b *batcher) process(ctx context.Context, msgs []core.Message, raws []*pubsub.Message) {
	if len(msgs) == 0 {
		return
	}
	if herr := b.handler(ctx, msgs); herr != nil {
		anyUnhandled := false
		for i, m := range msgs {
			mm := m
			reinvoke := func() error { return b.handler(ctx, []core.Message{mm}) }
			handled, applyErr := b.c.ApplyStrategy(ctx, mm, herr, reinvoke)
			if applyErr != nil {
				b.c.Logger.Error("retry strategy terminated batch processing", map[string]any{
					"messageId": mm.ID(), "error": applyErr.Error(),
				})
				raws[i].Nack()
				continue
			}
			if !handled {
				anyUnhandled = true
			}
		}
		if anyUnhandled {
			b.c.Logger.Error("Error processing batch", map[string]any{"count": len(msgs), "error": herr.Error()})
			if b.c.Config.OnError != nil {
				b.c.Config.OnError(herr)
			}
			for _, r := range raws {
				r.Nack()
			}
		}
		return
	}
	for _, m := range msgs {
		_ = m.Ack(ctx)
	}
}

// stop flushes any pending messages and marks the batcher stopped.
func (b *batcher) stop() {
	b.mu.Lock()
	b.stopped = true
	msgs, raws, fctx := b.takeLocked()
	b.mu.Unlock()
	if len(msgs) > 0 {
		b.process(fctx, msgs, raws)
	}
}
