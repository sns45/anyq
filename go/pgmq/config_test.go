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
		{QueueName: "orders", DeadLetterQueue: "bad/name"},
		{QueueName: strings.Repeat("a", 47)},
		{QueueName: "orders", DeadLetterQueue: "orders"},
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
	_, err := NewConsumer(Config{QueueName: strings.Repeat("A", 47), DeadLetterQueue: "short_dlq"})
	if err != nil {
		t.Fatal(err)
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
