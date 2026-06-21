// Command nats-tester is the integration test server for the NATS JetStream
// adapter. It publishes orders to a JetStream stream and consumes them back,
// exposing the standard tester HTTP endpoints. Requires a running NATS server
// with JetStream enabled (see docker-compose.yml).
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/sns45/anyq/go/apps/testers/internal/tester"
	"github.com/sns45/anyq/go/core"
	anyqnats "github.com/sns45/anyq/go/nats"
)

func main() {
	port := tester.EnvOr(os.Getenv, "PORT", "3000")
	natsURL := tester.EnvOr(os.Getenv, "NATS_URL", "nats://localhost:4222")
	stream := tester.EnvOr(os.Getenv, "NATS_STREAM", "ORDERS")
	subject := tester.EnvOr(os.Getenv, "NATS_SUBJECT", "orders.created")
	durable := tester.EnvOr(os.Getenv, "NATS_DURABLE", "orders-consumer")

	cfg := anyqnats.Config{
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "nats-tester"},
		Connection:      anyqnats.ConnectionConfig{Servers: strings.Split(natsURL, ",")},
		JetStream:       anyqnats.JetStreamConfig{Stream: stream, Subjects: []string{subject}},
		Subject:         subject,
		Consumer:        anyqnats.ConsumerOptions{DurableName: durable},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	producer := anyqnats.NewProducer(cfg)
	consumer := anyqnats.NewConsumer(cfg)
	if err := producer.Connect(ctx); err != nil {
		log.Fatalf("producer connect: %v", err)
	}
	if err := consumer.Connect(ctx); err != nil {
		log.Fatalf("consumer connect: %v", err)
	}

	app := &tester.App{
		Service:           "anyq-tester-nats",
		Producer:          producer,
		ConsumerConnected: consumer.IsConnected,
		ExtraStats: func() map[string]any {
			return map[string]any{
				"nats": map[string]any{"stream": stream, "subject": subject},
			}
		},
	}

	go func() {
		err := consumer.Subscribe(ctx, func(_ context.Context, m core.Message) error {
			received := time.Now()
			log.Printf("received order %s", m.ID())
			app.RecordConsumed(m.ID(), m.Body(), received)
			return nil
		}, nil)
		if err != nil && ctx.Err() == nil {
			log.Printf("subscribe ended: %v", err)
		}
	}()

	srv := &http.Server{Addr: ":" + port, Handler: app.Handler()}
	go func() {
		log.Printf("nats tester listening on http://localhost:%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	log.Println("shutting down...")
	cancel()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	_ = srv.Shutdown(shutdownCtx)
	_ = consumer.Disconnect(context.Background())
	_ = producer.Disconnect(context.Background())
}
