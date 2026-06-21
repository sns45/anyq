// Command rabbitmq-tester is the integration test server for the RabbitMQ
// adapter. It publishes orders to an exchange and consumes them back from a
// bound queue, exposing the standard tester HTTP endpoints. A running RabbitMQ
// broker is required (see docker-compose.yml).
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
	"github.com/sns45/anyq/go/rabbitmq"
)

func main() {
	port := tester.EnvOr(os.Getenv, "PORT", "3000")
	rabbitURL := tester.EnvOr(os.Getenv, "RABBITMQ_URL", "amqp://guest:guest@localhost:5672/")
	exchange := tester.EnvOr(os.Getenv, "RABBITMQ_EXCHANGE", "orders-exchange")
	queueName := tester.EnvOr(os.Getenv, "RABBITMQ_QUEUE", "orders")
	routingKey := tester.EnvOr(os.Getenv, "RABBITMQ_ROUTING_KEY", "orders")

	conn := rabbitmq.ConnectionConfig{URL: rabbitURL}
	exchangeCfg := rabbitmq.ExchangeConfig{Name: exchange, Type: "direct", Durable: true}

	producer := rabbitmq.NewProducer(rabbitmq.ProducerConfig{
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "rabbitmq-tester-producer"},
		Connection:      conn,
		Exchange:        exchangeCfg,
		RoutingKey:      routingKey,
		ConfirmMode:     true,
		Persistent:      true,
	})

	consumer := rabbitmq.NewConsumer(rabbitmq.ConsumerConfig{
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "rabbitmq-tester-consumer"},
		Connection:      conn,
		Queue:           rabbitmq.QueueConfig{Name: queueName, Durable: true},
		Exchange:        &exchangeCfg,
		BindingKey:      routingKey,
		Consumer:        rabbitmq.ConsumerOptions{Prefetch: 10},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := producer.Connect(ctx); err != nil {
		log.Fatalf("producer connect: %v", err)
	}
	if err := consumer.Connect(ctx); err != nil {
		log.Fatalf("consumer connect: %v", err)
	}

	app := &tester.App{
		Service:           "anyq-tester-rabbitmq",
		Producer:          producer,
		ConsumerConnected: consumer.IsConnected,
		ExtraStats: func() map[string]any {
			return map[string]any{
				"rabbitmq": map[string]any{"exchange": exchange, "queue": queueName},
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
		log.Printf("rabbitmq tester listening on http://localhost:%s", port)
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
