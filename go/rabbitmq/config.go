// Package rabbitmq provides the RabbitMQ (AMQP 0-9-1) adapter for anyq, built on
// github.com/rabbitmq/amqp091-go. It mirrors the TypeScript @anyq/rabbitmq
// package: a producer that publishes to an exchange and a consumer that binds a
// queue and consumes deliveries, wired into the core retry-strategy machinery.
package rabbitmq

import (
	"net/url"
	"time"

	"github.com/sns45/anyq/go/core"
)

// Default configuration values, mirroring RABBITMQ_DEFAULTS in the TS config.
const (
	DefaultHeartbeat         = 60 * time.Second
	DefaultConnectionTimeout = 30 * time.Second
	DefaultPrefetch          = 10
	DefaultExchangeType      = "direct"
	DefaultConfirmTimeout    = 5 * time.Second
)

// ConnectionConfig configures the AMQP connection. URL takes precedence; when it
// is empty a URL is assembled from Host/Port/Username/Password/Vhost.
type ConnectionConfig struct {
	// URL is the full AMQP URL (e.g. "amqp://guest:guest@localhost:5672/").
	URL string
	// Host/Port/Username/Password/Vhost are used to build a URL when URL is empty.
	Host     string
	Port     int
	Username string
	Password string
	Vhost    string

	// Heartbeat is the heartbeat interval. Default: 60s.
	Heartbeat time.Duration
	// ConnectionTimeout is the dial timeout. Default: 30s.
	ConnectionTimeout time.Duration
	// ChannelMax and FrameMax are AMQP tuning parameters (0 = library default).
	ChannelMax int
	FrameMax   int
}

// ExchangeConfig configures an exchange to declare.
type ExchangeConfig struct {
	// Name is the exchange name.
	Name string
	// Type is one of: direct, topic, fanout, headers. Default: direct.
	Type string
	// Durable exchanges survive a broker restart. Default: true.
	Durable bool
	// AutoDelete deletes the exchange when no queues are bound.
	AutoDelete bool
	// Internal exchanges cannot be published to directly.
	Internal bool
	// Arguments are additional exchange arguments.
	Arguments map[string]any
}

// QueueConfig configures a queue to declare.
type QueueConfig struct {
	// Name is the queue name ("" for a server-generated name).
	Name string
	// Durable queues survive a broker restart. Default: true.
	Durable bool
	// Exclusive restricts the queue to this connection.
	Exclusive bool
	// AutoDelete deletes the queue when the last consumer disconnects.
	AutoDelete bool
	// DeadLetterExchange routes dead-lettered messages (x-dead-letter-exchange).
	DeadLetterExchange string
	// DeadLetterRoutingKey overrides the routing key for dead-lettered messages.
	DeadLetterRoutingKey string
	// MessageTTL is the per-queue message TTL in milliseconds (x-message-ttl).
	MessageTTL int
	// MaxLength caps the queue length (x-max-length).
	MaxLength int
	// MaxLengthBytes caps the queue size in bytes (x-max-length-bytes).
	MaxLengthBytes int
	// Arguments are additional queue arguments.
	Arguments map[string]any
}

// ConsumerOptions configures the basic.consume call.
type ConsumerOptions struct {
	// Prefetch is the QoS prefetch count. Default: 10.
	Prefetch int
	// ConsumerTag is the consumer tag ("" for a server-generated tag).
	ConsumerTag string
	// NoLocal asks the broker not to deliver messages published on this channel.
	NoLocal bool
	// NoAck enables auto-acknowledgement.
	NoAck bool
	// Exclusive requests exclusive consumer access to the queue.
	Exclusive bool
	// Priority sets the consumer priority (x-priority).
	Priority int
	// Arguments are additional consume arguments.
	Arguments map[string]any
}

// ProducerConfig configures a RabbitMQ producer.
type ProducerConfig struct {
	core.BaseQueueConfig

	// Connection configures the AMQP connection.
	Connection ConnectionConfig
	// Exchange is the exchange to declare and publish to.
	Exchange ExchangeConfig
	// RoutingKey is the default routing key when PublishOptions.Key is empty.
	RoutingKey string
	// ConfirmMode enables publisher confirms for reliable publishing. Default: true.
	ConfirmMode bool
	// ConfirmTimeout bounds waiting for publisher confirms. Default: 5s.
	ConfirmTimeout time.Duration
	// Mandatory returns unroutable messages instead of dropping them.
	Mandatory bool
	// Persistent marks messages persistent (delivery mode 2) by default. Default: true.
	Persistent bool
}

// ConsumerConfig configures a RabbitMQ consumer.
type ConsumerConfig struct {
	core.BaseQueueConfig

	// Connection configures the AMQP connection.
	Connection ConnectionConfig
	// Queue is the queue to declare and consume from.
	Queue QueueConfig
	// Exchange, when set, is declared and bound to the queue with BindingKey.
	Exchange *ExchangeConfig
	// BindingKey is the routing key/pattern used to bind the queue.
	BindingKey string
	// Consumer configures the consume call.
	Consumer ConsumerOptions
}

// dialURL builds the effective AMQP URL, appending an encoded vhost when needed.
func dialURL(c ConnectionConfig) string {
	base := c.URL
	if base == "" {
		host := c.Host
		if host == "" {
			host = "localhost"
		}
		port := c.Port
		if port == 0 {
			port = 5672
		}
		u := url.URL{Scheme: "amqp", Host: hostPort(host, port)}
		if c.Username != "" {
			if c.Password != "" {
				u.User = url.UserPassword(c.Username, c.Password)
			} else {
				u.User = url.User(c.Username)
			}
		}
		base = u.String()
	}
	if c.Vhost != "" {
		if base[len(base)-1] != '/' {
			base += "/"
		}
		base += url.PathEscape(c.Vhost)
	}
	return base
}

func hostPort(host string, port int) string {
	return host + ":" + itoa(port)
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

// applyProducerDefaults fills unset producer fields with RABBITMQ_DEFAULTS.
func (c *ProducerConfig) applyDefaults() {
	if c.Driver == "" {
		c.Driver = core.DriverRabbitMQ
	}
	applyConnectionDefaults(&c.Connection)
	if c.Exchange.Type == "" {
		c.Exchange.Type = DefaultExchangeType
	}
	if c.ConfirmTimeout == 0 {
		c.ConfirmTimeout = DefaultConfirmTimeout
	}
}

// applyConsumerDefaults fills unset consumer fields with RABBITMQ_DEFAULTS.
func (c *ConsumerConfig) applyDefaults() {
	if c.Driver == "" {
		c.Driver = core.DriverRabbitMQ
	}
	applyConnectionDefaults(&c.Connection)
	if c.Consumer.Prefetch == 0 {
		c.Consumer.Prefetch = DefaultPrefetch
	}
	if c.Exchange != nil && c.Exchange.Type == "" {
		c.Exchange.Type = DefaultExchangeType
	}
}

func applyConnectionDefaults(c *ConnectionConfig) {
	if c.Heartbeat == 0 {
		c.Heartbeat = DefaultHeartbeat
	}
	if c.ConnectionTimeout == 0 {
		c.ConnectionTimeout = DefaultConnectionTimeout
	}
}
