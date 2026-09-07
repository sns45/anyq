//go:build integration

package pgmq

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/sns45/anyq/go/core"
)

type fixture struct {
	ctx  context.Context
	pool *pgxpool.Pool
	cfg  Config
	p    *Producer
	c    *Consumer
}

func setup(t *testing.T, change func(*Config)) *fixture {
	t.Helper()
	url := os.Getenv("PGMQ_URL")
	if url == "" {
		t.Skip("PGMQ_URL not set; skipping pgmq integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	cfg := Config{Pool: pool, QueueName: fmt.Sprintf("go_it_%d", time.Now().UnixNano()), PollInterval: 20 * time.Millisecond, VisibilityTimeout: 2 * time.Second}
	cfg.Logging = &core.LogConfig{Enabled: false}
	if change != nil {
		change(&cfg)
	}
	p, err := NewProducer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	c, err := NewConsumer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err := c.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = c.Disconnect(context.Background())
		_ = p.Disconnect(context.Background())
		for _, q := range []string{cfg.QueueName, cfg.QueueName + "_dlq"} {
			if _, err := pool.Exec(context.Background(), "SELECT pgmq.drop_queue($1)", q); err != nil {
				t.Errorf("cleanup %s: %v", q, err)
			}
		}
	})
	return &fixture{ctx: ctx, pool: pool, cfg: cfg, p: p, c: c}
}

func (f *fixture) publish(t *testing.T, opts *core.PublishOptions) string {
	t.Helper()
	id, err := f.p.Publish(f.ctx, []byte(`{"order":7}`), opts)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func (f *fixture) one(t *testing.T) core.Message {
	t.Helper()
	ctx, cancel := context.WithTimeout(f.ctx, 6*time.Second)
	defer cancel()
	var got core.Message
	auto := false
	err := f.c.Subscribe(ctx, func(_ context.Context, m core.Message) error { got = m; cancel(); return nil }, &core.SubscribeOptions{AutoAck: &auto})
	if got == nil {
		t.Fatalf("no message: %v", err)
	}
	return got
}

func (f *fixture) depth(t *testing.T, queue string) int64 {
	t.Helper()
	var n int64
	if err := f.pool.QueryRow(f.ctx, "SELECT queue_length FROM pgmq.metrics($1)", queue).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (f *fixture) visible(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM "+pgx.Identifier{"pgmq", "q_" + f.cfg.QueueName}.Sanitize()+" WHERE vt <= clock_timestamp()").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPublishConsumeAckHeadersAndBigint(t *testing.T) {
	f := setup(t, nil)
	sequence := pgx.Identifier{"pgmq", "q_" + f.cfg.QueueName + "_msg_id_seq"}.Sanitize()
	if _, err := f.pool.Exec(f.ctx, "SELECT setval($1::regclass, 9007199254740993, false)", sequence); err != nil {
		t.Fatal(err)
	}
	headers := core.MessageHeaders{"trace": []byte("héllo")}
	id := f.publish(t, &core.PublishOptions{Key: "customer7", Headers: headers})
	if id != "9007199254740993" {
		t.Fatalf("bigint lost precision: %s", id)
	}
	m := f.one(t)
	var body map[string]int
	if err := json.Unmarshal(m.Body(), &body); err != nil || body["order"] != 7 {
		t.Fatalf("body: %s, %v", m.Body(), err)
	}
	if m.ID() != id || m.Key() != "customer7" || string(m.Headers()["trace"]) != "héllo" || m.DeliveryAttempt() != 1 {
		t.Fatalf("message mismatch: %s %s %v %d", m.ID(), m.Key(), m.Headers(), m.DeliveryAttempt())
	}
	if _, ok := headers["x-anyq-key"]; ok {
		t.Fatal("publish mutated input headers")
	}
	meta := m.Metadata().Pgmq
	if meta == nil || meta.MsgID != id || meta.QueueName != f.cfg.QueueName || meta.ReadCount != 1 || meta.VisibleAt.Before(meta.EnqueuedAt) {
		t.Fatalf("metadata: %+v", meta)
	}
	var wire map[string]any
	if err := f.pool.QueryRow(f.ctx, "SELECT headers FROM "+pgx.Identifier{"pgmq", "q_" + f.cfg.QueueName}.Sanitize()+" WHERE msg_id=$1", int64(9007199254740993)).Scan(&wire); err != nil {
		t.Fatal(err)
	}
	if wire["x-anyq-key"] != "customer7" || wire["trace"] != "héllo" {
		t.Fatalf("wire headers: %v", wire)
	}
	if err := m.Ack(f.ctx); err != nil {
		t.Fatal(err)
	}
	if err := m.Ack(f.ctx); err != nil {
		t.Fatal(err)
	}
	if f.depth(t, f.cfg.QueueName) != 0 {
		t.Fatal("ack did not delete")
	}
}

func TestNackRequeuesThenArchives(t *testing.T) {
	f := setup(t, nil)
	id := f.publish(t, nil)
	m := f.one(t)
	if err := m.Nack(f.ctx, true); err != nil {
		t.Fatal(err)
	}
	if err := m.Ack(f.ctx); err != nil {
		t.Fatal(err)
	}
	m = f.one(t)
	if m.ID() != id || m.DeliveryAttempt() != 2 {
		t.Fatalf("redelivery: %s attempt %d", m.ID(), m.DeliveryAttempt())
	}
	if err := m.Nack(f.ctx, false); err != nil {
		t.Fatal(err)
	}
	if f.depth(t, f.cfg.QueueName) != 0 {
		t.Fatal("archive left active message")
	}
	var n int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM "+pgx.Identifier{"pgmq", "a_" + f.cfg.QueueName}.Sanitize()).Scan(&n); err != nil || n != 1 {
		t.Fatalf("archive count %d: %v", n, err)
	}
}

func TestBatchOrderingDelayAndBatchSubscription(t *testing.T) {
	f := setup(t, nil)
	items := []core.BatchItem{
		{Body: []byte(`{"n":0}`), Options: &core.PublishOptions{Delay: time.Second, Key: "zero"}},
		{Body: []byte(`{"n":1}`), Options: &core.PublishOptions{Headers: core.MessageHeaders{"trace": []byte("one")}}},
		{Body: []byte(`{"n":2}`), Options: &core.PublishOptions{Delay: time.Second}},
	}
	ids, err := f.p.PublishBatch(f.ctx, items)
	if err != nil || len(ids) != 3 {
		t.Fatalf("batch %v %v", ids, err)
	}
	for i, id := range ids {
		var body map[string]int
		if err := f.pool.QueryRow(f.ctx, "SELECT message FROM "+pgx.Identifier{"pgmq", "q_" + f.cfg.QueueName}.Sanitize()+" WHERE msg_id=$1", id).Scan(&body); err != nil || body["n"] != i {
			t.Fatalf("input order %d id %s body %v error %v", i, id, body, err)
		}
	}
	if n := f.visible(t); n != 1 {
		t.Fatalf("delayed batch visible count %d", n)
	}
	time.Sleep(1100 * time.Millisecond)
	ctx, cancel := context.WithCancel(f.ctx)
	var got int
	err = f.c.SubscribeBatch(ctx, func(_ context.Context, msgs []core.Message) error {
		got = len(msgs)
		for _, m := range msgs {
			if m.Key() == "zero" && m.ID() != ids[0] {
				return errors.New("key association lost")
			}
		}
		cancel()
		return nil
	}, &core.SubscribeOptions{BatchSize: 3})
	if got != 3 || !errors.Is(err, context.Canceled) {
		t.Fatalf("batch consume count %d error %v", got, err)
	}
	if f.depth(t, f.cfg.QueueName) != 0 {
		t.Fatal("batch auto ack failed during cancellation")
	}
}

func TestDelayAndExtendDeadline(t *testing.T) {
	f := setup(t, nil)
	f.publish(t, &core.PublishOptions{Delay: 100 * time.Millisecond})
	if f.visible(t) != 0 {
		t.Fatal("fractional delay rounded down")
	}
	m := f.one(t)
	if err := m.ExtendDeadline(f.ctx, 3*time.Second); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2100 * time.Millisecond)
	if f.visible(t) != 0 {
		t.Fatal("extension did not hold lease beyond original timeout")
	}
	if err := m.Nack(f.ctx, true); err != nil {
		t.Fatal(err)
	}
	if f.visible(t) != 1 {
		t.Fatal("requeue did not release extended lease")
	}
}

func TestPauseResumeAndHealth(t *testing.T) {
	f := setup(t, nil)
	f.publish(t, nil)
	if err := f.c.Pause(f.ctx); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(f.ctx)
	done := make(chan error, 1)
	seen := make(chan struct{}, 1)
	go func() {
		done <- f.c.Subscribe(ctx, func(context.Context, core.Message) error { seen <- struct{}{}; cancel(); return nil }, nil)
	}()
	select {
	case <-seen:
		t.Fatal("handler ran while paused")
	case <-time.After(100 * time.Millisecond):
	}
	h, err := f.c.HealthCheck(f.ctx)
	if err != nil || !h.Healthy || h.Details["queueLength"] != int64(1) {
		t.Fatalf("health %+v %v", h, err)
	}
	if err := f.c.Resume(f.ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-seen:
	case <-f.ctx.Done():
		t.Fatal("resume did not deliver")
	}
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := f.p.Disconnect(f.ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.Ping(f.ctx); err != nil {
		t.Fatalf("disconnect closed borrowed pool: %v", err)
	}
	h, err = f.p.HealthCheck(f.ctx)
	if err != nil || h.Healthy || h.Connected {
		t.Fatalf("disconnected health %+v %v", h, err)
	}
}

func TestPauseReleasesUndeliveredBatch(t *testing.T) {
	f := setup(t, nil)
	f.publish(t, nil)
	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(f.ctx, "LOCK TABLE "+pgx.Identifier{"pgmq", "q_" + f.cfg.QueueName}.Sanitize()+" IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(f.ctx)
	defer cancel()
	var calls atomic.Int32
	done := make(chan error, 1)
	go func() {
		done <- f.c.SubscribeBatch(ctx, func(context.Context, []core.Message) error { calls.Add(1); return nil }, nil)
	}()
	waitFor(t, func() bool {
		var n int
		err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%pgmq.read%' AND query NOT LIKE '%pg_stat_activity%'").Scan(&n)
		return err == nil && n > 0
	})
	if err := f.c.Pause(f.ctx); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return f.visible(t) == 1 })
	cancel()
	<-done
	if calls.Load() != 0 {
		t.Fatal("delivered a lease returned after pause")
	}
}

func TestDisconnectStopsSubscription(t *testing.T) {
	f := setup(t, nil)
	ctx, cancel := context.WithCancel(f.ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- f.c.Subscribe(ctx, func(context.Context, core.Message) error { return nil }, nil) }()
	time.Sleep(50 * time.Millisecond)
	if err := f.c.Disconnect(f.ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("subscription continued after disconnect")
	}
	if err := f.pool.Ping(f.ctx); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentHandlersDoNotPrefetchIdleLeases(t *testing.T) {
	f := setup(t, nil)
	f.publish(t, nil)
	f.publish(t, nil)
	ctx, cancel := context.WithCancel(f.ctx)
	defer cancel()
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- f.c.Subscribe(ctx, func(_ context.Context, m core.Message) error { entered <- struct{}{}; <-release; return m.Ack(f.ctx) }, &core.SubscribeOptions{Concurrency: 2})
	}()
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			close(release)
			t.Fatal("handlers were serialized after leasing a batch")
		}
	}
	close(release)
	waitFor(t, func() bool { return f.depth(t, f.cfg.QueueName) == 0 })
	cancel()
	<-done
}

func TestRetryStrategiesUseNativeDLQAndPark(t *testing.T) {
	strategies := map[string]core.Strategy{
		"retry":        core.RetryThenDeadLetter(&core.RetryThenDeadLetterOptions{MaxAttempts: 2, Backoff: &core.RetryConfig{InitialDelayMs: 5, MaxDelayMs: 5}, IsRetryable: func(error) bool { return true }}),
		"immediate":    core.DeadLetterImmediate(),
		"backpressure": core.BackpressurePause(&core.BackpressurePauseOptions{PauseMs: 100, IsRateLimited: func(error) bool { return true }}),
	}
	for name, strategy := range strategies {
		t.Run(name, func(t *testing.T) {
			f := setup(t, func(cfg *Config) {
				cfg.Strategy = strategy
				cfg.BaseQueueConfig.DeadLetterQueue = &core.DeadLetterConfig{Enabled: true, IncludeError: true}
			})
			id := f.publish(t, &core.PublishOptions{Key: "route", Headers: core.MessageHeaders{"trace": []byte("keep")}})
			ctx, cancel := context.WithCancel(f.ctx)
			defer cancel()
			var calls atomic.Int32
			done := make(chan error, 1)
			go func() {
				done <- f.c.Subscribe(ctx, func(_ context.Context, m core.Message) error {
					n := calls.Add(1)
					if name == "backpressure" && n == 2 {
						if m.ID() != id || m.DeliveryAttempt() != 2 {
							return errors.New("park changed identity or attempt")
						}
						cancel()
						return nil
					}
					return errors.New("intentional failure")
				}, nil)
			}()
			if name == "backpressure" {
				waitFor(t, func() bool { return f.c.IsPaused() })
				if f.visible(t) != 0 {
					t.Fatal("park did not hide message")
				}
				select {
				case <-done:
				case <-time.After(4 * time.Second):
					t.Fatal("park did not redeliver")
				}
				if calls.Load() != 2 || f.depth(t, f.cfg.QueueName) != 0 {
					t.Fatalf("park calls %d", calls.Load())
				}
				return
			}
			waitFor(t, func() bool { return f.depth(t, f.cfg.QueueName+"_dlq") == 1 })
			cancel()
			<-done
			var body []byte
			var headers map[string]string
			if err := f.pool.QueryRow(f.ctx, "SELECT message,headers FROM pgmq.read($1,0,1)", f.cfg.QueueName+"_dlq").Scan(&body, &headers); err != nil {
				t.Fatal(err)
			}
			if !json.Valid(body) || headers["trace"] != "keep" || headers["x-anyq-key"] != "route" || headers["x-original-queue"] != f.cfg.QueueName || headers["x-death-reason"] == "" {
				t.Fatalf("DLQ data %s %v", body, headers)
			}
			if _, err := time.Parse(time.RFC3339Nano, headers["x-death-time"]); err != nil {
				t.Fatal(err)
			}
			if headers["x-delivery-attempts"] != "1" {
				t.Fatalf("native read count changed: %v", headers)
			}
			want := int32(1)
			if name == "retry" {
				want = 2
			}
			if calls.Load() != want || f.depth(t, f.cfg.QueueName) != 0 {
				t.Fatalf("calls %d, wanted %d", calls.Load(), want)
			}
		})
	}
}

func TestDeadLetterImmediateWithoutActiveDLQArchives(t *testing.T) {
	for _, name := range []string{"absent", "disabled"} {
		t.Run(name, func(t *testing.T) {
			f := setup(t, func(cfg *Config) {
				cfg.Strategy = core.DeadLetterImmediate()
				if name == "disabled" {
					cfg.BaseQueueConfig.DeadLetterQueue = &core.DeadLetterConfig{Enabled: false}
				}
			})
			f.publish(t, nil)
			ctx, cancel := context.WithCancel(f.ctx)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- f.c.Subscribe(ctx, func(context.Context, core.Message) error {
					return errors.New("intentional failure")
				}, nil)
			}()
			waitFor(t, func() bool { return f.depth(t, f.cfg.QueueName) == 0 })
			cancel()
			if err := <-done; !errors.Is(err, context.Canceled) {
				t.Fatalf("subscription: %v", err)
			}
			var archived int
			if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM "+pgx.Identifier{"pgmq", "a_" + f.cfg.QueueName}.Sanitize()).Scan(&archived); err != nil {
				t.Fatal(err)
			}
			if archived != 1 {
				t.Errorf("archive count %d, want 1", archived)
			}
			var exists bool
			if err := f.pool.QueryRow(f.ctx, "SELECT EXISTS(SELECT 1 FROM pgmq.list_queues() WHERE queue_name=$1)", f.cfg.QueueName+"_dlq").Scan(&exists); err != nil {
				t.Fatal(err)
			}
			if exists {
				t.Error("inactive default DLQ was created")
			}
		})
	}
}

func TestDeadLetterFailureKeepsOriginal(t *testing.T) {
	f := setup(t, func(cfg *Config) {
		cfg.BaseQueueConfig.DeadLetterQueue = &core.DeadLetterConfig{Enabled: true}
	})
	f.publish(t, nil)
	m := f.one(t)
	if _, err := f.pool.Exec(f.ctx, "SELECT pgmq.drop_queue($1)", f.cfg.QueueName+"_dlq"); err != nil {
		t.Fatal(err)
	}
	if err := f.c.DeadLetterMessage(f.ctx, m, "fail"); err == nil {
		t.Fatal("missing DLQ should fail")
	}
	if f.depth(t, f.cfg.QueueName) != 1 {
		t.Fatal("DLQ failure lost original")
	}
	if _, err := f.pool.Exec(f.ctx, "SELECT pgmq.create($1)", f.cfg.QueueName+"_dlq"); err != nil {
		t.Fatal(err)
	}
	if err := f.c.DeadLetterMessage(f.ctx, m, "retry"); err != nil {
		t.Fatal(err)
	}
	if f.depth(t, f.cfg.QueueName) != 0 || f.depth(t, f.cfg.QueueName+"_dlq") != 1 {
		t.Fatal("DLQ retry did not transfer exactly once")
	}
	if err := m.Ack(f.ctx); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidPayloadDoesNotPartiallyPublishBatch(t *testing.T) {
	f := setup(t, nil)
	_, err := f.p.PublishBatch(f.ctx, []core.BatchItem{{Body: []byte(`{"ok":true}`)}, {Body: []byte(`invalid`)}})
	var qe *core.AnyQError
	if !errors.As(err, &qe) || qe.Code != "SERIALIZATION_ERROR" {
		t.Fatalf("expected serialization error: %v", err)
	}
	if f.depth(t, f.cfg.QueueName) != 0 {
		t.Fatal("invalid batch published a prefix")
	}
}

func TestWireMessageFromOtherClient(t *testing.T) {
	f := setup(t, nil)
	var id int64
	if err := f.pool.QueryRow(f.ctx, "SELECT pgmq.send($1,$2::jsonb,$3::jsonb,0)", f.cfg.QueueName, `{"source":"typescript"}`, `{"x-anyq-key":"route","trace":"wire"}`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	m := f.one(t)
	if m.ID() != strconv.FormatInt(id, 10) || m.Key() != "route" || string(m.Headers()["trace"]) != "wire" {
		t.Fatal("wire interoperability failed")
	}
	if strings.Contains(string(m.Body()), "x-anyq-key") {
		t.Fatal("headers leaked into body")
	}
	if err := m.Ack(f.ctx); err != nil {
		t.Fatal(err)
	}
}

func TestMissingInstallationAndAutomaticInstall(t *testing.T) {
	url := os.Getenv("PGMQ_URL")
	if url == "" {
		t.Skip("PGMQ_URL not set; skipping pgmq integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	name := fmt.Sprintf("go_install_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := admin.Exec(context.Background(), "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)"); err != nil {
			t.Error(err)
		}
	}()
	pc, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	pc.ConnConfig.Database = name
	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	disabled := false
	cfg := Config{Pool: pool, QueueName: "go_install", AutoInstall: &disabled}
	p, err := NewProducer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	err = p.Connect(ctx)
	var qe *core.AnyQError
	if !errors.As(err, &qe) || qe.Code != "CONFIGURATION_ERROR" || !strings.Contains(err.Error(), "pgmq-extension/sql/pgmq.sql") {
		t.Fatalf("missing installation error: %v", err)
	}
	if p.IsConnected() {
		t.Fatal("failed connect reported connected")
	}
	role := name + "_role"
	if _, err := admin.Exec(ctx, "CREATE ROLE "+pgx.Identifier{role}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := admin.Exec(context.Background(), "DROP ROLE "+pgx.Identifier{role}.Sanitize()); err != nil {
			t.Error(err)
		}
	}()
	limitedConfig := pc.Copy()
	limitedConfig.ConnConfig.RuntimeParams["role"] = role
	limited, err := pgxpool.NewWithConfig(ctx, limitedConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer limited.Close()
	denied, err := NewProducer(Config{Pool: limited, QueueName: "go_denied"})
	if err != nil {
		t.Fatal(err)
	}
	err = denied.Connect(ctx)
	if !errors.As(err, &qe) || qe.Code != "CONFIGURATION_ERROR" || !strings.Contains(err.Error(), "pgmq-extension/sql/pgmq.sql") {
		t.Fatalf("refused extension error: %v", err)
	}
	cfg.AutoInstall = nil
	p, err = NewProducer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	defer p.Disconnect(ctx)
	if _, err := p.Publish(ctx, []byte(`{"installed":true}`), nil); err != nil {
		t.Fatal(err)
	}
	h, err := p.HealthCheck(ctx)
	if err != nil || !h.Healthy || h.Details["queueLength"] != int64(1) {
		t.Fatalf("installed health %+v %v", h, err)
	}
	// Extension privileges are no longer needed when the pgmq schema exists.
	cfg.AutoInstall = &disabled
	consumer, err := NewConsumer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := consumer.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	defer consumer.Disconnect(ctx)
}

func TestDeadLetterDoesNotCopyMissingSource(t *testing.T) {
	f := setup(t, func(cfg *Config) {
		cfg.BaseQueueConfig.DeadLetterQueue = &core.DeadLetterConfig{Enabled: true}
	})
	f.publish(t, nil)
	m := f.one(t)
	if _, err := f.pool.Exec(f.ctx, "SELECT pgmq.delete($1,$2::bigint)", f.cfg.QueueName, m.ID()); err != nil {
		t.Fatal(err)
	}
	if err := f.c.DeadLetterMessage(f.ctx, m, "already removed"); err != nil {
		t.Fatal(err)
	}
	if f.depth(t, f.cfg.QueueName+"_dlq") != 0 {
		t.Fatal("DLQ copy committed without source")
	}
}

func TestExplicitNackWinsOverAutomaticAck(t *testing.T) {
	f := setup(t, nil)
	f.publish(t, nil)
	ctx, cancel := context.WithCancel(f.ctx)
	defer cancel()
	attempts := []int{}
	err := f.c.Subscribe(ctx, func(_ context.Context, m core.Message) error {
		attempts = append(attempts, m.DeliveryAttempt())
		if len(attempts) == 1 {
			return m.Nack(ctx, true)
		}
		cancel()
		return nil
	}, nil)
	if !errors.Is(err, context.Canceled) || len(attempts) != 2 || attempts[0] != 1 || attempts[1] != 2 {
		t.Fatalf("attempts %v error %v", attempts, err)
	}
	if f.depth(t, f.cfg.QueueName) != 0 {
		t.Fatal("final automatic ack failed")
	}
}

func TestInvalidUTF8HeadersAreRejected(t *testing.T) {
	f := setup(t, nil)
	_, err := f.p.Publish(f.ctx, []byte(`null`), &core.PublishOptions{Headers: core.MessageHeaders{"binary": {0xff, 0xfe}}})
	var qe *core.AnyQError
	if !errors.As(err, &qe) || qe.Code != "SERIALIZATION_ERROR" {
		t.Fatalf("binary corruption was not rejected: %v", err)
	}
	if f.depth(t, f.cfg.QueueName) != 0 {
		t.Fatal("invalid headers were published")
	}
}

func TestDisconnectFromHandlerStillAcknowledges(t *testing.T) {
	f := setup(t, func(cfg *Config) { cfg.Pool = nil; cfg.ConnectionString = os.Getenv("PGMQ_URL") })
	f.publish(t, nil)
	err := f.c.Subscribe(f.ctx, func(ctx context.Context, m core.Message) error { return f.c.Disconnect(ctx) }, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("disconnect result: %v", err)
	}
	if f.depth(t, f.cfg.QueueName) != 0 {
		t.Fatal("owned pool closed before handler acknowledgement")
	}
}

func TestDisconnectDrainsManualAcknowledgement(t *testing.T) {
	for _, queued := range []bool{false, true} {
		t.Run(fmt.Sprint(queued), func(t *testing.T) {
			f := setup(t, func(cfg *Config) {
				cfg.Pool = nil
				cfg.ConnectionString = os.Getenv("PGMQ_URL")
				separator := "?"
				if strings.Contains(cfg.ConnectionString, "?") {
					separator = "&"
				}
				cfg.ConnectionString += separator + "pool_max_conns=1"
			})
			f.publish(t, nil)
			m := f.one(t)
			conn, err := f.c.Client().Acquire(f.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Release()
			var extension chan error
			if queued {
				extension = make(chan error, 1)
				go func() { extension <- m.ExtendDeadline(f.ctx, 5*time.Second) }()
				select {
				case err := <-extension:
					t.Fatalf("extension should wait for connection: %v", err)
				case <-time.After(50 * time.Millisecond):
				}
			}
			done := make(chan error, 1)
			go func() { done <- m.Ack(f.ctx) }()
			select {
			case err := <-done:
				t.Fatalf("ack should wait for connection: %v", err)
			case <-time.After(50 * time.Millisecond):
			}
			if err := f.c.Disconnect(f.ctx); err != nil {
				t.Fatal(err)
			}
			conn.Release()
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("disconnect interrupted active acknowledgement: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("acknowledgement did not drain")
			}
			if extension != nil {
				if err := <-extension; err != nil {
					t.Fatalf("extension did not drain: %v", err)
				}
			}
			if f.depth(t, f.cfg.QueueName) != 0 {
				t.Fatal("acknowledgement left original")
			}

		})
	}
}

func TestCancellationReleasesPendingRead(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		t.Run(fmt.Sprint(disconnect), func(t *testing.T) {
			f := setup(t, nil)
			f.publish(t, nil)
			tx, err := f.pool.Begin(f.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err := tx.Exec(f.ctx, "LOCK TABLE "+pgx.Identifier{"pgmq", "q_" + f.cfg.QueueName}.Sanitize()+" IN ACCESS EXCLUSIVE MODE"); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(f.ctx)
			defer cancel()
			done := make(chan error, 1)
			var calls atomic.Int32
			go func() {
				done <- f.c.Subscribe(ctx, func(context.Context, core.Message) error { calls.Add(1); return nil }, nil)
			}()
			waitFor(t, func() bool {
				var n int
				err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%pgmq.read%' AND query NOT LIKE '%pg_stat_activity%'").Scan(&n)
				return err == nil && n > 0
			})
			if disconnect {
				if err := f.c.Disconnect(f.ctx); err != nil {
					t.Fatal(err)
				}
			} else {
				cancel()
			}
			if err := tx.Commit(f.ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("subscription did not stop")
			}
			if calls.Load() != 0 || f.visible(t) != 1 {
				t.Fatalf("pending read lease was not released, calls %d", calls.Load())
			}
		})
	}
}

func waitFor(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}
