// Command azure-servicebus-tester is the integration test server for the Azure
// Service Bus adapter. It publishes orders to a queue and consumes them back,
// exposing the standard tester HTTP endpoints.
//
// It targets the Azure Service Bus emulator (see docker-compose.yml). Configure
// via AZURE_SERVICEBUS_CONNECTION_STRING and AZURE_SERVICEBUS_QUEUE.
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
	"github.com/sns45/anyq/go/azureservicebus"
	"github.com/sns45/anyq/go/core"
)

// emulatorConnectionString is the default Azure Service Bus emulator connection
// string (matches the TS tester and docker-compose emulator).
const emulatorConnectionString = "Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true"

func main() {
	port := tester.EnvOr(os.Getenv, "PORT", "3000")
	queueName := tester.EnvOr(os.Getenv, "AZURE_SERVICEBUS_QUEUE", "orders")
	connStr := tester.EnvOr(os.Getenv, "AZURE_SERVICEBUS_CONNECTION_STRING", emulatorConnectionString)

	cfg := azureservicebus.Config{
		BaseQueueConfig: core.BaseQueueConfig{ClientID: "azure-servicebus-tester"},
		Connection:      azureservicebus.ConnectionConfig{ConnectionString: connStr},
		Queue:           &azureservicebus.QueueConfig{Name: queueName},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	producer := azureservicebus.NewProducer(cfg)
	consumer := azureservicebus.NewConsumer(cfg)
	if err := producer.Connect(ctx); err != nil {
		log.Fatalf("producer connect: %v", err)
	}
	if err := consumer.Connect(ctx); err != nil {
		log.Fatalf("consumer connect: %v", err)
	}

	app := &tester.App{
		Service:           "anyq-tester-azure-servicebus",
		Producer:          producer,
		ConsumerConnected: consumer.IsConnected,
		ExtraStats: func() map[string]any {
			return map[string]any{"queue": queueName}
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
		log.Printf("azure service bus tester listening on http://localhost:%s", port)
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
