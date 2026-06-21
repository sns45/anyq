package redis

import (
	"crypto/tls"

	goredis "github.com/redis/go-redis/v9"
)

// newClient builds a *redis.Client from the connection config, mirroring the TS
// adapter's ioredis construction (URL overrides discrete options).
func newClient(cfg RedisConnectionConfig) (*goredis.Client, error) {
	if cfg.URL != "" {
		opts, err := goredis.ParseURL(cfg.URL)
		if err != nil {
			return nil, err
		}
		if cfg.ConnectionName != "" {
			opts.ClientName = cfg.ConnectionName
		}
		return goredis.NewClient(opts), nil
	}

	opts := &goredis.Options{
		Addr:       joinHostPort(cfg.Host, cfg.Port),
		Password:   cfg.Password,
		Username:   cfg.Username,
		DB:         cfg.DB,
		ClientName: cfg.ConnectionName,
	}
	if cfg.TLS {
		opts.TLSConfig = &tls.Config{}
	}
	return goredis.NewClient(opts), nil
}

func joinHostPort(host string, port int) string {
	if host == "" {
		host = defaultHost
	}
	if port == 0 {
		port = defaultPort
	}
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
