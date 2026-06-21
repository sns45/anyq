// Command redis-streams-tester is the integration test server for the Redis
// Streams adapter. It publishes orders to a stream and consumes them back via a
// consumer group, exposing the standard tester HTTP endpoints. Requires Redis
// (see docker-compose.yml).
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/sns45/anyq/go/apps/testers/internal/tester"
	"github.com/sns45/anyq/go/core"
	"github.com/sns45/anyq/go/redis"
)

func main() {
	port := tester.EnvOr(os.Getenv, "PORT", "3001")
	redisAddr := tester.EnvOr(os.Getenv, "REDIS_ADDR", "")
	redisHost := tester.EnvOr(os.Getenv, "REDIS_HOST", "localhost")
	redisPort := tester.EnvOr(os.Getenv, "REDIS_PORT", "6379")
	streamName := tester.EnvOr(os.Getenv, "STREAM_NAME", "orders")
	groupName := tester.EnvOr(os.Getenv, "CONSUMER_GROUP", "order-processors")

	// REDIS_ADDR (host:port) takes precedence; otherwise compose REDIS_HOST/PORT.
	host := redisHost
	portNum := 6379
	if redisAddr != "" {
		h, p := splitHostPort(redisAddr)
		host = h
		portNum = p
	} else if n, err := strconv.Atoi(redisPort); err == nil {
		portNum = n
	}

	cfg := redis.Config{
		BaseQueueConfig: core.BaseQueueConfig{
			ClientID: "redis-streams-tester",
		},
		Redis: redis.RedisConnectionConfig{
			Host: host,
			Port: portNum,
		},
		StreamName: streamName,
		ConsumerGroup: redis.ConsumerGroupConfig{
			GroupName:    groupName,
			ConsumerName: "consumer-1",
			StartID:      "0",
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	producer := redis.NewProducer(cfg)
	consumer := redis.NewConsumer(cfg)
	if err := producer.Connect(ctx); err != nil {
		log.Fatalf("producer connect: %v", err)
	}
	if err := consumer.Connect(ctx); err != nil {
		log.Fatalf("consumer connect: %v", err)
	}

	app := &tester.App{
		Service:           "anyq-tester-redis-streams",
		Producer:          producer,
		ConsumerConnected: consumer.IsConnected,
		ExtraStats: func() map[string]any {
			return map[string]any{
				"stream": map[string]any{"name": streamName, "group": groupName},
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
		log.Printf("redis-streams tester listening on http://localhost:%s", port)
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

// splitHostPort splits "host:port" returning the host and numeric port (6379 on
// parse failure).
func splitHostPort(addr string) (string, int) {
	host := addr
	port := 6379
	for i := len(addr) - 1; i >= 0; i-- {
		if addr[i] == ':' {
			host = addr[:i]
			if n, err := strconv.Atoi(addr[i+1:]); err == nil {
				port = n
			}
			break
		}
	}
	return host, port
}
