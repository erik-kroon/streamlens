package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

var demoScenarios = []string{"normal", "gap", "duplicate", "out_of_order", "stale", "malformed", "oversized", "burst"}

type demoEnvelope struct {
	Topic   string                 `json:"topic"`
	Type    string                 `json:"type"`
	Seq     int64                  `json:"seq"`
	TS      string                 `json:"ts"`
	Symbol  string                 `json:"symbol,omitempty"`
	Key     string                 `json:"key,omitempty"`
	Payload map[string]interface{} `json:"payload"`
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

	logger.Info("Wiretap demo stream listening", "address", "ws://"+address+"/stream")
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
		http.Error(w, "expected websocket upgrade", http.StatusBadRequest)
		return
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

	scenario := strings.TrimSpace(r.URL.Query().Get("scenario"))
	if scenario == "" {
		scenario = "normal"
	}

	switch scenario {
	case "burst":
		streamDemoBurst(ctx, conn)
	default:
		streamDemoScenario(ctx, conn, scenario)
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
		Topic:  "market." + scenario,
		Type:   "quote",
		Seq:    seq,
		TS:     at.Format(time.RFC3339Nano),
		Symbol: symbol,
		Payload: map[string]interface{}{
			"bid":      180 + float64(seq%100)/100,
			"ask":      180.05 + float64(seq%100)/100,
			"scenario": scenario,
		},
	}

	data, err := json.Marshal(envelope)
	if err != nil {
		return []byte(fmt.Sprintf(`{"topic":"market.%s","type":"quote","seq":%d,"payload":{}}`, scenario, seq))
	}
	return data
}
