package core

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// GenerateMessageID returns a unique, sortable-ish message id of the form
// "msg-<unixmillis>-<random>". Mirrors the TypeScript id generator's intent.
func GenerateMessageID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failure is non-recoverable in practice; fall back to time.
		return fmt.Sprintf("msg-%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("msg-%d-%s", time.Now().UnixMilli(), hex.EncodeToString(b[:]))
}
