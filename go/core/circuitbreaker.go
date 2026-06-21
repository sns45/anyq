package core

import (
	"context"
	"sync"
	"time"
)

// CircuitState is the circuit breaker's state.
type CircuitState string

const (
	CircuitClosed   CircuitState = "closed"
	CircuitOpen     CircuitState = "open"
	CircuitHalfOpen CircuitState = "half-open"
)

// CircuitBreakerMetrics is a snapshot of circuit breaker state.
type CircuitBreakerMetrics struct {
	State           CircuitState
	Failures        int
	Successes       int
	LastFailureTime *time.Time
	TotalRequests   int
	TotalFailures   int
}

// CircuitBreaker protects against cascading connection/transport failures by
// failing fast when a downstream broker is unavailable. This is independent of
// per-message retry strategies (see ApplyStrategy).
type CircuitBreaker struct {
	mu              sync.Mutex
	cfg             CircuitBreakerConfig
	state           CircuitState
	failures        []time.Time
	successes       int
	lastFailureTime *time.Time
	totalRequests   int
	totalFailures   int
}

// NewCircuitBreaker builds a circuit breaker, merging cfg over defaults.
func NewCircuitBreaker(cfg *CircuitBreakerConfig) *CircuitBreaker {
	resolved := DefaultCircuitBreakerConfig
	if cfg != nil {
		resolved = *cfg
	}
	return &CircuitBreaker{cfg: resolved, state: CircuitClosed}
}

// ErrCircuitOpen is returned when the circuit is open.
var ErrCircuitOpen = &AnyQError{Message: "circuit breaker is open", Code: "CIRCUIT_OPEN", Retryable: false}

// Execute runs op through the circuit breaker.
func (cb *CircuitBreaker) Execute(ctx context.Context, op func() error) error {
	if !cb.cfg.Enabled {
		return op()
	}

	cb.mu.Lock()
	cb.totalRequests++
	cb.cleanOldFailures()
	if cb.state == CircuitOpen {
		if cb.shouldAttemptReset() {
			cb.state = CircuitHalfOpen
			cb.successes = 0
		} else {
			cb.mu.Unlock()
			return ErrCircuitOpen
		}
	}
	cb.mu.Unlock()

	err := op()

	cb.mu.Lock()
	defer cb.mu.Unlock()
	if err != nil {
		cb.onFailure()
		return err
	}
	cb.onSuccess()
	return nil
}

// State returns the current state.
func (cb *CircuitBreaker) State() CircuitState {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return cb.state
}

// Metrics returns a snapshot of current metrics.
func (cb *CircuitBreaker) Metrics() CircuitBreakerMetrics {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.cleanOldFailures()
	return CircuitBreakerMetrics{
		State:           cb.state,
		Failures:        len(cb.failures),
		Successes:       cb.successes,
		LastFailureTime: cb.lastFailureTime,
		TotalRequests:   cb.totalRequests,
		TotalFailures:   cb.totalFailures,
	}
}

// Reset forces the circuit closed.
func (cb *CircuitBreaker) Reset() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.state = CircuitClosed
	cb.failures = nil
	cb.successes = 0
	cb.lastFailureTime = nil
}

func (cb *CircuitBreaker) onSuccess() {
	switch cb.state {
	case CircuitHalfOpen:
		cb.successes++
		if cb.successes >= cb.cfg.SuccessThreshold {
			cb.state = CircuitClosed
			cb.failures = nil
			cb.successes = 0
		}
	case CircuitClosed:
		cb.successes = 0
	}
}

func (cb *CircuitBreaker) onFailure() {
	now := time.Now()
	cb.failures = append(cb.failures, now)
	cb.lastFailureTime = &now
	cb.totalFailures++

	switch cb.state {
	case CircuitHalfOpen:
		cb.state = CircuitOpen
		cb.successes = 0
	case CircuitClosed:
		cb.cleanOldFailures()
		if len(cb.failures) >= cb.cfg.FailureThreshold {
			cb.state = CircuitOpen
		}
	}
}

func (cb *CircuitBreaker) cleanOldFailures() {
	cutoff := time.Now().Add(-time.Duration(cb.cfg.FailureWindowMs) * time.Millisecond)
	kept := cb.failures[:0]
	for _, t := range cb.failures {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	cb.failures = kept
}

func (cb *CircuitBreaker) shouldAttemptReset() bool {
	if cb.lastFailureTime == nil {
		return true
	}
	return time.Since(*cb.lastFailureTime) >= time.Duration(cb.cfg.ResetTimeoutMs)*time.Millisecond
}
