// Package tester provides a small shared HTTP harness for the per-adapter
// integration test apps. Each adapter's main.go wires its own producer/consumer
// and reuses this harness to expose the standard endpoints:
//
//	GET  /                 service info
//	POST /publish          publish a single order
//	POST /publish/batch    publish multiple orders
//	POST /publish/test     publish a random order
//	GET  /health           health check (+ /health/ready, /health/live)
//	GET  /stats            service statistics
//	GET  /stats/messages   recent consumed messages
//
// It uses only net/http from the standard library.
package tester

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/sns45/anyq/go/core"
)

// OrderItem mirrors the TypeScript tester order item.
type OrderItem struct {
	ProductID string  `json:"productId"`
	Name      string  `json:"name"`
	Quantity  int     `json:"quantity"`
	Price     float64 `json:"price"`
}

// OrderMessage mirrors the TypeScript tester order message.
type OrderMessage struct {
	OrderID    string      `json:"orderId"`
	CustomerID string      `json:"customerId"`
	Items      []OrderItem `json:"items"`
	Total      float64     `json:"total"`
	CreatedAt  string      `json:"createdAt"`
}

// ConsumedMessage is a record of a consumed message for /stats/messages.
type ConsumedMessage struct {
	ID          string       `json:"id"`
	Body        OrderMessage `json:"body"`
	ReceivedAt  string       `json:"receivedAt"`
	ProcessedAt string       `json:"processedAt"`
}

const maxRecent = 100

// App is the shared tester application state and HTTP handler.
type App struct {
	// Service is the service name reported on GET /.
	Service string
	// Producer publishes orders.
	Producer core.Producer
	// ConsumerConnected reports consumer connectivity for /health and /stats.
	ConsumerConnected func() bool
	// ExtraStats optionally contributes adapter-specific fields to /stats.
	ExtraStats func() map[string]any

	mu              sync.Mutex
	published       int
	consumed        int
	lastMessageTime time.Time
	recent          []ConsumedMessage
}

// RecordConsumed is called by the adapter's subscription handler for each
// successfully processed message.
func (a *App) RecordConsumed(id string, body []byte, receivedAt time.Time) {
	var order OrderMessage
	_ = json.Unmarshal(body, &order)

	a.mu.Lock()
	defer a.mu.Unlock()
	a.consumed++
	a.lastMessageTime = time.Now()
	rec := ConsumedMessage{
		ID:          id,
		Body:        order,
		ReceivedAt:  receivedAt.UTC().Format(time.RFC3339Nano),
		ProcessedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	a.recent = append([]ConsumedMessage{rec}, a.recent...)
	if len(a.recent) > maxRecent {
		a.recent = a.recent[:maxRecent]
	}
}

// Handler returns the configured http.Handler with all routes mounted.
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", a.handleRoot)
	mux.HandleFunc("/publish", a.handlePublish)
	mux.HandleFunc("/publish/batch", a.handlePublishBatch)
	mux.HandleFunc("/publish/test", a.handlePublishTest)
	mux.HandleFunc("/health", a.handleHealth)
	mux.HandleFunc("/health/ready", a.handleHealth)
	mux.HandleFunc("/health/live", a.handleLive)
	mux.HandleFunc("/stats", a.handleStats)
	mux.HandleFunc("/stats/messages", a.handleStatsMessages)
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *App) handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"service": a.Service,
		"endpoints": map[string]string{
			"POST /publish":       "Publish a single order",
			"POST /publish/batch": "Publish multiple orders",
			"POST /publish/test":  "Publish a random test order",
			"GET /health":         "Health check",
			"GET /stats":          "Service statistics",
			"GET /stats/messages": "Recent consumed messages",
		},
	})
}

func (a *App) publish(ctx context.Context, order OrderMessage) (string, error) {
	body, err := json.Marshal(order)
	if err != nil {
		return "", err
	}
	id, err := a.Producer.Publish(ctx, body, &core.PublishOptions{Key: order.OrderID})
	if err != nil {
		return "", err
	}
	a.mu.Lock()
	a.published++
	a.mu.Unlock()
	return id, nil
}

func (a *App) handlePublish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var order OrderMessage
	if err := json.NewDecoder(r.Body).Decode(&order); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if order.OrderID == "" || order.CustomerID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required fields: orderId, customerId"})
		return
	}
	id, err := a.publish(r.Context(), order)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "messageId": id, "order": order})
}

func (a *App) handlePublishBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var payload struct {
		Orders []OrderMessage `json:"orders"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.Orders == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required field: orders (array)"})
		return
	}
	items := make([]core.BatchItem, 0, len(payload.Orders))
	for _, o := range payload.Orders {
		body, err := json.Marshal(o)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		items = append(items, core.BatchItem{Body: body, Options: &core.PublishOptions{Key: o.OrderID}})
	}
	ids, err := a.Producer.PublishBatch(r.Context(), items)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	a.mu.Lock()
	a.published += len(ids)
	a.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "count": len(ids), "messageIds": ids})
}

func (a *App) handlePublishTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	order := RandomOrder()
	id, err := a.publish(r.Context(), order)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "messageId": id, "order": order})
}

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	producerHealthy := a.Producer != nil && a.Producer.IsConnected()
	consumerHealthy := a.ConsumerConnected == nil || a.ConsumerConnected()
	healthy := producerHealthy && consumerHealthy
	status := http.StatusOK
	if !healthy {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]any{
		"healthy":   healthy,
		"producer":  map[string]any{"connected": producerHealthy},
		"consumer":  map[string]any{"connected": consumerHealthy},
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func (a *App) handleLive(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"alive": true})
}

func (a *App) handleStats(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	published, consumed := a.published, a.consumed
	var last any
	if !a.lastMessageTime.IsZero() {
		last = a.lastMessageTime.UTC().Format(time.RFC3339)
	}
	a.mu.Unlock()

	resp := map[string]any{
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"producer": map[string]any{
			"connected":         a.Producer != nil && a.Producer.IsConnected(),
			"messagesPublished": published,
		},
		"consumer": map[string]any{
			"connected":        a.ConsumerConnected == nil || a.ConsumerConnected(),
			"messagesConsumed": consumed,
			"lastMessageTime":  last,
		},
	}
	if a.ExtraStats != nil {
		for k, v := range a.ExtraStats() {
			resp[k] = v
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *App) handleStatsMessages(w http.ResponseWriter, r *http.Request) {
	limit := 20
	if q := r.URL.Query().Get("limit"); q != "" {
		if n, err := strconv.Atoi(q); err == nil && n > 0 {
			limit = n
		}
	}
	a.mu.Lock()
	msgs := a.recent
	if len(msgs) > limit {
		msgs = msgs[:limit]
	}
	out := make([]ConsumedMessage, len(msgs))
	copy(out, msgs)
	a.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"count":     len(out),
		"messages":  out,
	})
}

// RandomOrder builds a random test order.
func RandomOrder() OrderMessage {
	orderID := fmt.Sprintf("ORD-%d-%s", time.Now().UnixMilli(), randString(6))
	customerID := fmt.Sprintf("CUST-%d", rand.Intn(1000))
	n := rand.Intn(5) + 1
	items := make([]OrderItem, n)
	var total float64
	for i := 0; i < n; i++ {
		qty := rand.Intn(5) + 1
		price := round2(rand.Float64()*100 + 10)
		items[i] = OrderItem{
			ProductID: fmt.Sprintf("PROD-%d", 1000+i),
			Name:      fmt.Sprintf("Test Product %d", i+1),
			Quantity:  qty,
			Price:     price,
		}
		total += price * float64(qty)
	}
	return OrderMessage{
		OrderID:    orderID,
		CustomerID: customerID,
		Items:      items,
		Total:      round2(total),
		CreatedAt:  time.Now().UTC().Format(time.RFC3339),
	}
}

func round2(f float64) float64 {
	return float64(int64(f*100+0.5)) / 100
}

const letters = "abcdefghijklmnopqrstuvwxyz0123456789"

func randString(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))]
	}
	return string(b)
}

// EnvOr returns the env var value or a fallback.
func EnvOr(getenv func(string) string, key, fallback string) string {
	if v := getenv(key); v != "" {
		return v
	}
	return fallback
}
