package main

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

const (
	defaultAddress = "127.0.0.1:8790"
	websocketGUID  = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
)

type agent struct {
	id          string
	version     string
	startedAt   time.Time
	liveClients atomic.Int64
}

type agentStatus struct {
	AgentID     string            `json:"agentId"`
	Version     string            `json:"version"`
	State       string            `json:"state"`
	StartedAt   string            `json:"startedAt"`
	UptimeMs    int64             `json:"uptimeMs"`
	LiveClients int64             `json:"liveClients"`
	Endpoints   map[string]string `json:"endpoints"`
}

type captureStats struct {
	Connections int64 `json:"connections"`
	Events      int64 `json:"events"`
	Issues      int64 `json:"issues"`
	LiveClients int64 `json:"liveClients"`
	UptimeMs    int64 `json:"uptimeMs"`
}

type agentMessage struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload"`
}

func main() {
	address := flag.String("addr", defaultAddress, "HTTP listen address")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	agent := &agent{
		id:        "wiretap-local-agent",
		version:   "0.1.0",
		startedAt: time.Now().UTC(),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", agent.withCORS(agent.handleHealth))
	mux.HandleFunc("/stats", agent.withCORS(agent.handleStats))
	mux.HandleFunc("/live", agent.handleLive)

	server := &http.Server{
		Addr:              *address,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	logger.Info("Wiretap agent listening", "address", "http://"+*address)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("agent stopped", "error", err)
		os.Exit(1)
	}
}

func (a *agent) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w)
		return
	}

	writeJSON(w, http.StatusOK, a.status())
}

func (a *agent) handleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w)
		return
	}

	writeJSON(w, http.StatusOK, captureStats{
		Connections: 0,
		Events:      0,
		Issues:      0,
		LiveClients: a.liveClients.Load(),
		UptimeMs:    a.uptimeMs(),
	})
}

func (a *agent) handleLive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w)
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

	if err := writeUpgradeResponse(rw, key); err != nil {
		return
	}

	a.liveClients.Add(1)
	defer a.liveClients.Add(-1)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go drainWebSocket(conn, cancel)

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	if err := a.writeStatusFrame(conn); err != nil {
		return
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := a.writeStatusFrame(conn); err != nil {
				return
			}
		}
	}
}

func (a *agent) withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next(w, r)
	}
}

func (a *agent) status() agentStatus {
	return agentStatus{
		AgentID:     a.id,
		Version:     a.version,
		State:       "ready",
		StartedAt:   a.startedAt.Format(time.RFC3339Nano),
		UptimeMs:    a.uptimeMs(),
		LiveClients: a.liveClients.Load(),
		Endpoints: map[string]string{
			"health": "http://localhost:8790/health",
			"stats":  "http://localhost:8790/stats",
			"live":   "ws://localhost:8790/live",
		},
	}
}

func (a *agent) uptimeMs() int64 {
	return time.Since(a.startedAt).Milliseconds()
}

func (a *agent) writeStatusFrame(conn net.Conn) error {
	data, err := json.Marshal(agentMessage{
		Type:    "agent.ready",
		Payload: a.status(),
	})
	if err != nil {
		return err
	}

	return writeWebSocketText(conn, data)
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}

func writeUpgradeResponse(rw *bufio.ReadWriter, key string) error {
	accept := websocketAccept(key)
	_, err := fmt.Fprintf(
		rw,
		"HTTP/1.1 101 Switching Protocols\r\n"+
			"Upgrade: websocket\r\n"+
			"Connection: Upgrade\r\n"+
			"Sec-WebSocket-Accept: %s\r\n\r\n",
		accept,
	)
	if err != nil {
		return err
	}

	return rw.Flush()
}

func websocketAccept(key string) string {
	sum := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func writeWebSocketText(conn net.Conn, payload []byte) error {
	header := make([]byte, 10)
	header[0] = 0x81

	length := len(payload)
	switch {
	case length < 126:
		header[1] = byte(length)
		_, err := conn.Write(append(header[:2], payload...))
		return err
	case length <= 65535:
		header[1] = 126
		binary.BigEndian.PutUint16(header[2:4], uint16(length))
		_, err := conn.Write(append(header[:4], payload...))
		return err
	default:
		header[1] = 127
		binary.BigEndian.PutUint64(header[2:10], uint64(length))
		_, err := conn.Write(append(header, payload...))
		return err
	}
}

func drainWebSocket(conn net.Conn, cancel context.CancelFunc) {
	defer cancel()

	buffer := make([]byte, 512)
	for {
		if _, err := conn.Read(buffer); err != nil {
			return
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Error("failed to write json response", "error", err)
	}
}

func writeMethodNotAllowed(w http.ResponseWriter) {
	w.Header().Set("Allow", "GET, OPTIONS")
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}
