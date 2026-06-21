// Command memory-tester is the integration test server for the memory adapter.
// It publishes orders to an in-memory queue and consumes them back, exposing the
// standard tester HTTP endpoints. No external broker is required.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/sns45/anyq/go/apps/testers/internal/tester"
	"github.com/sns45/anyq/go/core"
	"github.com/sns45/anyq/go/memory"
)

func main() {
	port := tester.EnvOr(os.Getenv, "PORT", "3000")
	queueName := tester.EnvOr(os.Getenv, "QUEUE_NAME", "orders")

	cfg := memory.Config{
		QueueName: queueName,
		BaseQueueConfig: core.BaseQueueConfig{
			ClientID: "memory-tester",
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	producer := memory.NewProducer(cfg)
	consumer := memory.NewConsumer(cfg)
	if err := producer.Connect(ctx); err != nil {
		log.Fatalf("producer connect: %v", err)
	}
	if err := consumer.Connect(ctx); err != nil {
		log.Fatalf("consumer connect: %v", err)
	}

	app := &tester.App{
		Service:           "anyq-tester-memory",
		Producer:          producer,
		ConsumerConnected: consumer.IsConnected,
		ExtraStats: func() map[string]any {
			q := consumer.Queue()
			if q == nil {
				return nil
			}
			return map[string]any{
				"queue": map[string]any{"size": q.Size(), "processing": q.ProcessingCount()},
			}
		},
	}

	go func() {
		err := consumer.Subscribe(ctx, func(_ context.Context, m core.Message) error {
			received := time.Now()
			log.Printf("📥 received order %s", m.ID())
			app.RecordConsumed(m.ID(), m.Body(), received)
			return nil
		}, nil)
		if err != nil && ctx.Err() == nil {
			log.Printf("subscribe ended: %v", err)
		}
	}()

	srv := &http.Server{Addr: ":" + port, Handler: app.Handler()}
	go func() {
		log.Printf("✅ memory tester listening on http://localhost:%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	log.Println("🛑 shutting down...")
	cancel()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	_ = srv.Shutdown(shutdownCtx)
	_ = consumer.Disconnect(context.Background())
	_ = producer.Disconnect(context.Background())
}
