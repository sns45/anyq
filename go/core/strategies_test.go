package core_test

import (
	"context"
	"errors"
	"testing"

	"github.com/sns45/anyq/go/core"
)

func TestBuiltinStrategyDecisions(t *testing.T) {
	ctx := context.Background()
	retryable := core.NewConsumeError("connection refused", nil) // AnyQError retryable=true
	nonRetryable := &core.AnyQError{Message: "bad payload", Retryable: false}

	tests := []struct {
		name       string
		strategy   core.Strategy
		sc         core.StrategyContext
		wantAction core.Action
		check      func(t *testing.T, d core.Decision)
	}{
		{
			name:       "logAndSkip acks",
			strategy:   core.LogAndSkip(),
			sc:         core.StrategyContext{Err: retryable, Attempt: 1, MaxAttempts: 3},
			wantAction: core.ActionAck,
		},
		{
			name:       "logAndFail fails",
			strategy:   core.LogAndFail(),
			sc:         core.StrategyContext{Err: retryable, Attempt: 1, MaxAttempts: 3},
			wantAction: core.ActionFail,
		},
		{
			name:       "deadLetterImmediate dead-letters with error message",
			strategy:   core.DeadLetterImmediate(),
			sc:         core.StrategyContext{Err: nonRetryable, Attempt: 1, MaxAttempts: 3},
			wantAction: core.ActionDeadLetter,
			check: func(t *testing.T, d core.Decision) {
				if d.Reason != "bad payload" {
					t.Fatalf("reason = %q, want %q", d.Reason, "bad payload")
				}
			},
		},
		{
			name:       "retryThenDeadLetter retries when retryable under max",
			strategy:   core.RetryThenDeadLetter(&core.RetryThenDeadLetterOptions{Backoff: &core.RetryConfig{InitialDelayMs: 100, MaxDelayMs: 1000, Multiplier: 2, Jitter: false}}),
			sc:         core.StrategyContext{Err: retryable, Attempt: 1, MaxAttempts: 3},
			wantAction: core.ActionRetry,
			check: func(t *testing.T, d core.Decision) {
				if d.DelayMs <= 0 {
					t.Fatalf("delayMs = %d, want positive", d.DelayMs)
				}
			},
		},
		{
			name:       "retryThenDeadLetter dead-letters at max attempts",
			strategy:   core.RetryThenDeadLetter(nil),
			sc:         core.StrategyContext{Err: retryable, Attempt: 3, MaxAttempts: 3},
			wantAction: core.ActionDeadLetter,
			check: func(t *testing.T, d core.Decision) {
				if d.Reason != "max attempts exceeded" {
					t.Fatalf("reason = %q", d.Reason)
				}
			},
		},
		{
			name:       "retryThenDeadLetter dead-letters non-retryable immediately",
			strategy:   core.RetryThenDeadLetter(nil),
			sc:         core.StrategyContext{Err: nonRetryable, Attempt: 1, MaxAttempts: 3},
			wantAction: core.ActionDeadLetter,
		},
		{
			name:       "backpressurePause parks on rate limit",
			strategy:   core.BackpressurePause(&core.BackpressurePauseOptions{PauseMs: 1000}),
			sc:         core.StrategyContext{Err: errors.New("HTTP 429 too many requests"), Attempt: 1, MaxAttempts: 3},
			wantAction: core.ActionPark,
			check: func(t *testing.T, d core.Decision) {
				if d.DelayMs != 1000 {
					t.Fatalf("delayMs = %d, want 1000", d.DelayMs)
				}
			},
		},
		{
			name:       "backpressurePause requeues non-rate-limit",
			strategy:   core.BackpressurePause(nil),
			sc:         core.StrategyContext{Err: errors.New("some other error"), Attempt: 1, MaxAttempts: 3},
			wantAction: core.ActionRequeue,
		},
		{
			name: "custom strategy delegates",
			strategy: core.Custom("my-custom", func(_ context.Context, sc core.StrategyContext) (core.Decision, error) {
				return core.Ack(), nil
			}),
			sc:         core.StrategyContext{Err: retryable, Attempt: 1, MaxAttempts: 3},
			wantAction: core.ActionAck,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			d, err := tc.strategy.Decide(ctx, tc.sc)
			if err != nil {
				t.Fatalf("Decide returned error: %v", err)
			}
			if d.Action != tc.wantAction {
				t.Fatalf("action = %s, want %s", d.Action, tc.wantAction)
			}
			if tc.check != nil {
				tc.check(t, d)
			}
		})
	}
}

func TestBackpressurePauseStrategyName(t *testing.T) {
	if core.BackpressurePause(nil).Name() != core.BackpressurePauseStrategyName {
		t.Fatal("backpressurePause must use the canonical name to trigger consumer pause")
	}
}

func TestIsRetryableError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"anyq retryable", core.NewConnectionError("x", nil), true},
		{"anyq non-retryable", &core.AnyQError{Message: "x", Retryable: false}, false},
		{"default pattern match", errors.New("ECONNRESET happened"), true},
		{"default no match", errors.New("totally fine"), false},
		{"nil", nil, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := core.IsRetryableError(tc.err, nil); got != tc.want {
				t.Fatalf("IsRetryableError = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCalculateBackoffMonotonicNoJitter(t *testing.T) {
	cfg := core.RetryConfig{InitialDelayMs: 100, MaxDelayMs: 10000, Multiplier: 2, Jitter: false}
	d1 := core.CalculateBackoff(1, cfg)
	d2 := core.CalculateBackoff(2, cfg)
	d3 := core.CalculateBackoff(3, cfg)
	if d1 != 100 || d2 != 200 || d3 != 400 {
		t.Fatalf("backoff = %d,%d,%d want 100,200,400", d1, d2, d3)
	}
	if capped := core.CalculateBackoff(20, cfg); capped != 10000 {
		t.Fatalf("capped = %d, want 10000", capped)
	}
}
