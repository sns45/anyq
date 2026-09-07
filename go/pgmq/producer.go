package pgmq

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/sns45/anyq/go/core"
)

const routingKeyHeader = "x-anyq-key"

// Producer publishes JSON messages with headers in pgmq's headers column.
type Producer struct {
	core.BaseProducer
	cfg Config
	db  client
}

// NewProducer validates configuration before any database work.
func NewProducer(cfg Config) (*Producer, error) {
	cfg, err := cfg.resolve()
	if err != nil {
		return nil, err
	}
	p := &Producer{cfg: cfg}
	p.InitBase(cfg.BaseQueueConfig)
	p.db = client{cfg: cfg, base: &p.BaseAdapter}
	return p, nil
}

func (p *Producer) Connect(ctx context.Context) error    { return p.db.connect(ctx) }
func (p *Producer) Disconnect(ctx context.Context) error { return p.db.disconnect() }
func (p *Producer) Client() *pgxpool.Pool                { return p.db.pool() }
func (p *Producer) HealthCheck(ctx context.Context) (core.HealthStatus, error) {
	return p.db.health(ctx)
}

type encoded struct {
	body    json.RawMessage
	headers json.RawMessage
	delay   int32
}

func encode(body []byte, opts *core.PublishOptions) (encoded, error) {
	if !json.Valid(body) {
		return encoded{}, core.NewSerializationError("pgmq requires a valid JSON body", nil)
	}
	headers := map[string]string{}
	var delay int32
	if opts != nil {
		var err error
		delay, err = seconds(opts.Delay)
		if err != nil {
			return encoded{}, err
		}
		for k, v := range opts.Headers {
			if !utf8.Valid(v) || !utf8.ValidString(k) {
				return encoded{}, core.NewSerializationError("pgmq headers must contain valid UTF8 text", nil)
			}
			headers[k] = string(v)
		}
		if opts.Key != "" {
			if !utf8.ValidString(opts.Key) {
				return encoded{}, core.NewSerializationError("pgmq key must contain valid UTF8 text", nil)
			}
			headers[routingKeyHeader] = opts.Key
		}
	}
	h, err := json.Marshal(headers)
	if err != nil {
		return encoded{}, core.NewSerializationError("failed to encode pgmq headers", err)
	}
	return encoded{body: json.RawMessage(body), headers: h, delay: delay}, nil
}

func (p *Producer) Publish(ctx context.Context, body []byte, opts *core.PublishOptions) (string, error) {
	s, err := p.db.acquire()
	if err != nil {
		return "", err
	}
	defer s.release()
	msg, err := encode(body, opts)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, p.cfg.RequestTimeout)
	defer cancel()
	var id int64
	err = s.pool.QueryRow(ctx, "SELECT pgmq.send($1,$2::jsonb,$3::jsonb,$4::integer)", p.cfg.QueueName, msg.body, msg.headers, msg.delay).Scan(&id)
	if err != nil {
		return "", core.NewPublishError("failed to publish pgmq message", retryable(err), err)
	}
	return strconv.FormatInt(id, 10), nil
}

// PublishBatch preserves input order even when entries have different delays.
// All groups commit in one transaction so an error cannot publish a prefix.
func (p *Producer) PublishBatch(ctx context.Context, items []core.BatchItem) ([]string, error) {
	s, err := p.db.acquire()
	if err != nil {
		return nil, err
	}
	defer s.release()
	ids := make([]string, len(items))
	if len(items) == 0 {
		return ids, nil
	}
	type group struct {
		delay           int32
		bodies, headers []json.RawMessage
		indices         []int
	}
	groups := []*group{}
	byDelay := map[int32]*group{}
	for i, item := range items {
		msg, err := encode(item.Body, item.Options)
		if err != nil {
			return nil, err
		}
		g := byDelay[msg.delay]
		if g == nil {
			g = &group{delay: msg.delay}
			byDelay[msg.delay] = g
			groups = append(groups, g)
		}
		g.bodies = append(g.bodies, msg.body)
		g.headers = append(g.headers, msg.headers)
		g.indices = append(g.indices, i)
	}
	ctx, cancel := context.WithTimeout(ctx, p.cfg.RequestTimeout)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, core.NewPublishError("failed to begin pgmq batch", retryable(err), err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	for _, g := range groups {
		rows, err := tx.Query(ctx, "SELECT pgmq.send_batch($1,$2::jsonb[],$3::jsonb[],$4::integer)", p.cfg.QueueName, g.bodies, g.headers, g.delay)
		if err != nil {
			return nil, core.NewPublishError("failed to publish pgmq batch", retryable(err), err)
		}
		n := 0
		for rows.Next() {
			var id int64
			if err = rows.Scan(&id); err != nil {
				break
			}
			if n >= len(g.indices) {
				err = errors.New("pgmq returned too many batch IDs")
				break
			}
			ids[g.indices[n]] = strconv.FormatInt(id, 10)
			n++
		}
		rows.Close()
		if err == nil {
			err = rows.Err()
		}
		if err == nil && n != len(g.indices) {
			err = errors.New("pgmq returned too few batch IDs")
		}
		if err != nil {
			return nil, core.NewPublishError("failed to read pgmq batch IDs", retryable(err), err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, core.NewPublishError("failed to commit pgmq batch", retryable(err), err)
	}
	return ids, nil
}

var _ core.Producer = (*Producer)(nil)
