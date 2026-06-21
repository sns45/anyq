package core

import (
	"math"
	"math/rand"
	"strings"
)

// CalculateBackoff returns the delay in milliseconds for a 1-based attempt using
// exponential backoff with optional jitter. Mirrors middleware/retry.calculateBackoff.
func CalculateBackoff(attempt int, cfg RetryConfig) int {
	exp := float64(cfg.InitialDelayMs) * math.Pow(cfg.Multiplier, float64(attempt-1))
	delay := math.Min(exp, float64(cfg.MaxDelayMs))
	if cfg.Jitter {
		jitterRange := delay * 0.25
		delay = delay + (rand.Float64()*jitterRange*2 - jitterRange)
		if delay < 0 {
			delay = 0
		}
	}
	return int(math.Floor(delay))
}

// defaultRetryablePatterns mirrors the TypeScript isRetryableError default list.
var defaultRetryablePatterns = []string{
	"econnrefused",
	"econnreset",
	"etimedout",
	"enotfound",
	"eai_again",
	"socket hang up",
	"connection refused",
	"network error",
	"timeout",
	"temporarily unavailable",
	"service unavailable",
	"too many requests",
	"rate limit",
	"throttl",
}

// IsRetryableError reports whether err should be retried. AnyQError carries an
// explicit Retryable flag; otherwise the message/name is matched against the
// supplied patterns, falling back to a default transient-infrastructure list.
func IsRetryableError(err error, retryablePatterns []string) bool {
	if err == nil {
		return false
	}
	if ae, ok := AsAnyQError(err); ok {
		return ae.Retryable
	}

	msg := strings.ToLower(err.Error())
	if len(retryablePatterns) > 0 {
		for _, p := range retryablePatterns {
			if strings.Contains(msg, strings.ToLower(p)) {
				return true
			}
		}
		return false
	}

	for _, p := range defaultRetryablePatterns {
		if strings.Contains(msg, p) {
			return true
		}
	}
	return false
}

// BackoffStrategy selects a backoff curve for CalculateDelay.
type BackoffStrategy string

const (
	BackoffExponential BackoffStrategy = "exponential"
	BackoffLinear      BackoffStrategy = "linear"
	BackoffConstant    BackoffStrategy = "constant"
	BackoffFibonacci   BackoffStrategy = "fibonacci"
)

// BackoffOptions configure CalculateDelay.
type BackoffOptions struct {
	Strategy       BackoffStrategy
	InitialDelayMs int
	MaxDelayMs     int
	Multiplier     float64
	Jitter         bool
	JitterFactor   float64
}

func (o BackoffOptions) resolved() BackoffOptions {
	if o.Strategy == "" {
		o.Strategy = BackoffExponential
	}
	if o.InitialDelayMs == 0 {
		o.InitialDelayMs = DefaultRetryConfig.InitialDelayMs
	}
	if o.MaxDelayMs == 0 {
		o.MaxDelayMs = DefaultRetryConfig.MaxDelayMs
	}
	if o.Multiplier == 0 {
		o.Multiplier = DefaultRetryConfig.Multiplier
	}
	if o.JitterFactor == 0 {
		o.JitterFactor = 0.25
	}
	return o
}

// CalculateDelay computes a backoff delay (ms) for a 1-based attempt using the
// selected strategy.
func CalculateDelay(attempt int, opts BackoffOptions) int {
	o := opts.resolved()
	var delay float64
	switch o.Strategy {
	case BackoffLinear:
		mult := o.Multiplier
		if opts.Multiplier == 0 {
			mult = 1000 // linear increment per attempt
		}
		delay = float64(o.InitialDelayMs) + float64(attempt-1)*mult
	case BackoffConstant:
		delay = float64(o.InitialDelayMs)
	case BackoffFibonacci:
		delay = float64(o.InitialDelayMs) * float64(fibonacci(attempt))
	default: // exponential
		delay = float64(o.InitialDelayMs) * math.Pow(o.Multiplier, float64(attempt-1))
	}
	if o.Strategy != BackoffConstant {
		delay = math.Min(delay, float64(o.MaxDelayMs))
	}
	if o.Jitter {
		delay = applyJitter(delay, o.JitterFactor)
	}
	return int(math.Floor(delay))
}

func applyJitter(delay, factor float64) float64 {
	jitterRange := delay * factor
	v := delay + (rand.Float64()*jitterRange*2 - jitterRange)
	if v < 0 {
		return 0
	}
	return v
}

func fibonacci(n int) int {
	if n <= 1 {
		return 1
	}
	prev, curr := 1, 1
	for i := 2; i < n; i++ {
		prev, curr = curr, prev+curr
	}
	return curr
}
