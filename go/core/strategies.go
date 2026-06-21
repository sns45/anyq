package core

import (
	"context"
	"strings"
)

// Action is the action a Strategy decides to take for a failed message.
//
// This enum is "closed for users, open for the library": future versions MAY add
// variants. Custom strategies that switch on Action SHOULD handle the default
// case (ApplyStrategy treats unknown actions as DeadLetter).
type Action int

const (
	// ActionAck treats the failure as success; ack/commit and move on.
	ActionAck Action = iota
	// ActionRetry retries the handler in-process after DelayMs.
	ActionRetry
	// ActionRequeue nacks with requeue so the broker redelivers.
	ActionRequeue
	// ActionDeadLetter routes the message to a DLQ.
	ActionDeadLetter
	// ActionPark schedules a delayed retry via broker delay (or downgrades).
	ActionPark
	// ActionFail rethrows; crashes the consumer loop.
	ActionFail
)

func (a Action) String() string {
	switch a {
	case ActionAck:
		return "ack"
	case ActionRetry:
		return "retry"
	case ActionRequeue:
		return "requeue"
	case ActionDeadLetter:
		return "deadLetter"
	case ActionPark:
		return "park"
	case ActionFail:
		return "fail"
	default:
		return "unknown"
	}
}

// Decision is the result of Strategy.Decide. DelayMs applies to Retry/Park;
// Reason applies to DeadLetter.
type Decision struct {
	Action  Action
	DelayMs int
	Reason  string
}

// Convenience constructors for decisions.
func Ack() Decision                     { return Decision{Action: ActionAck} }
func Retry(delayMs int) Decision        { return Decision{Action: ActionRetry, DelayMs: delayMs} }
func Requeue() Decision                 { return Decision{Action: ActionRequeue} }
func DeadLetter(reason string) Decision { return Decision{Action: ActionDeadLetter, Reason: reason} }
func Park(delayMs int) Decision         { return Decision{Action: ActionPark, DelayMs: delayMs} }
func Fail() Decision                    { return Decision{Action: ActionFail} }

// StrategyContext is the input to Strategy.Decide for a single failure.
type StrategyContext struct {
	// Message is the failed message.
	Message Message
	// Err is the error returned by the handler.
	Err error
	// Attempt is the 1-based delivery attempt count (mirrors DeliveryAttempt).
	Attempt int
	// MaxAttempts is the resolved maximum attempts (see ResolveMaxAttempts).
	MaxAttempts int
}

// Strategy is a pluggable per-message retry strategy.
type Strategy interface {
	// Name is a stable identifier used in logs and for signalling (e.g. the
	// backpressure pause). See BackpressurePauseStrategyName.
	Name() string
	// Decide maps a (message, error, attempt) triple to a Decision.
	Decide(ctx context.Context, sc StrategyContext) (Decision, error)
}

// BackpressurePauseStrategyName is the stable name that signals a park decision
// should also pause/resume the whole consumer. ApplyStrategy checks for it.
const BackpressurePauseStrategyName = "backpressure-pause"

// strategyFunc adapts a function into a Strategy.
type strategyFunc struct {
	name string
	fn   func(ctx context.Context, sc StrategyContext) (Decision, error)
}

func (s strategyFunc) Name() string { return s.name }
func (s strategyFunc) Decide(ctx context.Context, sc StrategyContext) (Decision, error) {
	return s.fn(ctx, sc)
}

// Custom wraps an arbitrary function as a Strategy.
func Custom(name string, fn func(ctx context.Context, sc StrategyContext) (Decision, error)) Strategy {
	return strategyFunc{name: name, fn: fn}
}

// LogAndSkip acks the message and moves on (effectively dropping it).
func LogAndSkip() Strategy {
	return strategyFunc{name: "log-and-skip", fn: func(context.Context, StrategyContext) (Decision, error) {
		return Ack(), nil
	}}
}

// LogAndFail returns Fail so the consumer loop crashes.
func LogAndFail() Strategy {
	return strategyFunc{name: "log-and-fail", fn: func(context.Context, StrategyContext) (Decision, error) {
		return Fail(), nil
	}}
}

// DeadLetterImmediate routes straight to the DLQ with no retry (poison messages).
func DeadLetterImmediate() Strategy {
	return strategyFunc{name: "dead-letter-immediate", fn: func(_ context.Context, sc StrategyContext) (Decision, error) {
		return DeadLetter(errMessage(sc.Err)), nil
	}}
}

// RetryThenDeadLetterOptions configure RetryThenDeadLetter.
type RetryThenDeadLetterOptions struct {
	// MaxAttempts overrides the resolved max attempts when > 0.
	MaxAttempts int
	// Backoff overrides the backoff configuration (merged over defaults).
	Backoff *RetryConfig
	// IsRetryable overrides the retryable predicate.
	IsRetryable func(error) bool
}

// RetryThenDeadLetter retries in-process with exponential backoff while the
// error is retryable and attempts remain; otherwise dead-letters. This is the
// reference strategy.
func RetryThenDeadLetter(opts *RetryThenDeadLetterOptions) Strategy {
	var o RetryThenDeadLetterOptions
	if opts != nil {
		o = *opts
	}
	backoff := resolveRetryConfig(o.Backoff)
	isRetryable := o.IsRetryable
	if isRetryable == nil {
		isRetryable = func(err error) bool { return IsRetryableError(err, nil) }
	}
	return strategyFunc{name: "retry-then-dead-letter", fn: func(_ context.Context, sc StrategyContext) (Decision, error) {
		maxAttempts := sc.MaxAttempts
		if o.MaxAttempts > 0 {
			maxAttempts = o.MaxAttempts
		}
		if !isRetryable(sc.Err) {
			return DeadLetter(errMessage(sc.Err)), nil
		}
		if sc.Attempt >= maxAttempts {
			return DeadLetter("max attempts exceeded"), nil
		}
		return Retry(CalculateBackoff(sc.Attempt, backoff)), nil
	}}
}

// BackpressurePauseOptions configure BackpressurePause.
type BackpressurePauseOptions struct {
	// PauseMs is the pause/park duration. Default: 5000.
	PauseMs int
	// IsRateLimited overrides the rate-limit predicate.
	IsRateLimited func(error) bool
}

// BackpressurePause parks (with consumer pause/resume) on rate/quota errors and
// requeues otherwise. The whole-consumer pause is wired via the strategy Name
// being BackpressurePauseStrategyName, which ApplyStrategy recognises.
func BackpressurePause(opts *BackpressurePauseOptions) Strategy {
	var o BackpressurePauseOptions
	if opts != nil {
		o = *opts
	}
	pauseMs := o.PauseMs
	if pauseMs == 0 {
		pauseMs = 5000
	}
	isRateLimited := o.IsRateLimited
	if isRateLimited == nil {
		isRateLimited = defaultIsRateLimited
	}
	return strategyFunc{name: BackpressurePauseStrategyName, fn: func(_ context.Context, sc StrategyContext) (Decision, error) {
		if isRateLimited(sc.Err) {
			return Park(pauseMs), nil
		}
		return Requeue(), nil
	}}
}

func defaultIsRateLimited(err error) bool {
	if err == nil {
		return false
	}
	h := strings.ToLower(err.Error())
	return strings.Contains(h, "rate limit") ||
		strings.Contains(h, "too many requests") ||
		strings.Contains(h, "throttl") ||
		strings.Contains(h, "429") ||
		strings.Contains(h, "quota")
}

func errMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
