package pgmq

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/sns45/anyq/go/core"
)

func TestConstructionRejectsInvalidConfiguration(t *testing.T) {
	for _, cfg := range []Config{
		{QueueName: ""},
		{QueueName: "orders;DROP TABLE users"},
		{QueueName: "orders space"},
		{QueueName: strings.Repeat("a", 48)},
		{QueueName: "orders", DeadLetterQueue: "bad/name", BaseQueueConfig: core.BaseQueueConfig{DeadLetterQueue: &core.DeadLetterConfig{Enabled: true}}},
		{QueueName: strings.Repeat("a", 47), BaseQueueConfig: core.BaseQueueConfig{DeadLetterQueue: &core.DeadLetterConfig{Enabled: true}}},
		{QueueName: "orders", DeadLetterQueue: "ORDERS", BaseQueueConfig: core.BaseQueueConfig{DeadLetterQueue: &core.DeadLetterConfig{Enabled: true}}},
		{QueueName: "orders", BaseQueueConfig: core.BaseQueueConfig{DeadLetterQueue: &core.DeadLetterConfig{Enabled: true, Destination: "bad/name"}}},
		{QueueName: "orders", PollInterval: -time.Second},
		{QueueName: "orders", VisibilityTimeout: -time.Second},
		{QueueName: "orders", BatchSize: -1},
	} {
		_, err := NewProducer(cfg)
		var qe *core.AnyQError
		if !errors.As(err, &qe) || qe.Code != "CONFIGURATION_ERROR" {
			t.Errorf("producer accepted invalid config %+v: %v", cfg, err)
		}
		if _, err := NewConsumer(cfg); err == nil {
			t.Errorf("consumer accepted invalid config %+v", cfg)
		}
	}
}

func TestValidMaximumQueueNameWithExplicitDLQ(t *testing.T) {
	_, err := NewConsumer(Config{QueueName: strings.Repeat("A", 47), DeadLetterQueue: "short_dlq", BaseQueueConfig: core.BaseQueueConfig{DeadLetterQueue: &core.DeadLetterConfig{Enabled: true}}})
	if err != nil {
		t.Fatal(err)
	}
}

func TestInactiveDLQDoesNotValidateUnusedNames(t *testing.T) {
	for _, dlq := range []*core.DeadLetterConfig{nil, {Enabled: false, Destination: "bad/destination"}} {
		for _, cfg := range []Config{
			{QueueName: strings.Repeat("a", 47)},
			{QueueName: "orders", DeadLetterQueue: "bad/name"},
			{QueueName: "orders", DeadLetterQueue: "ORDERS"},
		} {
			cfg.BaseQueueConfig.DeadLetterQueue = dlq
			if _, err := NewProducer(cfg); err != nil {
				t.Errorf("producer rejected inactive DLQ %+v: %v", cfg, err)
			}
			if _, err := NewConsumer(cfg); err != nil {
				t.Errorf("consumer rejected inactive DLQ %+v: %v", cfg, err)
			}
		}
	}
}

func TestEnabledDLQNamePrecedence(t *testing.T) {
	for _, tc := range []struct{ name, destination, want string }{
		{"explicit_dlq", "bad/destination", "explicit_dlq"},
		{"", "destination_dlq", "destination_dlq"},
		{"", "", "orders_dlq"},
	} {
		c, err := NewConsumer(Config{
			QueueName: "orders", DeadLetterQueue: tc.name,
			BaseQueueConfig: core.BaseQueueConfig{DeadLetterQueue: &core.DeadLetterConfig{Enabled: true, Destination: tc.destination}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if c.cfg.DeadLetterQueue != tc.want {
			t.Errorf("resolved DLQ %q, want %q", c.cfg.DeadLetterQueue, tc.want)
		}
	}
}

func TestNativeParkPolicyNeedsNoDowngrade(t *testing.T) {
	c, err := NewConsumer(Config{QueueName: "orders", BaseQueueConfig: core.BaseQueueConfig{Strategy: core.BackpressurePause(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.VerifyParkPolicy(); err != nil {
		t.Fatal(err)
	}
	if !c.SupportsNativeDelay() {
		t.Fatal("pgmq must park through set_vt")
	}
}
