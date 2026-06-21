package memory

import "sync"

// A process-global registry lets producers and consumers share queues by name,
// mirroring the TypeScript memory adapter registry.
var (
	regMu  sync.Mutex
	queues = map[string]*Queue{}
)

// GetQueue returns a registered queue by name, or nil.
func GetQueue(name string) *Queue {
	regMu.Lock()
	defer regMu.Unlock()
	return queues[name]
}

// RegisterQueue registers a queue under a name.
func RegisterQueue(name string, q *Queue) {
	regMu.Lock()
	queues[name] = q
	regMu.Unlock()
}

// GetOrCreateQueue returns the registered queue or creates and registers one.
func GetOrCreateQueue(name string, maxMessages int, maxAge int64) *Queue {
	regMu.Lock()
	defer regMu.Unlock()
	if q, ok := queues[name]; ok {
		return q
	}
	q := NewQueue(name, maxMessages, durationMs(maxAge))
	queues[name] = q
	return q
}

// UnregisterQueue removes a queue from the registry.
func UnregisterQueue(name string) bool {
	regMu.Lock()
	defer regMu.Unlock()
	if _, ok := queues[name]; !ok {
		return false
	}
	delete(queues, name)
	return true
}

// ClearAllQueues clears and removes every registered queue (test helper).
func ClearAllQueues() {
	regMu.Lock()
	defer regMu.Unlock()
	for _, q := range queues {
		q.Clear()
	}
	queues = map[string]*Queue{}
}

// QueueStats is a per-queue stats snapshot.
type QueueStats struct {
	Size       int `json:"size"`
	Processing int `json:"processing"`
}

// GetQueueStats returns stats for all registered queues.
func GetQueueStats() map[string]QueueStats {
	regMu.Lock()
	defer regMu.Unlock()
	out := make(map[string]QueueStats, len(queues))
	for name, q := range queues {
		out[name] = QueueStats{Size: q.Size(), Processing: q.ProcessingCount()}
	}
	return out
}
