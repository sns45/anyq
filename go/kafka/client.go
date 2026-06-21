package kafka

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"strconv"
	"time"

	kafkago "github.com/segmentio/kafka-go"
	"github.com/segmentio/kafka-go/sasl"
	"github.com/segmentio/kafka-go/sasl/plain"
)

// tlsConfig builds a *tls.Config from the SSL config, or returns nil when TLS
// is disabled.
func tlsConfig(ssl *SSLConfig) (*tls.Config, error) {
	if ssl == nil || !ssl.Enabled {
		return nil, nil
	}
	cfg := &tls.Config{InsecureSkipVerify: ssl.InsecureSkipVerify}
	if len(ssl.CA) > 0 {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(ssl.CA) {
			return nil, fmt.Errorf("kafka: failed to parse CA certificate")
		}
		cfg.RootCAs = pool
	}
	if len(ssl.Cert) > 0 && len(ssl.Key) > 0 {
		cert, err := tls.X509KeyPair(ssl.Cert, ssl.Key)
		if err != nil {
			return nil, fmt.Errorf("kafka: failed to load client certificate: %w", err)
		}
		cfg.Certificates = []tls.Certificate{cert}
	}
	return cfg, nil
}

// saslMechanism builds a sasl.Mechanism from the SASL config, or returns nil
// when SASL is not configured.
func saslMechanism(s *SASLConfig) (sasl.Mechanism, error) {
	if s == nil {
		return nil, nil
	}
	switch s.Mechanism {
	case SASLPlain, "":
		return plain.Mechanism{Username: s.Username, Password: s.Password}, nil
	case SASLScramSHA256, SASLScramSHA512:
		// SCRAM requires the kafka-go/sasl/scram package, whose transitive
		// dependency (github.com/xdg-go/scram) is not present in this module's
		// go.sum. SCRAM is therefore not wired in this build; configure SASL
		// PLAIN (typically over TLS) instead.
		return nil, fmt.Errorf("kafka: SASL mechanism %q is not supported in this build (only \"plain\" is wired); SCRAM requires the xdg-go/scram dependency", s.Mechanism)
	default:
		return nil, fmt.Errorf("kafka: unsupported SASL mechanism %q", s.Mechanism)
	}
}

// dialer builds a *kafka.Dialer wired with SASL/TLS for the Reader and for
// admin operations.
func dialer(cfg *Config) (*kafkago.Dialer, error) {
	tlsCfg, err := tlsConfig(cfg.SSL)
	if err != nil {
		return nil, err
	}
	mech, err := saslMechanism(cfg.SASL)
	if err != nil {
		return nil, err
	}
	return &kafkago.Dialer{
		Timeout:       10 * time.Second,
		DualStack:     true,
		ClientID:      cfg.ClientID,
		TLS:           tlsCfg,
		SASLMechanism: mech,
	}, nil
}

// transport builds a *kafka.Transport wired with SASL/TLS for the Writer.
func transport(cfg *Config) (*kafkago.Transport, error) {
	tlsCfg, err := tlsConfig(cfg.SSL)
	if err != nil {
		return nil, err
	}
	mech, err := saslMechanism(cfg.SASL)
	if err != nil {
		return nil, err
	}
	return &kafkago.Transport{
		ClientID: cfg.ClientID,
		TLS:      tlsCfg,
		SASL:     mech,
	}, nil
}

// EnsureTopic creates the topic if it does not already exist. It connects to
// the cluster controller and issues a CreateTopics request, which is a no-op if
// the topic already exists. Useful for testers and first-run environments.
func EnsureTopic(ctx context.Context, cfg Config) error {
	cfg.applyDefaults()
	d, err := dialer(&cfg)
	if err != nil {
		return err
	}
	conn, err := d.DialContext(ctx, "tcp", cfg.Brokers[0])
	if err != nil {
		return fmt.Errorf("kafka: dial broker: %w", err)
	}
	defer conn.Close()

	controller, err := conn.Controller()
	if err != nil {
		return fmt.Errorf("kafka: get controller: %w", err)
	}
	ctrlAddr := controller.Host + ":" + strconv.Itoa(controller.Port)
	ctrlConn, err := d.DialContext(ctx, "tcp", ctrlAddr)
	if err != nil {
		return fmt.Errorf("kafka: dial controller: %w", err)
	}
	defer ctrlConn.Close()

	return ctrlConn.CreateTopics(kafkago.TopicConfig{
		Topic:             cfg.Topic,
		NumPartitions:     cfg.NumPartitions,
		ReplicationFactor: cfg.ReplicationFactor,
	})
}
