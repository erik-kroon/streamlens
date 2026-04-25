package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

const (
	burstEventsPerSecond = 1000
	burstDuration        = 10 * time.Second
	burstBatchInterval   = 10 * time.Millisecond
)

var demoScenarios = []string{"normal", "gap", "duplicate", "out_of_order", "stale", "malformed", "oversized", "burst", "fuzz"}

type demoEnvelope struct {
	Topic       string                 `json:"topic"`
	Type        string                 `json:"type"`
	Seq         int64                  `json:"seq"`
	TS          string                 `json:"ts"`
	Symbol      string                 `json:"symbol,omitempty"`
	Key         string                 `json:"key,omitempty"`
	Traceparent string                 `json:"traceparent,omitempty"`
	Resource    map[string]interface{} `json:"resource,omitempty"`
	Payload     map[string]interface{} `json:"payload"`
}

func runDemoStreamServer(address string, logger *slog.Logger) {
	mux := http.NewServeMux()
	mux.HandleFunc("/stream", handleDemoStream)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"ok":        true,
			"scenarios": demoScenarios,
		})
	})

	server := &http.Server{
		Addr:              address,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	logger.Info("StreamLens demo stream listening", "websocket", "ws://"+address+"/stream", "sse", "http://"+address+"/stream")
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("demo stream stopped", "error", err)
	}
}

func handleDemoStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	if !isWebSocketUpgrade(r) {
		handleDemoSSE(w, r)
		return
	}

	scenario := strings.TrimSpace(r.URL.Query().Get("scenario"))
	if scenario == "" {
		scenario = "normal"
	}
	var fuzzConfig fuzzConfig
	if scenario == "fuzz" {
		var err error
		fuzzConfig, err = demoFuzzConfig(r, transportWebSocket)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "websocket hijacking unsupported", http.StatusInternalServerError)
		return
	}

	conn, rw, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, "websocket hijack failed", http.StatusInternalServerError)
		return
	}
	defer conn.Close()

	if err := writeUpgradeResponse(rw, key, ""); err != nil {
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go drainWebSocket(conn, cancel)

	switch scenario {
	case "burst":
		streamDemoBurst(ctx, conn)
	case "fuzz":
		streamDemoFuzz(ctx, conn, fuzzConfig)
	default:
		streamDemoScenario(ctx, conn, scenario)
	}
}

func handleDemoSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	scenario := strings.TrimSpace(r.URL.Query().Get("scenario"))
	if scenario == "" {
		scenario = "normal"
	}
	var fuzzConfig fuzzConfig
	if scenario == "fuzz" {
		var err error
		fuzzConfig, err = demoFuzzConfig(r, transportSSE)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	switch scenario {
	case "burst":
		streamDemoSSEBurst(r.Context(), w, flusher)
	case "fuzz":
		streamDemoSSEFuzz(r.Context(), w, flusher, fuzzConfig)
	default:
		streamDemoSSEScenario(r.Context(), w, flusher, scenario)
	}
}

func streamDemoBurst(ctx context.Context, conn interface{ Write([]byte) (int, error) }) {
	ticker := time.NewTicker(burstBatchInterval)
	defer ticker.Stop()

	startedAt := time.Now().UTC()
	seq := int64(1)
	perBatch := burstEventsPerSecond / int(time.Second/burstBatchInterval)
	totalEvents := burstEventsPerSecond * int(burstDuration/time.Second)

	for sent := 0; sent < totalEvents; {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			for i := 0; i < perBatch && sent < totalEvents; i++ {
				payload := demoEventPayload("burst", seq, now.UTC())
				if err := writeWebSocketText(conn, payload); err != nil {
					return
				}
				seq++
				sent++
			}
			if time.Since(startedAt) >= burstDuration && sent >= totalEvents {
				return
			}
		}
	}
}

func streamDemoSSEBurst(ctx context.Context, writer io.Writer, flusher http.Flusher) {
	ticker := time.NewTicker(burstBatchInterval)
	defer ticker.Stop()

	startedAt := time.Now().UTC()
	seq := int64(1)
	perBatch := burstEventsPerSecond / int(time.Second/burstBatchInterval)
	totalEvents := burstEventsPerSecond * int(burstDuration/time.Second)

	for sent := 0; sent < totalEvents; {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			for i := 0; i < perBatch && sent < totalEvents; i++ {
				payload := demoEventPayload("burst", seq, now.UTC())
				if err := writeSSEData(writer, "message", fmt.Sprintf("burst-%d", seq), payload); err != nil {
					return
				}
				seq++
				sent++
			}
			flusher.Flush()
			if time.Since(startedAt) >= burstDuration && sent >= totalEvents {
				return
			}
		}
	}
}

func streamDemoFuzz(ctx context.Context, conn interface{ Write([]byte) (int, error) }, config fuzzConfig) {
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()

	for _, input := range generateProtocolFuzzInputs(config) {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := writeWebSocketMessage(conn, input.Opcode, input.Payload); err != nil {
				return
			}
		}
	}
}

func streamDemoSSEFuzz(ctx context.Context, writer io.Writer, flusher http.Flusher, config fuzzConfig) {
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()

	for index, input := range generateProtocolFuzzInputs(config) {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := writeSSEData(writer, "fuzz", fmt.Sprintf("%s-%d", input.Name, index+1), input.Payload); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func demoFuzzConfig(r *http.Request, transport string) (fuzzConfig, error) {
	values := r.URL.Query()
	values.Set("transport", transport)
	if values.Get("count") == "" {
		values.Set("count", "24")
	}
	return fuzzConfigFromQuery(values)
}

func streamDemoScenario(ctx context.Context, conn interface{ Write([]byte) (int, error) }, scenario string) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	frameIndex := int64(1)
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if scenario == "stale" && frameIndex == 6 {
				time.Sleep(1500 * time.Millisecond)
			}

			payload := demoScenarioPayload(scenario, frameIndex, now.UTC())
			if err := writeWebSocketText(conn, payload); err != nil {
				return
			}
			frameIndex++
		}
	}
}

func streamDemoSSEScenario(ctx context.Context, writer io.Writer, flusher http.Flusher, scenario string) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	frameIndex := int64(1)
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if scenario == "stale" && frameIndex == 6 {
				time.Sleep(1500 * time.Millisecond)
			}

			payload := demoScenarioPayload(scenario, frameIndex, now.UTC())
			if err := writeSSEData(writer, "message", fmt.Sprintf("%s-%d", scenario, frameIndex), payload); err != nil {
				return
			}
			flusher.Flush()
			frameIndex++
		}
	}
}

func writeSSEData(writer io.Writer, eventType string, id string, payload []byte) error {
	if eventType != "" {
		if _, err := fmt.Fprintf(writer, "event: %s\n", eventType); err != nil {
			return err
		}
	}
	if id != "" {
		if _, err := fmt.Fprintf(writer, "id: %s\n", id); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(writer, "data: %s\n\n", payload); err != nil {
		return err
	}
	return nil
}

func demoScenarioPayload(scenario string, frameIndex int64, at time.Time) []byte {
	switch scenario {
	case "malformed":
		return []byte(`{"topic":"market.demo","type":"quote"`)
	case "oversized":
		return demoOversizedPayload(frameIndex, at)
	case "gap":
		return demoEventPayload(scenario, demoScenarioSeq(scenario, frameIndex), at)
	case "duplicate":
		return demoEventPayload(scenario, demoScenarioSeq(scenario, frameIndex), at)
	case "out_of_order":
		return demoEventPayload(scenario, demoScenarioSeq(scenario, frameIndex), at)
	case "stale":
		return demoEventPayload(scenario, frameIndex, at)
	default:
		return demoEventPayload("normal", frameIndex, at)
	}
}

func demoScenarioSeq(scenario string, frameIndex int64) int64 {
	switch scenario {
	case "gap":
		if frameIndex >= 4 {
			return frameIndex + 2
		}
	case "duplicate":
		if frameIndex == 6 {
			return 5
		}
		if frameIndex > 6 {
			return frameIndex - 1
		}
	case "out_of_order":
		switch frameIndex {
		case 4:
			return 5
		case 5:
			return 4
		case 6:
			return 6
		}
	}
	return frameIndex
}

func demoOversizedPayload(seq int64, at time.Time) []byte {
	envelope := demoEnvelope{
		Topic:  "market.oversized",
		Type:   "quote",
		Seq:    seq,
		TS:     at.Format(time.RFC3339Nano),
		Symbol: "DEMO",
		Payload: map[string]interface{}{
			"blob":     strings.Repeat("x", maxRawMessageBytes+1),
			"scenario": "oversized",
		},
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		return []byte(`{"topic":"market.oversized","type":"quote","payload":{"blob":"` + strings.Repeat("x", maxRawMessageBytes+1) + `"}}`)
	}
	return data
}

func demoEventPayload(scenario string, seq int64, at time.Time) []byte {
	symbol := "DEMO"
	if scenario == "normal" {
		symbols := []string{"AAPL", "MSFT", "NVDA", "TSLA"}
		symbol = symbols[int(seq-1)%len(symbols)]
	} else if scenario == "burst" {
		symbol = "BURST"
	}
	envelope := demoEnvelope{
		Topic:       "market." + scenario,
		Type:        "quote",
		Seq:         seq,
		TS:          at.Format(time.RFC3339Nano),
		Symbol:      symbol,
		Traceparent: demoTraceparent(seq),
		Resource: map[string]interface{}{
			"service": map[string]interface{}{"name": "streamlens-demo"},
		},
		Payload: map[string]interface{}{
			"bid":      180 + float64(seq%100)/100,
			"ask":      180.05 + float64(seq%100)/100,
			"scenario": scenario,
			"logId":    fmt.Sprintf("demo-log-%d", seq),
		},
	}

	data, err := json.Marshal(envelope)
	if err != nil {
		return []byte(fmt.Sprintf(`{"topic":"market.%s","type":"quote","seq":%d,"payload":{}}`, scenario, seq))
	}
	return data
}

func demoTraceparent(seq int64) string {
	return fmt.Sprintf("00-%032x-%016x-01", seq, seq)
}
