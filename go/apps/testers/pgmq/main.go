// Command pgmq runs the standard anyq tester against Postgres.
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
	"github.com/sns45/anyq/go/pgmq"
)

func main() {
	port := tester.EnvOr(os.Getenv, "PORT", "3000")
	queue := tester.EnvOr(os.Getenv, "PGMQ_QUEUE_NAME", "orders")
	url := tester.EnvOr(os.Getenv, "PGMQ_URL", "postgres://postgres:postgres@localhost:5432/postgres")
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	cfg := pgmq.Config{
		ConnectionString: url, QueueName: queue,
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "pgmq-tester"},
	}
	producer, err := pgmq.NewProducer(cfg)
	if err != nil {
		log.Fatal(err)
	}
	consumer, err := pgmq.NewConsumer(cfg)
	if err != nil {
		log.Fatal(err)
	}
	if err := producer.Connect(ctx); err != nil {
		log.Fatalf("producer connect: %v", err)
	}
	defer producer.Disconnect(context.Background())
	if err := consumer.Connect(ctx); err != nil {
		log.Fatalf("consumer connect: %v", err)
	}
	defer consumer.Disconnect(context.Background())
	app := &tester.App{
		Service: "anyq-tester-pgmq", Producer: producer, ConsumerConnected: consumer.IsConnected,
		ExtraStats: func() map[string]any { return map[string]any{"pgmq": map[string]any{"queueName": queue}} },
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		err := consumer.Subscribe(ctx, func(_ context.Context, msg core.Message) error {
			app.RecordConsumed(msg.ID(), msg.Body(), time.Now())
			return nil
		}, nil)
		if err != nil && ctx.Err() == nil {
			log.Printf("subscribe ended: %v", err)
			cancel()
		}
	}()
	srv := &http.Server{Addr: ":" + port, Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		log.Printf("pgmq tester listening on http://localhost:%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("server: %v", err)
			cancel()
		}
	}()
	<-ctx.Done()
	shutdownCtx, stop := context.WithTimeout(context.Background(), 35*time.Second)
	defer stop()
	_ = srv.Shutdown(shutdownCtx)
	select {
	case <-done:
	case <-shutdownCtx.Done():
		log.Print("consumer shutdown timed out")
	}
}
