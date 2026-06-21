package core

import (
	"context"
	"sync"
	"time"
)

// sleepCtx sleeps for d, returning ctx.Err() if the context is cancelled first.
func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// BaseAdapter holds functionality shared by producers and consumers: config,
// logging, the connection-level circuit breaker, and resolved retry config.
// Adapters embed it (directly or via BaseProducer/BaseConsumer) and call
// InitBase from their constructor.
type BaseAdapter struct {
	Config         BaseQueueConfig
	Logger         Logger
	CircuitBreaker *CircuitBreaker
	RetryConfig    RetryConfig

	mu        sync.RWMutex
	connected bool
}

// InitBase initialises the embedded BaseAdapter from config.
func (a *BaseAdapter) InitBase(cfg BaseQueueConfig) {
	a.Config = cfg
	prefix := cfg.ClientID
	if prefix == "" {
		prefix = string(cfg.Driver)
	}
	a.Logger = NewLogger(cfg.Logging, prefix)
	a.RetryConfig = resolveRetryConfig(cfg.Retry)
	a.CircuitBreaker = NewCircuitBreaker(cfg.CircuitBreaker)
}

// IsConnected reports the connection state.
func (a *BaseAdapter) IsConnected() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.connected
}

// SetConnected updates the connection state.
func (a *BaseAdapter) SetConnected(v bool) {
	a.mu.Lock()
	a.connected = v
	a.mu.Unlock()
}

// ExecuteWithResilience runs op through the circuit breaker with retry/backoff.
// This handles connection/transport resilience and is independent of per-message
// retry strategies.
func (a *BaseAdapter) ExecuteWithResilience(ctx context.Context, op func() error, name string) error {
	return a.CircuitBreaker.Execute(ctx, func() error {
		return a.withRetry(ctx, op, name)
	})
}

func (a *BaseAdapter) withRetry(ctx context.Context, op func() error, name string) error {
	cfg := a.RetryConfig
	total := cfg.MaxRetries + 1
	var lastErr error
	for attempt := 1; attempt <= total; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		lastErr = op()
		if lastErr == nil {
			return nil
		}
		isLast := attempt >= total
		if isLast || !IsRetryableError(lastErr, cfg.RetryableErrors) {
			return lastErr
		}
		delay := CalculateBackoff(attempt, cfg)
		if a.Logger != nil {
			a.Logger.Warn("retrying "+name, map[string]any{
				"attempt": attempt + 1, "maxAttempts": total, "delayMs": delay, "error": lastErr.Error(),
			})
		}
		if err := sleepCtx(ctx, time.Duration(delay)*time.Millisecond); err != nil {
			return err
		}
	}
	return lastErr
}

// BaseProducer provides default producer behaviour. Adapters embed it and call
// InitBase.
type BaseProducer struct {
	BaseAdapter
}

// Flush is a no-op default; batching producers override it.
func (p *BaseProducer) Flush(ctx context.Context) error { return nil }

// HealthCheck returns a basic health status based on connection state.
func (p *BaseProducer) HealthCheck(ctx context.Context) (HealthStatus, error) {
	connected := p.IsConnected()
	return HealthStatus{Healthy: connected, Connected: connected}, nil
}

// ConsumerHooks is the set of adapter-provided behaviours ApplyStrategy depends
// on. BaseConsumer implements defaults for all of them; concrete adapters embed
// *BaseConsumer, override what they need, and call Bind(self) so ApplyStrategy
// dispatches to the override (Go has no virtual method dispatch).
type ConsumerHooks interface {
	// SupportsNativeDelay reports whether the adapter can natively schedule a
	// delayed redelivery (the Park decision). When false, Park downgrades to an
	// in-process retry with a warning.
	SupportsNativeDelay() bool
	// DeadLetterMessage routes a message to a DLQ. The default warns and nacks
	// without requeue.
	DeadLetterMessage(ctx context.Context, msg Message, reason string) error
	// ParkMessage schedules a delayed redelivery. Only called when
	// SupportsNativeDelay returns true.
	ParkMessage(ctx context.Context, msg Message, delayMs int) error
	// Pause and Resume control consumption (used by backpressure pause).
	Pause(ctx context.Context) error
	Resume(ctx context.Context) error
}

// BaseConsumer provides default consumer behaviour, including ApplyStrategy.
type BaseConsumer struct {
	BaseAdapter

	self         ConsumerHooks
	pmu          sync.Mutex
	paused       bool
	bpTimer      *time.Timer
	parkWarnOnce sync.Once
}

// neverParkStrategies lists the built-in strategies that provably never emit a
// Park decision (their Decide only returns ack/fail/retry/deadLetter). Any other
// strategy — including BackpressurePause and any Custom strategy — is treated as
// potentially park-capable, since a custom Decide cannot be introspected.
//
// retry-then-dead-letter is included deliberately: it only ever returns retry or
// deadLetter, so excluding it would spuriously warn/fail for the reference
// strategy used by the broker-backed retry tests.
var neverParkStrategies = map[string]bool{
	"log-and-skip":           true,
	"log-and-fail":           true,
	"dead-letter-immediate":  true,
	"retry-then-dead-letter": true,
}

// strategyMightPark reports whether a configured strategy could emit a Park
// decision. It classifies by strategy name only (no static analysis of Decide):
// conservative — anything not provably park-free is assumed park-capable.
func strategyMightPark(s Strategy) bool {
	if s == nil {
		return false
	}
	return !neverParkStrategies[s.Name()]
}

// VerifyParkPolicy enforces the park-downgrade policy at consumer startup.
//
// When the configured strategy might emit Park but the adapter has no native
// delayed redelivery (SupportsNativeDelay() == false), a Park downgrades to a
// blocking in-process retry. If AllowParkDowngrade is false (the Go default),
// this returns a ConfigurationError so the caller fails loud; if true, it logs a
// single startup warning. It is a no-op when no strategy is set, the strategy
// can't park, or the adapter supports native delay.
//
// Adapters call this from Connect (after Bind, so SupportsNativeDelay resolves to
// the concrete adapter). It is safe to call more than once; the warning fires at
// most once.
func (c *BaseConsumer) VerifyParkPolicy() error {
	strategy := c.Config.Strategy
	if !strategyMightPark(strategy) {
		return nil
	}
	if c.hooks().SupportsNativeDelay() {
		return nil
	}

	driver := string(c.Config.Driver)
	if !c.Config.AllowParkDowngrade {
		return NewConfigurationError(
			"strategy may emit 'park' but this adapter has no native delayed-redelivery support; "+
				"park would downgrade to a blocking in-process retry capped by maxAttempts. "+
				"Set AllowParkDowngrade=true to opt into the downgrade, or use an adapter with "+
				"native delay (memory, sqs, nats, azure-servicebus).",
			map[string]any{"strategy": strategy.Name(), "driver": driver},
		)
	}

	c.parkWarnOnce.Do(func() {
		c.Logger.Warn(
			"strategy may emit 'park' but this adapter has no native delayed redelivery; "+
				"park will downgrade to a blocking in-process retry capped by maxAttempts",
			map[string]any{
				"strategy":    strategy.Name(),
				"driver":      driver,
				"maxAttempts": c.ResolveMaxAttempts(),
			},
		)
	})
	return nil
}

// Bind registers the concrete adapter so ApplyStrategy dispatches hook calls to
// the adapter's overrides. Call it from the adapter constructor after InitBase.
func (c *BaseConsumer) Bind(self ConsumerHooks) { c.self = self }

func (c *BaseConsumer) hooks() ConsumerHooks {
	if c.self != nil {
		return c.self
	}
	return c
}

// SupportsNativeDelay defaults to false; adapters with native delay override it.
func (c *BaseConsumer) SupportsNativeDelay() bool { return false }

// DeadLetterMessage is the default dead-letter hook: warn and nack(false).
func (c *BaseConsumer) DeadLetterMessage(ctx context.Context, msg Message, reason string) error {
	c.Logger.Warn("no native dead-letter hook; dropping message via nack(false)",
		map[string]any{"messageId": msg.ID(), "reason": reason})
	return msg.Nack(ctx, false)
}

// ParkMessage is the default park hook. It is unreachable unless an adapter sets
// SupportsNativeDelay true without overriding this; in that case it nacks.
func (c *BaseConsumer) ParkMessage(ctx context.Context, msg Message, delayMs int) error {
	c.Logger.Warn("parkMessage not implemented; nacking", map[string]any{"messageId": msg.ID()})
	return msg.Nack(ctx, true)
}

// Pause pauses consumption.
func (c *BaseConsumer) Pause(ctx context.Context) error {
	c.pmu.Lock()
	c.paused = true
	c.pmu.Unlock()
	c.Logger.Info("consumer paused", nil)
	return nil
}

// Resume resumes consumption.
func (c *BaseConsumer) Resume(ctx context.Context) error {
	c.pmu.Lock()
	c.paused = false
	c.pmu.Unlock()
	c.Logger.Info("consumer resumed", nil)
	return nil
}

// IsPaused reports the pause state.
func (c *BaseConsumer) IsPaused() bool {
	c.pmu.Lock()
	defer c.pmu.Unlock()
	return c.paused
}

// SetPaused sets the pause flag (for adapters overriding Pause/Resume).
func (c *BaseConsumer) SetPaused(v bool) {
	c.pmu.Lock()
	c.paused = v
	c.pmu.Unlock()
}

// emitError invokes the configured OnError callback, if any.
func (c *BaseConsumer) emitError(err error) {
	if c.Config.OnError != nil {
		c.Config.OnError(err)
	}
}

// ResolveMaxAttempts resolves the effective max attempts for a strategy context.
//
// Precedence: deadLetterQueue.maxDeliveryAttempts -> retry.maxRetries+1 ->
// DefaultRetryConfig.MaxRetries+1. Strategy-level overrides take precedence
// inside the strategy itself.
func (c *BaseConsumer) ResolveMaxAttempts() int {
	if dlq := c.Config.DeadLetterQueue; dlq != nil && dlq.MaxDeliveryAttempts > 0 {
		return dlq.MaxDeliveryAttempts
	}
	if r := c.Config.Retry; r != nil && r.MaxRetries > 0 {
		return r.MaxRetries + 1
	}
	return DefaultRetryConfig.MaxRetries + 1
}

// ApplyStrategy applies the configured retry strategy to a failed message.
//
// Boundary: the embedded circuit breaker handles connection/transport failure;
// retry strategies handle per-message handler failure. The two pause mechanisms
// (open circuit vs. backpressure pause) are independent; strategies never trip
// the breaker.
//
// Returns handled=false when no strategy is configured (the adapter should fall
// back to its legacy behaviour). When the strategy returns Fail, or the context
// is cancelled mid-retry, the relevant error is returned (handled=true) so the
// adapter can crash/stop the consume loop.
//
// reinvoke, when supplied, re-runs the handler for in-process retry/park-downgrade.
func (c *BaseConsumer) ApplyStrategy(ctx context.Context, msg Message, handlerErr error, reinvoke func() error) (bool, error) {
	strategy := c.Config.Strategy
	if strategy == nil {
		return false, nil
	}

	maxAttempts := c.ResolveMaxAttempts()
	currentErr := handlerErr
	currentAttempt := msg.DeliveryAttempt()

	for {
		sc := StrategyContext{Message: msg, Err: currentErr, Attempt: currentAttempt, MaxAttempts: maxAttempts}

		decision, decideErr := strategy.Decide(ctx, sc)
		if decideErr != nil {
			c.Logger.Error("retry strategy returned an error; treating as deadLetter", map[string]any{
				"strategy": strategy.Name(), "messageId": msg.ID(), "error": decideErr.Error(),
			})
			decision = DeadLetter(decideErr.Error())
		}

		if decision.Action != ActionAck {
			c.emitError(currentErr)
		}

		switch decision.Action {
		case ActionAck:
			return true, msg.Ack(ctx)

		case ActionRequeue:
			return true, msg.Nack(ctx, true)

		case ActionFail:
			// Rethrow; matches LogAndFail semantics (crashes the loop).
			return true, currentErr

		case ActionDeadLetter:
			if err := c.hooks().DeadLetterMessage(ctx, msg, decision.Reason); err != nil {
				c.Logger.Error("dead-letter hook failed", map[string]any{"messageId": msg.ID(), "error": err.Error()})
			}
			return true, nil

		case ActionPark:
			// Backpressure pause runs regardless of native vs downgrade: the
			// intent is "stop hammering the downstream system".
			if strategy.Name() == BackpressurePauseStrategyName {
				c.scheduleBackpressureResume(ctx, decision.DelayMs)
			}

			if c.hooks().SupportsNativeDelay() {
				if err := c.hooks().ParkMessage(ctx, msg, decision.DelayMs); err != nil {
					c.Logger.Error("park hook failed", map[string]any{"messageId": msg.ID(), "error": err.Error()})
				}
				return true, nil
			}

			// Downgrade: in-process retry after the requested delay, capped by
			// maxAttempts so a perpetually-failing handler can't spin forever.
			c.Logger.Warn("park requested but adapter has no native delay; downgrading to in-process retry",
				map[string]any{"strategy": strategy.Name(), "messageId": msg.ID(), "delayMs": decision.DelayMs})
			if reinvoke == nil {
				c.deadLetter(ctx, msg, "park downgrade requested but no reinvoke callback available")
				return true, nil
			}
			if currentAttempt >= maxAttempts {
				c.deadLetter(ctx, msg, "max attempts exceeded (park downgrade)")
				return true, nil
			}
			if err := sleepCtx(ctx, time.Duration(decision.DelayMs)*time.Millisecond); err != nil {
				return true, err
			}
			if reErr := reinvoke(); reErr != nil {
				currentErr = reErr
				currentAttempt++
				continue
			}
			return true, msg.Ack(ctx)

		case ActionRetry:
			if reinvoke == nil {
				c.Logger.Warn("retry requested but no reinvoke callback supplied; dead-lettering",
					map[string]any{"strategy": strategy.Name(), "messageId": msg.ID()})
				c.deadLetter(ctx, msg, "retry without reinvoke")
				return true, nil
			}
			if currentAttempt >= maxAttempts {
				c.deadLetter(ctx, msg, "max attempts exceeded")
				return true, nil
			}
			if err := sleepCtx(ctx, time.Duration(decision.DelayMs)*time.Millisecond); err != nil {
				return true, err
			}
			if reErr := reinvoke(); reErr != nil {
				currentErr = reErr
				currentAttempt++
				continue
			}
			return true, msg.Ack(ctx)

		default:
			// Forward-compatible: unknown actions dead-letter so library updates
			// don't break adapters at runtime.
			c.Logger.Warn("unknown retry decision; dead-lettering",
				map[string]any{"strategy": strategy.Name(), "messageId": msg.ID(), "action": decision.Action.String()})
			c.deadLetter(ctx, msg, "unknown decision")
			return true, nil
		}
	}
}

func (c *BaseConsumer) deadLetter(ctx context.Context, msg Message, reason string) {
	if err := c.hooks().DeadLetterMessage(ctx, msg, reason); err != nil {
		c.Logger.Error("dead-letter hook failed", map[string]any{"messageId": msg.ID(), "error": err.Error()})
	}
}

func (c *BaseConsumer) scheduleBackpressureResume(ctx context.Context, delayMs int) {
	if err := c.hooks().Pause(ctx); err != nil {
		c.Logger.Error("failed to pause for backpressure", map[string]any{"error": err.Error()})
	}
	c.pmu.Lock()
	if c.bpTimer != nil {
		c.bpTimer.Stop()
	}
	c.bpTimer = time.AfterFunc(time.Duration(delayMs)*time.Millisecond, func() {
		// Skip the resume if the consumer was disconnected during the pause window.
		if !c.IsConnected() {
			return
		}
		if err := c.hooks().Resume(context.Background()); err != nil {
			c.Logger.Error("failed to resume after backpressure pause", map[string]any{"error": err.Error()})
		}
	})
	c.pmu.Unlock()
}
