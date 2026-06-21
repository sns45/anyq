package nats

import (
	"context"
	"strings"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// connect opens a NATS connection from the connection config.
func connect(conn ConnectionConfig) (*nats.Conn, error) {
	opts := []nats.Option{
		nats.MaxReconnects(conn.MaxReconnectAttempts),
		nats.ReconnectWait(conn.ReconnectWait),
		nats.Timeout(conn.Timeout),
		nats.PingInterval(conn.PingInterval),
	}
	if conn.Name != "" {
		opts = append(opts, nats.Name(conn.Name))
	}
	if conn.User != "" || conn.Pass != "" {
		opts = append(opts, nats.UserInfo(conn.User, conn.Pass))
	}
	if conn.Token != "" {
		opts = append(opts, nats.Token(conn.Token))
	}
	url := strings.Join(conn.Servers, ",")
	return nats.Connect(url, opts...)
}

// ensureStream creates the stream if it does not already exist (mirrors the TS
// streams.info / streams.add dance).
func ensureStream(ctx context.Context, js jetstream.JetStream, cfg Config) error {
	name := cfg.JetStream.Stream
	if _, err := js.Stream(ctx, name); err == nil {
		return nil
	}
	_, err := js.CreateStream(ctx, jetstream.StreamConfig{
		Name:       name,
		Subjects:   cfg.subjects(),
		Storage:    storageType(cfg.JetStream.Storage),
		Replicas:   cfg.JetStream.Replicas,
		Retention:  retentionPolicy(cfg.JetStream.Retention),
		MaxMsgs:    orUnlimited(cfg.JetStream.MaxMsgs),
		MaxBytes:   orUnlimited(cfg.JetStream.MaxBytes),
		MaxAge:     cfg.JetStream.MaxAge,
		Discard:    discardPolicy(cfg.JetStream.Discard),
		Duplicates: cfg.JetStream.DuplicateWindow,
	})
	return err
}

func orUnlimited(v int64) int64 {
	if v <= 0 {
		return -1
	}
	return v
}

func storageType(s string) jetstream.StorageType {
	if s == "file" {
		return jetstream.FileStorage
	}
	return jetstream.MemoryStorage
}

func retentionPolicy(s string) jetstream.RetentionPolicy {
	switch s {
	case "interest":
		return jetstream.InterestPolicy
	case "workqueue":
		return jetstream.WorkQueuePolicy
	default:
		return jetstream.LimitsPolicy
	}
}

func discardPolicy(s string) jetstream.DiscardPolicy {
	if s == "new" {
		return jetstream.DiscardNew
	}
	return jetstream.DiscardOld
}

func deliverPolicy(s string) jetstream.DeliverPolicy {
	switch s {
	case "last":
		return jetstream.DeliverLastPolicy
	case "new":
		return jetstream.DeliverNewPolicy
	case "byStartSequence":
		return jetstream.DeliverByStartSequencePolicy
	case "byStartTime":
		return jetstream.DeliverByStartTimePolicy
	case "lastPerSubject":
		return jetstream.DeliverLastPerSubjectPolicy
	default:
		return jetstream.DeliverAllPolicy
	}
}

func replayPolicy(s string) jetstream.ReplayPolicy {
	if s == "original" {
		return jetstream.ReplayOriginalPolicy
	}
	return jetstream.ReplayInstantPolicy
}
