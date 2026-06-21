// Package memory is an in-process queue adapter for anyq, used for testing and
// development and as the reference implementation for the retry-strategy hooks.
package memory

import (
	"sync"
	"time"

	"github.com/sns45/anyq/go/core"
)

// StoredMessage is the internal storage format for an in-memory message.
type StoredMessage struct {
	ID              string
	Body            []byte
	Key             string
	Headers         core.MessageHeaders
	Timestamp       time.Time
	DeliveryAttempt int
	Acknowledged    bool
	Requeued        bool
	DeadLettered    bool
}

// Queue is a simple FIFO in-memory queue with a processing set.
type Queue struct {
	mu          sync.Mutex
	name        string
	messages    []*StoredMessage
	processing  map[string]*StoredMessage
	maxMessages int
	maxAge      time.Duration
}

// NewQueue builds a Queue.
func NewQueue(name string, maxMessages int, maxAge time.Duration) *Queue {
	if name == "" {
		name = "default"
	}
	return &Queue{
		name:        name,
		processing:  make(map[string]*StoredMessage),
		maxMessages: maxMessages,
		maxAge:      maxAge,
	}
}

// Name returns the queue name.
func (q *Queue) Name() string { return q.name }

// Enqueue adds a message and returns its id.
func (q *Queue) Enqueue(body []byte, key string, headers core.MessageHeaders) string {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.cleanup()

	if headers == nil {
		headers = core.MessageHeaders{}
	}
	id := core.GenerateMessageID()
	msg := &StoredMessage{
		ID:        id,
		Body:      body,
		Key:       key,
		Headers:   headers,
		Timestamp: time.Now(),
	}
	q.messages = append(q.messages, msg)
	if q.maxMessages > 0 && len(q.messages) > q.maxMessages {
		q.messages = q.messages[1:]
	}
	return id
}

// Dequeue removes and returns the next message, moving it into processing.
func (q *Queue) Dequeue() *StoredMessage {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.cleanup()
	if len(q.messages) == 0 {
		return nil
	}
	msg := q.messages[0]
	q.messages = q.messages[1:]
	msg.DeliveryAttempt++
	q.processing[msg.ID] = msg
	return msg
}

// DequeueBatch returns up to count messages.
func (q *Queue) DequeueBatch(count int) []*StoredMessage {
	out := make([]*StoredMessage, 0, count)
	for i := 0; i < count; i++ {
		m := q.Dequeue()
		if m == nil {
			break
		}
		out = append(out, m)
	}
	return out
}

// Ack acknowledges a processing message.
func (q *Queue) Ack(id string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	msg, ok := q.processing[id]
	if !ok {
		return false
	}
	msg.Acknowledged = true
	delete(q.processing, id)
	return true
}

// Nack returns a message to the queue (requeue) or discards it.
func (q *Queue) Nack(id string, requeue bool) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	msg, ok := q.processing[id]
	if !ok {
		return false
	}
	delete(q.processing, id)
	if requeue {
		msg.Requeued = true
		q.messages = append([]*StoredMessage{msg}, q.messages...)
	}
	return true
}

// DeadLetter moves a processing message to the given DLQ with death headers.
func (q *Queue) DeadLetter(id string, dlq *Queue, reason string) bool {
	q.mu.Lock()
	msg, ok := q.processing[id]
	if !ok {
		q.mu.Unlock()
		return false
	}
	delete(q.processing, id)
	q.mu.Unlock()

	if reason == "" {
		reason = "max retries exceeded"
	}
	headers := core.MessageHeaders{}
	for k, v := range msg.Headers {
		headers[k] = v
	}
	headers["x-original-queue"] = []byte(q.name)
	headers["x-death-reason"] = []byte(reason)
	headers["x-death-time"] = []byte(time.Now().UTC().Format(time.RFC3339))
	headers["x-delivery-attempts"] = []byte(itoa(msg.DeliveryAttempt))

	dlq.Enqueue(msg.Body, msg.Key, headers)
	return true
}

// Size returns the number of queued (not-yet-dequeued) messages.
func (q *Queue) Size() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.messages)
}

// ProcessingCount returns the number of in-flight messages.
func (q *Queue) ProcessingCount() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.processing)
}

// Clear removes all messages.
func (q *Queue) Clear() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.messages = nil
	q.processing = make(map[string]*StoredMessage)
}

// cleanup removes expired messages (caller holds the lock).
func (q *Queue) cleanup() {
	if q.maxAge <= 0 {
		return
	}
	cutoff := time.Now().Add(-q.maxAge)
	kept := q.messages[:0]
	for _, m := range q.messages {
		if m.Timestamp.After(cutoff) {
			kept = append(kept, m)
		}
	}
	q.messages = kept
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
