// Command google-pubsub-tester is the integration test server for the Google
// Cloud Pub/Sub adapter. It publishes orders to a Pub/Sub topic and consumes
// them back from a subscription, exposing the standard tester HTTP endpoints.
// It targets the Pub/Sub emulator (see docker-compose.yml) by default.
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
	"github.com/sns45/anyq/go/pubsub"
)

func main() {
	port := tester.EnvOr(os.Getenv, "PORT", "3000")
	projectID := tester.EnvOr(os.Getenv, "PUBSUB_PROJECT_ID", "anyq-local")
	emulatorHost := tester.EnvOr(os.Getenv, "PUBSUB_EMULATOR_HOST", "localhost:8085")
	topicName := tester.EnvOr(os.Getenv, "PUBSUB_TOPIC", "orders")
	subName := tester.EnvOr(os.Getenv, "PUBSUB_SUBSCRIPTION", "orders-sub")

	autoCreate := true
	conn := pubsub.ConnectionConfig{
		ProjectID:    projectID,
		APIEndpoint:  emulatorHost,
		EmulatorMode: true,
	}

	producerCfg := pubsub.ProducerConfig{
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "pubsub-tester-producer"},
		Connection:      conn,
		Topic:           pubsub.TopicConfig{Name: topicName, AutoCreate: &autoCreate},
	}
	consumerCfg := pubsub.ConsumerConfig{
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "pubsub-tester-consumer"},
		Connection:      conn,
		Subscription:    pubsub.SubscriptionConfig{Name: subName, AutoCreate: &autoCreate},
		TopicName:       topicName,
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	producer := pubsub.NewProducer(producerCfg)
	consumer := pubsub.NewConsumer(consumerCfg)
	if err := producer.Connect(ctx); err != nil {
		log.Fatalf("producer connect: %v", err)
	}
	if err := consumer.Connect(ctx); err != nil {
		log.Fatalf("consumer connect: %v", err)
	}

	app := &tester.App{
		Service:           "anyq-tester-google-pubsub",
		Producer:          producer,
		ConsumerConnected: consumer.IsConnected,
		ExtraStats: func() map[string]any {
			return map[string]any{
				"pubsub": map[string]any{
					"projectId":    projectID,
					"topic":        topicName,
					"subscription": subName,
				},
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
		log.Printf("google-pubsub tester listening on http://localhost:%s", port)
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
