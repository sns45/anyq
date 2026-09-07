package pgmq

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/sns45/anyq/go/core"
)

// Consumer reads pgmq messages and implements native parking and DLQ transfer.
type Consumer struct {
	*core.BaseConsumer
	cfg Config
	db  client
}

func NewConsumer(cfg Config) (*Consumer, error) {
	cfg, err := cfg.resolve()
	if err != nil {
		return nil, err
	}
	bc := &core.BaseConsumer{}
	bc.InitBase(cfg.BaseQueueConfig)
	c := &Consumer{BaseConsumer: bc, cfg: cfg}
	c.db = client{cfg: cfg, base: &bc.BaseAdapter}
	bc.Bind(c)
	return c, nil
}

func (c *Consumer) Connect(ctx context.Context) error {
	if err := c.VerifyParkPolicy(); err != nil {
		return err
	}
	return c.db.connect(ctx)
}
func (c *Consumer) Disconnect(ctx context.Context) error { return c.db.disconnect() }
func (c *Consumer) Client() *pgxpool.Pool                { return c.db.pool() }
func (c *Consumer) SupportsNativeDelay() bool            { return true }
func (c *Consumer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	h, err := c.db.health(ctx)
	if h.Details != nil {
		h.Details["paused"] = c.IsPaused()
	}
	return h, err
}

// Record is the native pgmq read result returned by Message.Raw.
type Record struct {
	MsgID      int64
	ReadCount  int
	EnqueuedAt time.Time
	VisibleAt  time.Time
	Body       json.RawMessage
	Headers    json.RawMessage
}

type delivery struct {
	mu      sync.Mutex
	settled bool
	owner   *Consumer
	session *session
	record  Record
}

type message struct {
	core.Message
	delivery *delivery
}

func (c *Consumer) wrap(s *session, record Record) (*message, error) {
	values := map[string]json.RawMessage{}
	if len(record.Headers) > 0 && string(record.Headers) != "null" {
		if err := json.Unmarshal(record.Headers, &values); err != nil {
			return nil, core.NewSerializationError("invalid pgmq headers", err)
		}
	}
	headers := core.MessageHeaders{}
	for k, v := range values {
		var str string
		if err := json.Unmarshal(v, &str); err == nil {
			headers[k] = []byte(str)
		} else {
			headers[k] = append([]byte(nil), v...)
		}
	}
	key := string(headers[routingKeyHeader])
	delete(headers, routingKeyHeader)
	d := &delivery{owner: c, session: s, record: record}
	id := strconv.FormatInt(record.MsgID, 10)
	m := core.NewMessage(core.MessageParams{
		ID: id, Body: record.Body, Headers: headers, Key: key, Timestamp: record.EnqueuedAt, DeliveryAttempt: record.ReadCount,
		Metadata: core.ProviderMetadata{Provider: core.DriverPgmq, Pgmq: &core.PgmqMetadata{QueueName: c.cfg.QueueName, MsgID: id, ReadCount: record.ReadCount, EnqueuedAt: record.EnqueuedAt, VisibleAt: record.VisibleAt}},
		Raw:      record,
		OnAck:    func(ctx context.Context) error { return d.dispose(ctx, "delete", 0) },
		OnNack: func(ctx context.Context, requeue bool) error {
			if requeue {
				return d.dispose(ctx, "release", 0)
			}
			return d.dispose(ctx, "archive", 0)
		},
		OnExtendDeadline: func(ctx context.Context, duration time.Duration) error {
			n, err := seconds(duration)
			if err != nil {
				return err
			}
			return d.dispose(ctx, "extend", n)
		},
	})
	return &message{Message: m, delivery: d}, nil
}

func (d *delivery) dispose(ctx context.Context, action string, seconds int32) error {
	active := d.session.acquire()
	if active {
		defer d.session.release()
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.settled {
		return nil
	}
	if !active {
		return core.NewConnectionError("pgmq delivery session has disconnected", nil)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), d.owner.cfg.RequestTimeout)
	defer cancel()
	var err error
	switch action {
	case "delete", "archive":
		var done bool
		query := "SELECT pgmq.delete($1,$2::bigint)"
		if action == "archive" {
			query = "SELECT pgmq.archive($1,$2::bigint)"
		}
		err = d.session.pool.QueryRow(ctx, query, d.owner.cfg.QueueName, d.record.MsgID).Scan(&done)
	default:
		var id int64
		err = d.session.pool.QueryRow(ctx, "SELECT msg_id FROM pgmq.set_vt($1,$2::bigint,$3::integer)", d.owner.cfg.QueueName, d.record.MsgID, seconds).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			err = nil
		}
	}
	if err != nil {
		return core.NewConsumeError("failed to settle pgmq message", err)
	}
	if action != "extend" {
		d.settled = true
	}
	return nil
}

func (c *Consumer) ownDelivery(msg core.Message) (*delivery, error) {
	m, ok := msg.(*message)
	if !ok || m.delivery.owner != c {
		return nil, core.NewConfigurationError("message does not belong to this pgmq consumer", nil)
	}
	return m.delivery, nil
}

// ParkMessage returns the same message to pgmq with a future visibility time.
func (c *Consumer) ParkMessage(ctx context.Context, msg core.Message, delayMs int) error {
	d, err := c.ownDelivery(msg)
	if err != nil {
		return err
	}
	if delayMs < 0 || int64(delayMs) > int64(math.MaxInt32)*1000 {
		return core.NewConfigurationError("park delay must fit a nonnegative Postgres integer number of seconds", nil)
	}
	n := int32((int64(delayMs) + 999) / 1000)
	return d.dispose(ctx, "park", n)
}

// DeadLetterMessage atomically sends to the DLQ and removes the original.
// Failed transfers leave the original available for redelivery after its lease.
func (c *Consumer) DeadLetterMessage(ctx context.Context, msg core.Message, reason string) error {
	d, err := c.ownDelivery(msg)
	if err != nil {
		return err
	}
	active := d.session.acquire()
	if active {
		defer d.session.release()
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.settled {
		return nil
	}
	if !active {
		return core.NewConnectionError("pgmq delivery session has disconnected", nil)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.cfg.RequestTimeout)
	defer cancel()
	headers := map[string]json.RawMessage{}
	if len(d.record.Headers) > 0 && string(d.record.Headers) != "null" {
		if err := json.Unmarshal(d.record.Headers, &headers); err != nil {
			return core.NewSerializationError("invalid pgmq headers", err)
		}
	}
	for k, v := range map[string]string{"x-original-queue": c.cfg.QueueName, "x-death-time": time.Now().UTC().Format(time.RFC3339Nano), "x-delivery-attempts": strconv.Itoa(msg.DeliveryAttempt())} {
		headers[k], _ = json.Marshal(v)
	}
	if dlq := c.cfg.BaseQueueConfig.DeadLetterQueue; dlq == nil || dlq.IncludeError {
		headers["x-death-reason"], _ = json.Marshal(reason)
	} else {
		delete(headers, "x-death-reason")
	}
	packed, err := json.Marshal(headers)
	if err != nil {
		return core.NewSerializationError("failed to encode DLQ headers", err)
	}
	tx, err := d.session.pool.Begin(ctx)
	if err != nil {
		return core.NewConsumeError("failed to begin pgmq DLQ transfer", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err := tx.Exec(ctx, "SELECT pgmq.send($1,$2::jsonb,$3::jsonb,0)", c.cfg.DeadLetterQueue, d.record.Body, packed); err != nil {
		return core.NewConsumeError("failed to publish pgmq dead letter", err)
	}
	var deleted bool
	if err := tx.QueryRow(ctx, "SELECT pgmq.delete($1,$2::bigint)", c.cfg.QueueName, d.record.MsgID).Scan(&deleted); err != nil {
		return core.NewConsumeError("failed to remove pgmq original", err)
	}
	if !deleted {
		// The source was already removed. Roll back the duplicate DLQ copy.
		if err := tx.Rollback(ctx); err != nil {
			return core.NewConsumeError("failed to roll back pgmq DLQ transfer", err)
		}
		d.settled = true
		return nil
	}
	if err := tx.Commit(ctx); err != nil {
		return core.NewConsumeError("failed to commit pgmq DLQ transfer", err)
	}
	d.settled = true
	return nil
}

func (c *Consumer) read(ctx context.Context, s *session, size int) ([]Record, error) {
	// Let a bounded read finish even during shutdown, then release any leases
	// it returns. Cancelling the query could lose a committed read result.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.cfg.RequestTimeout)
	defer cancel()
	vt, _ := seconds(c.cfg.VisibilityTimeout)
	rows, err := s.pool.Query(ctx, "SELECT msg_id,read_ct,enqueued_at,vt,message,headers FROM pgmq.read($1,$2::integer,$3::integer)", c.cfg.QueueName, vt, size)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var records []Record
	for rows.Next() {
		var r Record
		if err := rows.Scan(&r.MsgID, &r.ReadCount, &r.EnqueuedAt, &r.VisibleAt, &r.Body, &r.Headers); err != nil {
			return records, err
		}
		records = append(records, r)
	}
	return records, rows.Err()
}

func (c *Consumer) release(ctx context.Context, s *session, records []Record) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.cfg.RequestTimeout)
	defer cancel()
	var result error
	for _, r := range records {
		_, err := s.pool.Exec(ctx, "SELECT pgmq.set_vt($1,$2::bigint,0)", c.cfg.QueueName, r.MsgID)
		if err != nil {
			result = errors.Join(result, core.NewConsumeError("failed to release undelivered pgmq lease", err))
		}
	}
	return result
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (c *Consumer) loop(ctx context.Context, s *session, size int, handle func([]core.Message) error) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.IsPaused() {
			if err := sleep(ctx, c.cfg.PollInterval); err != nil {
				return err
			}
			continue
		}
		records, err := c.read(ctx, s, size)
		if err != nil {
			if releaseErr := c.release(ctx, s, records); releaseErr != nil {
				return errors.Join(err, releaseErr)
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			ce := core.NewConsumeError("failed to read pgmq messages", err)
			c.Logger.Error(ce.Error(), nil)
			if c.Config.OnError != nil {
				c.Config.OnError(ce)
			}
			if err := sleep(ctx, c.cfg.PollInterval); err != nil {
				return err
			}
			continue
		}
		if ctx.Err() != nil || c.IsPaused() {
			if err := c.release(ctx, s, records); err != nil {
				return err
			}
			continue
		}
		if len(records) == 0 {
			if err := sleep(ctx, c.cfg.PollInterval); err != nil {
				return err
			}
			continue
		}
		msgs := make([]core.Message, 0, len(records))
		for _, r := range records {
			m, err := c.wrap(s, r)
			if err != nil {
				return errors.Join(err, c.release(ctx, s, records))
			}
			msgs = append(msgs, m)
		}
		if err := handle(msgs); err != nil {
			return err
		}
	}
}

// Subscribe runs at most Concurrency handlers at once, each with its own read.
func (c *Consumer) Subscribe(ctx context.Context, handler core.Handler, opts *core.SubscribeOptions) error {
	if handler == nil {
		return core.NewConfigurationError("handler is required", nil)
	}
	s, err := c.db.acquire()
	if err != nil {
		return err
	}
	defer s.release()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	workers := 1
	if opts != nil && opts.Concurrency > 0 {
		workers = opts.Concurrency
	}
	results := make(chan error, workers)
	for i := 0; i < workers; i++ {
		go func() {
			results <- c.loop(ctx, s, 1, func(msgs []core.Message) error {
				m := msgs[0]
				err := handler(ctx, m)
				if err == nil {
					if opts.AutoAckEnabled() {
						return m.Ack(ctx)
					}
					return nil
				}
				return c.failed(ctx, m, err, func() error { return handler(ctx, m) })
			})
		}()
	}
	var result error
	for i := 0; i < workers; i++ {
		err := <-results
		if result == nil || (errors.Is(result, context.Canceled) && !errors.Is(err, context.Canceled)) {
			result = err
		}
		cancel()
	}
	return result
}

func (c *Consumer) SubscribeBatch(ctx context.Context, handler core.BatchHandler, opts *core.SubscribeOptions) error {
	if handler == nil {
		return core.NewConfigurationError("batch handler is required", nil)
	}
	size := c.cfg.BatchSize
	if opts != nil && opts.BatchSize > 0 {
		size = opts.BatchSize
	}
	if size > math.MaxInt32 {
		return core.NewConfigurationError("batch size must fit a Postgres integer", nil)
	}
	s, err := c.db.acquire()
	if err != nil {
		return err
	}
	defer s.release()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	return c.loop(ctx, s, size, func(msgs []core.Message) error {
		herr := handler(ctx, msgs)
		for _, m := range msgs {
			if herr == nil {
				if opts.AutoAckEnabled() {
					if err := m.Ack(ctx); err != nil {
						return err
					}
				}
			} else {
				if err := c.failed(ctx, m, herr, func() error { return handler(ctx, []core.Message{m}) }); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func (c *Consumer) failed(ctx context.Context, msg core.Message, herr error, reinvoke func() error) error {
	d, _ := c.ownDelivery(msg)
	d.mu.Lock()
	settled := d.settled
	d.mu.Unlock()
	if settled {
		return nil
	}
	handled, err := c.ApplyStrategy(ctx, msg, herr, reinvoke)
	if handled || err != nil {
		return err
	}
	c.Logger.Error("error processing pgmq message", map[string]any{"messageId": msg.ID(), "error": herr.Error()})
	if c.Config.OnError != nil {
		c.Config.OnError(herr)
	}
	if dlq := c.cfg.BaseQueueConfig.DeadLetterQueue; dlq != nil && dlq.Enabled && msg.DeliveryAttempt() >= c.ResolveMaxAttempts() {
		return c.DeadLetterMessage(ctx, msg, herr.Error())
	}
	return nil
}

var _ core.Consumer = (*Consumer)(nil)
var _ core.ConsumerHooks = (*Consumer)(nil)
