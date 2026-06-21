package core

import (
	"fmt"
	"log"
	"strings"
)

// Logger is the logging interface adapters use. Supply a custom implementation
// via LogConfig.Logger, or rely on the default leveled logger.
type Logger interface {
	Debug(message string, meta map[string]any)
	Info(message string, meta map[string]any)
	Warn(message string, meta map[string]any)
	Error(message string, meta map[string]any)
}

// defaultLogger is a minimal leveled logger writing to the standard logger.
type defaultLogger struct {
	enabled bool
	level   int
	prefix  string
}

var levelRank = map[LogLevel]int{LogDebug: 0, LogInfo: 1, LogWarn: 2, LogError: 3}

// NewLogger builds a Logger from LogConfig. If cfg supplies a custom Logger it
// is returned directly; otherwise a leveled standard-library logger is used.
func NewLogger(cfg *LogConfig, prefix string) Logger {
	resolved := DefaultLogConfig
	if cfg != nil {
		if cfg.Logger != nil {
			return cfg.Logger
		}
		resolved.Enabled = cfg.Enabled
		if cfg.Level != "" {
			resolved.Level = cfg.Level
		}
	}
	return &defaultLogger{
		enabled: resolved.Enabled,
		level:   levelRank[resolved.Level],
		prefix:  prefix,
	}
}

func (l *defaultLogger) emit(rank int, level, message string, meta map[string]any) {
	if !l.enabled || rank < l.level {
		return
	}
	var b strings.Builder
	b.WriteString("[")
	b.WriteString(level)
	b.WriteString("] ")
	if l.prefix != "" {
		b.WriteString(l.prefix)
		b.WriteString(": ")
	}
	b.WriteString(message)
	for k, v := range meta {
		b.WriteString(" ")
		b.WriteString(k)
		b.WriteString("=")
		_, _ = b.WriteString(stringify(v))
	}
	log.Println(b.String())
}

func (l *defaultLogger) Debug(m string, meta map[string]any) { l.emit(0, "DEBUG", m, meta) }
func (l *defaultLogger) Info(m string, meta map[string]any)  { l.emit(1, "INFO", m, meta) }
func (l *defaultLogger) Warn(m string, meta map[string]any)  { l.emit(2, "WARN", m, meta) }
func (l *defaultLogger) Error(m string, meta map[string]any) { l.emit(3, "ERROR", m, meta) }

func stringify(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case error:
		return t.Error()
	default:
		return strings.TrimSpace(fmt.Sprint(v))
	}
}
