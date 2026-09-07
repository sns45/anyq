package pgmq

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/sns45/anyq/go/core"
)

type session struct {
	pool     *pgxpool.Pool
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	users    int
	stopping bool
	owned    bool
}

// acquire retains the original session until an operation has finished.
// During shutdown, existing handlers may still settle their deliveries.
func (s *session) acquire() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping && s.users == 0 {
		return false
	}
	s.users++
	return true
}

func (s *session) release() {
	s.mu.Lock()
	s.users--
	closePool := s.stopping && s.users == 0 && s.owned
	s.mu.Unlock()
	if closePool {
		go s.pool.Close()
	}
}

func (s *session) stop() {
	s.mu.Lock()
	s.stopping = true
	s.cancel()
	closePool := s.users == 0 && s.owned
	s.mu.Unlock()
	if closePool {
		go s.pool.Close()
	}
}

type client struct {
	cfg     Config
	base    *core.BaseAdapter
	mu      sync.Mutex
	current *session
}

func (db *client) connect(ctx context.Context) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.current != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, db.cfg.ConnectionTimeout)
	defer cancel()
	pool := db.cfg.Pool
	owned := pool == nil
	if owned {
		var err error
		pool, err = pgxpool.New(ctx, db.cfg.ConnectionString)
		if err != nil {
			return core.NewConnectionError("failed to configure Postgres connection", err)
		}
	}
	if err := pool.Ping(ctx); err != nil {
		if owned {
			pool.Close()
		}
		return core.NewConnectionError("failed to connect to Postgres", err)
	}
	if err := prepare(ctx, pool, db.cfg); err != nil {
		if owned {
			pool.Close()
		}
		return err
	}
	sctx, stop := context.WithCancel(context.Background())
	db.current = &session{pool: pool, ctx: sctx, cancel: stop, owned: owned}
	db.base.SetConnected(true)
	return nil
}

func prepare(ctx context.Context, pool *pgxpool.Pool, cfg Config) error {
	var schema bool
	if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='pgmq')").Scan(&schema); err != nil {
		return core.NewConnectionError("failed to inspect pgmq installation", err)
	}
	installError := func(err error) error {
		message := "pgmq is unavailable; install using pgmq-extension/sql/pgmq.sql, then connect with AutoInstall disabled"
		if err != nil {
			message += ": " + err.Error()
		}
		return core.NewConfigurationError(message, nil)
	}
	if !schema {
		if !enabled(cfg.AutoInstall) {
			return installError(nil)
		}
		if _, err := pool.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS pgmq"); err != nil {
			return installError(err)
		}
	}
	var present bool
	if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pgmq' AND p.proname='read')").Scan(&present); err != nil {
		return core.NewConnectionError("failed to inspect pgmq functions", err)
	}
	if !present {
		return installError(nil)
	}
	if enabled(cfg.AutoCreate) {
		queues := []string{cfg.QueueName}
		if dlq := cfg.BaseQueueConfig.DeadLetterQueue; dlq != nil && dlq.Enabled {
			queues = append(queues, cfg.DeadLetterQueue)
		}
		for _, name := range queues {
			if _, err := pool.Exec(ctx, "SELECT pgmq.create($1)", name); err != nil {
				return core.NewConnectionError("failed to create pgmq queue", err)
			}
		}
	}
	return nil
}

func (db *client) acquire() (*session, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.current == nil {
		return nil, core.NewConnectionError("pgmq adapter not connected", nil)
	}
	db.current.acquire()
	return db.current, nil
}

func (db *client) disconnect() error {
	db.mu.Lock()
	defer db.mu.Unlock()
	s := db.current
	if s == nil {
		return nil
	}
	db.current = nil
	db.base.SetConnected(false)
	// A callback may disconnect its own consumer. Session references keep
	// its pool available until processing and settlement finish.
	s.stop()
	return nil
}

func (db *client) pool() *pgxpool.Pool {
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.current == nil {
		return nil
	}
	return db.current.pool
}

func (db *client) health(ctx context.Context) (core.HealthStatus, error) {
	start := time.Now()
	s, err := db.acquire()
	if err != nil {
		return core.HealthStatus{Error: "Not connected"}, nil
	}
	defer s.release()
	ctx, cancel := context.WithTimeout(ctx, db.cfg.RequestTimeout)
	defer cancel()
	var length, total int64
	err = s.pool.QueryRow(ctx, "SELECT queue_length, total_messages FROM pgmq.metrics($1)", db.cfg.QueueName).Scan(&length, &total)
	h := core.HealthStatus{Healthy: err == nil, Connected: err == nil, LatencyMs: time.Since(start).Milliseconds()}
	if err != nil {
		h.Error = err.Error()
	} else {
		h.Details = map[string]any{"queueName": db.cfg.QueueName, "queueLength": length, "totalMessages": total}
	}
	return h, nil
}

func retryable(err error) bool {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var pgerr *pgconn.PgError
	if !errors.As(err, &pgerr) {
		return true
	}
	return strings.HasPrefix(pgerr.Code, "08") || strings.HasPrefix(pgerr.Code, "40") || strings.HasPrefix(pgerr.Code, "53") || pgerr.Code == "55P03" || pgerr.Code == "57P01" || pgerr.Code == "57P02" || pgerr.Code == "57P03"
}
