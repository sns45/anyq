// Command kafka-tester is the integration test server for the Kafka adapter.
// It publishes orders to a Kafka topic and consumes them back via a consumer
// group, exposing the standard tester HTTP endpoints.
//
// A running Kafka broker is required (see docker-compose.yml in this directory).
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
	"github.com/sns45/anyq/go/kafka"
)

func main() {
	port := tester.EnvOr(os.Getenv, "PORT", "3000")
	brokers := strings.Split(tester.EnvOr(os.Getenv, "KAFKA_BROKERS", "localhost:9092"), ",")
	topic := tester.EnvOr(os.Getenv, "KAFKA_TOPIC", "orders")
	groupID := tester.EnvOr(os.Getenv, "KAFKA_GROUP_ID", "anyq-kafka-tester")

	cfg := kafka.Config{
		Brokers: brokers,
		Topic:   topic,
		ConsumerGroup: &kafka.ConsumerGroupOptions{
			GroupID:       groupID,
			FromBeginning: true,
		},
		BaseQueueConfig: core.BaseQueueConfig{
			ClientID: "kafka-tester",
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	producer := kafka.NewProducer(cfg)
	consumer := kafka.NewConsumer(cfg)

	if err := producer.Connect(ctx); err != nil {
		log.Fatalf("producer connect: %v", err)
	}
	// Ensure the topic exists before consuming/producing.
	if err := kafka.EnsureTopic(ctx, cfg); err != nil {
		log.Printf("warning: ensure topic %q: %v (continuing; broker may auto-create)", topic, err)
	}
	if err := consumer.Connect(ctx); err != nil {
		log.Fatalf("consumer connect: %v", err)
	}

	app := &tester.App{
		Service:           "anyq-tester-kafka",
		Producer:          producer,
		ConsumerConnected: consumer.IsConnected,
		ExtraStats: func() map[string]any {
			return map[string]any{
				"kafka": map[string]any{"topic": topic, "groupId": groupID, "brokers": brokers},
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
		log.Printf("kafka tester listening on http://localhost:%s", port)
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
