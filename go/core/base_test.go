package core_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/sns45/anyq/go/core"
)

// fakeMessage records ack/nack calls for assertions.
type fakeMessage struct {
	id      string
	attempt int
	mu      sync.Mutex
	acked   int
	nacked  []bool // requeue values, in order
}

func (m *fakeMessage) ID() string                      { return m.id }
func (m *fakeMessage) Body() []byte                    { return nil }
func (m *fakeMessage) Key() string                     { return "" }
func (m *fakeMessage) Headers() core.MessageHeaders    { return nil }
func (m *fakeMessage) Timestamp() time.Time            { return time.Time{} }
func (m *fakeMessage) DeliveryAttempt() int            { return m.attempt }
func (m *fakeMessage) Metadata() core.ProviderMetadata { return core.ProviderMetadata{} }
func (m *fakeMessage) Raw() any                        { return nil }
func (m *fakeMessage) Ack(context.Context) error       { m.mu.Lock(); m.acked++; m.mu.Unlock(); return nil }
func (m *fakeMessage) Nack(_ context.Context, r bool) error {
	m.mu.Lock()
	m.nacked = append(m.nacked, r)
	m.mu.Unlock()
	return nil
}
func (m *fakeMessage) ExtendDeadline(context.Context, time.Duration) error {
	return core.ErrNotSupported
}

// testConsumer embeds BaseConsumer and records hook invocations.
type testConsumer struct {
	*core.BaseConsumer
	nativeDelay bool

	mu       sync.Mutex
	dlqCalls []string
	parked   []int
	paused   bool
	resumed  bool
}

func newTestConsumer(cfg core.BaseQueueConfig, nativeDelay bool) *testConsumer {
	bc := &core.BaseConsumer{}
	bc.InitBase(cfg)
	tc := &testConsumer{BaseConsumer: bc, nativeDelay: nativeDelay}
	bc.Bind(tc)
	return tc
}

func (t *testConsumer) SupportsNativeDelay() bool { return t.nativeDelay }

func (t *testConsumer) DeadLetterMessage(ctx context.Context, msg core.Message, reason string) error {
	t.mu.Lock()
	t.dlqCalls = append(t.dlqCalls, reason)
	t.mu.Unlock()
	return nil
}

func (t *testConsumer) ParkMessage(ctx context.Context, msg core.Message, delayMs int) error {
	t.mu.Lock()
	t.parked = append(t.parked, delayMs)
	t.mu.Unlock()
	return nil
}

func (t *testConsumer) Pause(ctx context.Context) error {
	t.mu.Lock()
	t.paused = true
	t.mu.Unlock()
	return t.BaseConsumer.Pause(ctx)
}

func (t *testConsumer) Resume(ctx context.Context) error {
	t.mu.Lock()
	t.resumed = true
	t.mu.Unlock()
	return t.BaseConsumer.Resume(ctx)
}

func fastBackoff() *core.RetryConfig {
	return &core.RetryConfig{InitialDelayMs: 1, MaxDelayMs: 2, Multiplier: 1, Jitter: false}
}

func TestApplyStrategyNoStrategy(t *testing.T) {
	tc := newTestConsumer(core.BaseQueueConfig{}, false)
	msg := &fakeMessage{id: "1", attempt: 1}
	handled, err := tc.ApplyStrategy(context.Background(), msg, errors.New("boom"), nil)
	if handled || err != nil {
		t.Fatalf("handled=%v err=%v, want false,nil (legacy fallthrough)", handled, err)
	}
}

func TestApplyStrategyAck(t *testing.T) {
	tc := newTestConsumer(core.BaseQueueConfig{Strategy: core.LogAndSkip()}, false)
	msg := &fakeMessage{id: "1", attempt: 1}
	handled, err := tc.ApplyStrategy(context.Background(), msg, errors.New("boom"), nil)
	if !handled || err != nil {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if msg.acked != 1 {
		t.Fatalf("acked=%d, want 1", msg.acked)
	}
}

func TestApplyStrategyRequeue(t *testing.T) {
	strat := core.Custom("requeue", func(_ context.Context, _ core.StrategyContext) (core.Decision, error) {
		return core.Requeue(), nil
	})
	tc := newTestConsumer(core.BaseQueueConfig{Strategy: strat}, false)
	msg := &fakeMessage{id: "1", attempt: 1}
	handled, err := tc.ApplyStrategy(context.Background(), msg, errors.New("boom"), nil)
	if !handled || err != nil {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if len(msg.nacked) != 1 || msg.nacked[0] != true {
		t.Fatalf("nacked=%v, want [true]", msg.nacked)
	}
}

func TestApplyStrategyFailReturnsError(t *testing.T) {
	tc := newTestConsumer(core.BaseQueueConfig{Strategy: core.LogAndFail()}, false)
	msg := &fakeMessage{id: "1", attempt: 1}
	boom := errors.New("boom")
	handled, err := tc.ApplyStrategy(context.Background(), msg, boom, nil)
	if !handled {
		t.Fatal("expected handled=true for fail")
	}
	if !errors.Is(err, boom) {
		t.Fatalf("err=%v, want boom rethrown", err)
	}
}

func TestApplyStrategyDeadLetter(t *testing.T) {
	tc := newTestConsumer(core.BaseQueueConfig{Strategy: core.DeadLetterImmediate()}, false)
	msg := &fakeMessage{id: "1", attempt: 1}
	handled, err := tc.ApplyStrategy(context.Background(), msg, errors.New("poison"), nil)
	if !handled || err != nil {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if len(tc.dlqCalls) != 1 || tc.dlqCalls[0] != "poison" {
		t.Fatalf("dlqCalls=%v, want [poison]", tc.dlqCalls)
	}
}

func TestApplyStrategyRetryThenSucceeds(t *testing.T) {
	strat := core.RetryThenDeadLetter(&core.RetryThenDeadLetterOptions{Backoff: fastBackoff()})
	tc := newTestConsumer(core.BaseQueueConfig{
		Strategy: strat,
		Retry:    &core.RetryConfig{MaxRetries: 4},
	}, false)
	msg := &fakeMessage{id: "1", attempt: 1}

	calls := 0
	reinvoke := func() error {
		calls++
		if calls < 2 { // fail once, then succeed
			return core.NewConsumeError("transient", nil)
		}
		return nil
	}

	handled, err := tc.ApplyStrategy(context.Background(), msg, core.NewConsumeError("transient", nil), reinvoke)
	if !handled || err != nil {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if calls != 2 {
		t.Fatalf("reinvoke calls=%d, want 2", calls)
	}
	if msg.acked != 1 {
		t.Fatalf("acked=%d, want 1 after successful retry", msg.acked)
	}
	if len(tc.dlqCalls) != 0 {
		t.Fatalf("dlqCalls=%v, want none", tc.dlqCalls)
	}
}

func TestApplyStrategyRetryExhaustionDeadLetters(t *testing.T) {
	strat := core.RetryThenDeadLetter(&core.RetryThenDeadLetterOptions{Backoff: fastBackoff()})
	tc := newTestConsumer(core.BaseQueueConfig{
		Strategy: strat,
		Retry:    &core.RetryConfig{MaxRetries: 2}, // maxAttempts = 3
	}, false)
	msg := &fakeMessage{id: "1", attempt: 1}

	reinvoke := func() error { return core.NewConsumeError("always fails", nil) }

	handled, err := tc.ApplyStrategy(context.Background(), msg, core.NewConsumeError("always fails", nil), reinvoke)
	if !handled || err != nil {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if len(tc.dlqCalls) != 1 {
		t.Fatalf("dlqCalls=%v, want exactly one dead-letter on exhaustion", tc.dlqCalls)
	}
}

func TestApplyStrategyParkNative(t *testing.T) {
	strat := core.Custom("park", func(_ context.Context, _ core.StrategyContext) (core.Decision, error) {
		return core.Park(1234), nil
	})
	tc := newTestConsumer(core.BaseQueueConfig{Strategy: strat}, true) // native delay
	msg := &fakeMessage{id: "1", attempt: 1}
	handled, err := tc.ApplyStrategy(context.Background(), msg, errors.New("boom"), func() error { return nil })
	if !handled || err != nil {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if len(tc.parked) != 1 || tc.parked[0] != 1234 {
		t.Fatalf("parked=%v, want [1234]", tc.parked)
	}
}

func TestApplyStrategyParkDowngrade(t *testing.T) {
	// Non-native adapter: park downgrades to in-process retry.
	strat := core.Custom("park", func(_ context.Context, _ core.StrategyContext) (core.Decision, error) {
		return core.Park(1), nil
	})
	tc := newTestConsumer(core.BaseQueueConfig{
		Strategy: strat,
		Retry:    &core.RetryConfig{MaxRetries: 4},
	}, false) // no native delay
	msg := &fakeMessage{id: "1", attempt: 1}

	calls := 0
	reinvoke := func() error {
		calls++
		return nil // succeeds on downgrade retry
	}
	handled, err := tc.ApplyStrategy(context.Background(), msg, errors.New("boom"), reinvoke)
	if !handled || err != nil {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if calls != 1 {
		t.Fatalf("reinvoke calls=%d, want 1 (downgrade retry)", calls)
	}
	if len(tc.parked) != 0 {
		t.Fatalf("parked=%v, want none (no native delay)", tc.parked)
	}
	if msg.acked != 1 {
		t.Fatalf("acked=%d, want 1", msg.acked)
	}
}

func TestVerifyParkPolicy(t *testing.T) {
	parkStrategy := core.Custom("custom-park", func(_ context.Context, _ core.StrategyContext) (core.Decision, error) {
		return core.Park(10), nil
	})

	tests := []struct {
		name        string
		strategy    core.Strategy
		nativeDelay bool
		allow       bool
		wantErr     bool
	}{
		{name: "no strategy", strategy: nil, nativeDelay: false, allow: false, wantErr: false},
		{name: "never-park retryThenDeadLetter on non-native", strategy: core.RetryThenDeadLetter(nil), nativeDelay: false, allow: false, wantErr: false},
		{name: "never-park logAndSkip on non-native", strategy: core.LogAndSkip(), nativeDelay: false, allow: false, wantErr: false},
		{name: "might-park custom on native adapter", strategy: parkStrategy, nativeDelay: true, allow: false, wantErr: false},
		{name: "might-park custom on non-native, downgrade disallowed", strategy: parkStrategy, nativeDelay: false, allow: false, wantErr: true},
		{name: "might-park custom on non-native, downgrade allowed", strategy: parkStrategy, nativeDelay: false, allow: true, wantErr: false},
		{name: "backpressurePause on non-native, disallowed", strategy: core.BackpressurePause(nil), nativeDelay: false, allow: false, wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tc := tc
			cfg := core.BaseQueueConfig{Strategy: tc.strategy, AllowParkDowngrade: tc.allow}
			consumer := newTestConsumer(cfg, tc.nativeDelay)
			err := consumer.VerifyParkPolicy()
			if tc.wantErr && err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected nil, got %v", err)
			}
			if tc.wantErr {
				if ae, ok := core.AsAnyQError(err); !ok || ae.Code != "CONFIGURATION_ERROR" {
					t.Fatalf("expected CONFIGURATION_ERROR, got %v", err)
				}
			}
		})
	}
}

func TestApplyStrategyBackpressurePausesAndResumes(t *testing.T) {
	strat := core.BackpressurePause(&core.BackpressurePauseOptions{PauseMs: 20})
	tc := newTestConsumer(core.BaseQueueConfig{Strategy: strat}, true) // native delay so park hook is used
	tc.SetConnected(true)                                              // a real consumer is connected while processing; resume is skipped when disconnected
	msg := &fakeMessage{id: "1", attempt: 1}

	handled, err := tc.ApplyStrategy(context.Background(), msg, errors.New("rate limit exceeded"), func() error { return nil })
	if !handled || err != nil {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	tc.mu.Lock()
	paused := tc.paused
	tc.mu.Unlock()
	if !paused {
		t.Fatal("expected consumer to be paused by backpressure")
	}
	if len(tc.parked) != 1 {
		t.Fatalf("parked=%v, want one native park", tc.parked)
	}

	// Resume is scheduled via timer; wait for it.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		tc.mu.Lock()
		resumed := tc.resumed
		tc.mu.Unlock()
		if resumed {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("expected consumer to resume after pauseMs")
}
