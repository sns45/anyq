package core

import "encoding/json"

// Serializer converts typed values to/from bytes. The Message/Producer
// interfaces operate on []byte; serialization is an opt-in helper for handlers
// and adapters, mirroring the TypeScript ISerializer.
type Serializer interface {
	Format() string
	Serialize(value any) ([]byte, error)
	Deserialize(data []byte, out any) error
}

// JSONSerializer is the default JSON serializer.
type JSONSerializer struct {
	Pretty bool
}

// NewJSONSerializer builds a JSON serializer.
func NewJSONSerializer() *JSONSerializer { return &JSONSerializer{} }

func (s *JSONSerializer) Format() string { return "json" }

func (s *JSONSerializer) Serialize(value any) ([]byte, error) {
	var (
		b   []byte
		err error
	)
	if s.Pretty {
		b, err = json.MarshalIndent(value, "", "  ")
	} else {
		b, err = json.Marshal(value)
	}
	if err != nil {
		return nil, NewSerializationError("failed to serialize value to JSON", err)
	}
	return b, nil
}

func (s *JSONSerializer) Deserialize(data []byte, out any) error {
	if err := json.Unmarshal(data, out); err != nil {
		return NewSerializationError("failed to deserialize JSON", err)
	}
	return nil
}

// MarshalJSON is a convenience wrapper returning bytes for a value.
func MarshalJSON(value any) ([]byte, error) {
	return (&JSONSerializer{}).Serialize(value)
}

// UnmarshalJSON is a generic convenience wrapper decoding bytes into T.
func UnmarshalJSON[T any](data []byte) (T, error) {
	var out T
	err := (&JSONSerializer{}).Deserialize(data, &out)
	return out, err
}
