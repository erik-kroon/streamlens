package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

const (
	defaultAddress       = "127.0.0.1:8790"
	websocketGUID        = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	maxBufferedEvents    = 10_000
	maxRawMessageBytes   = 1 << 20
	rawPreviewBytes      = 16 << 10
	reconnectDelay       = 1200 * time.Millisecond
	staleTickInterval    = 500 * time.Millisecond
	rateWindow           = time.Second
	writeDeadlineTimeout = 5 * time.Second
)

type agent struct {
	id          string
	version     string
	startedAt   time.Time
	liveClients atomic.Int64

	mu              sync.RWMutex
	state           agentState
	lastError       string
	activeConfig    *connectRequest
	connectedAt     *time.Time
	connectionCount int64
	eventCount      int64
	issueCount      int64
	nextCaptureSeq  int64
	connectionID    string
	events          []captureEvent
	topics          *topicTracker
	sequences       *sequenceTracker
	session         *upstreamSession
	subscribers     map[*liveClient]struct{}
}

type agentState string

const (
	stateReady        agentState = "ready"
	stateConnecting   agentState = "connecting"
	stateConnected    agentState = "connected"
	stateDisconnected agentState = "disconnected"
	stateReconnecting agentState = "reconnecting"
	stateError        agentState = "error"
)

type connectRequest struct {
	URL           string            `json:"url"`
	Headers       map[string]string `json:"headers"`
	BearerToken   string            `json:"bearerToken"`
	APIKeyHeader  string            `json:"apiKeyHeader"`
	APIKey        string            `json:"apiKey"`
	Subprotocols  []string          `json:"subprotocols"`
	AutoReconnect bool              `json:"autoReconnect"`
}

type upstreamSession struct {
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	config connectRequest
}

type agentStatus struct {
	AgentID     string            `json:"agentId"`
	Version     string            `json:"version"`
	State       agentState        `json:"state"`
	StartedAt   string            `json:"startedAt"`
	UptimeMs    int64             `json:"uptimeMs"`
	LiveClients int64             `json:"liveClients"`
	TargetURL   string            `json:"targetUrl,omitempty"`
	LastError   string            `json:"lastError,omitempty"`
	Endpoints   map[string]string `json:"endpoints"`
}

type captureStats struct {
	Connections int64      `json:"connections"`
	Events      int64      `json:"events"`
	Issues      int64      `json:"issues"`
	LiveClients int64      `json:"liveClients"`
	UptimeMs    int64      `json:"uptimeMs"`
	State       agentState `json:"state"`
	TargetURL   string     `json:"targetUrl,omitempty"`
	ConnectedAt string     `json:"connectedAt,omitempty"`
}

type agentMessage struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload"`
}

type liveClient struct {
	send chan []byte
}

type captureEvent struct {
	ID                string           `json:"id,omitempty"`
	ConnectionID      string           `json:"connectionId,omitempty"`
	CaptureSeq        int64            `json:"captureSeq"`
	ReceivedAt        string           `json:"receivedAt"`
	Direction         string           `json:"direction"`
	Opcode            string           `json:"opcode"`
	OriginalSizeBytes int64            `json:"originalSizeBytes"`
	SizeBytes         int64            `json:"sizeBytes"`
	Raw               string           `json:"raw,omitempty"`
	RawBase64         string           `json:"rawBase64,omitempty"`
	RawTruncated      bool             `json:"rawTruncated"`
	Truncated         bool             `json:"truncated"`
	Oversized         bool             `json:"oversized"`
	Topic             string           `json:"topic,omitempty"`
	DisplayTopic      string           `json:"displayTopic"`
	Type              string           `json:"eventType,omitempty"`
	DisplayType       string           `json:"displayType"`
	Key               string           `json:"key,omitempty"`
	EffectiveKey      string           `json:"effectiveKey,omitempty"`
	Seq               *int64           `json:"seq,omitempty"`
	SourceTS          interface{}      `json:"sourceTs,omitempty"`
	Envelope          *wiretapEnvelope `json:"envelope,omitempty"`
	ParseError        string           `json:"parseError,omitempty"`
	Statuses          []string         `json:"statuses"`
	Issues            []captureIssue   `json:"issues,omitempty"`
}

type wiretapEnvelope struct {
	Topic   string      `json:"topic"`
	Type    string      `json:"type"`
	Seq     *int64      `json:"seq,omitempty"`
	TS      interface{} `json:"ts,omitempty"`
	Key     string      `json:"key,omitempty"`
	Symbol  string      `json:"symbol,omitempty"`
	Payload interface{} `json:"payload,omitempty"`
}

type captureIssue struct {
	Code     string                 `json:"code"`
	Severity string                 `json:"severity"`
	Message  string                 `json:"message"`
	Topic    string                 `json:"topic,omitempty"`
	Key      string                 `json:"key,omitempty"`
	Details  map[string]interface{} `json:"details,omitempty"`
}

type upstreamConn struct {
	net.Conn
	reader *bufio.Reader
}

type upstreamFrame struct {
	opcode    byte
	payload   []byte
	sizeBytes int64
	oversized bool
}

func main() {
	address := flag.String("addr", defaultAddress, "HTTP listen address")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	agent := &agent{
		id:          "wiretap-local-agent",
		version:     "0.2.0",
		startedAt:   time.Now().UTC(),
		state:       stateReady,
		topics:      newTopicTracker(),
		sequences:   newSequenceTracker(),
		subscribers: make(map[*liveClient]struct{}),
	}
	go agent.runStaleEvaluator(context.Background())

	mux := http.NewServeMux()
	mux.HandleFunc("/health", agent.withCORS(agent.handleHealth))
	mux.HandleFunc("/stats", agent.withCORS(agent.handleStats))
	mux.HandleFunc("/events", agent.withCORS(agent.handleEvents))
	mux.HandleFunc("/topics", agent.withCORS(agent.handleTopics))
	mux.HandleFunc("/connect", agent.withCORS(agent.handleConnect))
	mux.HandleFunc("/disconnect", agent.withCORS(agent.handleDisconnect))
	mux.HandleFunc("/reconnect", agent.withCORS(agent.handleReconnect))
	mux.HandleFunc("/clear", agent.withCORS(agent.handleClear))
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
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}

	writeJSON(w, http.StatusOK, a.status())
}

func (a *agent) handleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}

	writeJSON(w, http.StatusOK, a.stats())
}

func (a *agent) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}

	writeJSON(w, http.StatusOK, a.eventSnapshot())
}

func (a *agent) handleTopics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}

	writeJSON(w, http.StatusOK, a.topicSnapshot())
}

func (a *agent) handleConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}

	var request connectRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeHTTPError(w, http.StatusBadRequest, "invalid connect payload")
		return
	}

	if err := request.validate(); err != nil {
		writeHTTPError(w, http.StatusBadRequest, err.Error())
		return
	}

	a.startConnection(request)
	writeJSON(w, http.StatusAccepted, a.status())
}

func (a *agent) handleDisconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}

	a.stopConnection(stateDisconnected, "")
	writeJSON(w, http.StatusOK, a.status())
}

func (a *agent) handleReconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}

	a.mu.RLock()
	config := a.activeConfig
	a.mu.RUnlock()
	if config == nil {
		writeHTTPError(w, http.StatusConflict, "no upstream connection has been configured")
		return
	}

	a.startConnection(*config)
	writeJSON(w, http.StatusAccepted, a.status())
}

func (a *agent) handleClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}

	a.mu.Lock()
	a.events = nil
	a.topics = newTopicTracker()
	a.eventCount = 0
	a.issueCount = 0
	a.nextCaptureSeq = 0
	a.sequences = newSequenceTracker()
	a.mu.Unlock()

	a.broadcast(agentMessage{Type: "capture.snapshot", Payload: []captureEvent{}})
	a.broadcast(agentMessage{Type: "topic.snapshot", Payload: []topicState{}})
	a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
	w.WriteHeader(http.StatusNoContent)
}

func (a *agent) handleLive(w http.ResponseWriter, r *http.Request) {
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

	client := &liveClient{send: make(chan []byte, 64)}
	a.addSubscriber(client)
	defer a.removeSubscriber(client)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go drainWebSocket(conn, cancel)

	a.sendToClient(client, agentMessage{Type: "agent.ready", Payload: a.status()})
	a.sendToClient(client, agentMessage{Type: "capture.stats", Payload: a.stats()})
	a.sendToClient(client, agentMessage{Type: "capture.snapshot", Payload: a.eventSnapshot()})
	a.sendToClient(client, agentMessage{Type: "topic.snapshot", Payload: a.topicSnapshot()})

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case payload := <-client.send:
			if err := conn.SetWriteDeadline(time.Now().Add(writeDeadlineTimeout)); err != nil {
				return
			}
			if err := writeWebSocketText(conn, payload); err != nil {
				return
			}
		case <-ticker.C:
			a.sendToClient(client, agentMessage{Type: "agent.ready", Payload: a.status()})
			a.sendToClient(client, agentMessage{Type: "capture.stats", Payload: a.stats()})
		}
	}
}

func (a *agent) withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next(w, r)
	}
}

func (a *agent) startConnection(config connectRequest) {
	previous := a.replaceSession(config)
	if previous != nil {
		previous.cancel()
		<-previous.done
	}

	a.broadcast(agentMessage{Type: "agent.ready", Payload: a.status()})
	a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
	go a.runUpstream(config)
}

func (a *agent) replaceSession(config connectRequest) *upstreamSession {
	ctx, cancel := context.WithCancel(context.Background())
	session := &upstreamSession{
		ctx:    ctx,
		cancel: cancel,
		done:   make(chan struct{}),
		config: config,
	}

	a.mu.Lock()
	previous := a.session
	a.session = session
	a.activeConfig = &session.config
	a.state = stateConnecting
	a.lastError = ""
	a.connectedAt = nil
	a.mu.Unlock()

	return previous
}

func (a *agent) runUpstream(config connectRequest) {
	a.mu.RLock()
	session := a.session
	a.mu.RUnlock()
	if session == nil {
		return
	}
	defer close(session.done)

	ctx := session.ctx

	firstAttempt := true
	for {
		if !firstAttempt {
			a.setConnectionState(stateReconnecting, "")
			select {
			case <-ctx.Done():
				a.setConnectionState(stateDisconnected, "")
				return
			case <-time.After(reconnectDelay):
			}
		}
		firstAttempt = false

		a.setConnectionState(stateConnecting, "")
		conn, err := dialUpstream(ctx, config)
		if err != nil {
			if ctx.Err() != nil {
				a.setConnectionState(stateDisconnected, "")
				return
			}
			a.setConnectionState(stateError, err.Error())
			if !config.AutoReconnect {
				return
			}
			continue
		}

		connectedAt := time.Now().UTC()
		a.mu.Lock()
		a.connectionCount++
		a.connectionID = fmt.Sprintf("conn-%d", a.connectionCount)
		a.connectedAt = &connectedAt
		a.state = stateConnected
		a.lastError = ""
		a.mu.Unlock()
		a.broadcast(agentMessage{Type: "agent.ready", Payload: a.status()})
		a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})

		err = a.captureFrames(ctx, conn)
		_ = conn.Close()
		if ctx.Err() != nil {
			a.setConnectionState(stateDisconnected, "")
			return
		}
		a.setConnectionState(stateError, err.Error())
		if !config.AutoReconnect {
			return
		}
	}
}

func (a *agent) captureFrames(ctx context.Context, conn *upstreamConn) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		frame, err := readServerFrame(conn)
		if err != nil {
			return err
		}

		switch frame.opcode {
		case 0x1, 0x2:
			event := normalizeCapture(frame)
			a.recordEvent(event)
		case 0x8:
			return errors.New("upstream closed websocket")
		case 0x9:
			if err := writeClientControlFrame(conn.Conn, 0xA, frame.payload); err != nil {
				return err
			}
		}
	}
}

func (a *agent) recordEvent(event captureEvent) {
	var topic topicState
	var hasTopic bool

	a.mu.Lock()
	a.ensureCaptureModulesLocked()
	a.nextCaptureSeq++
	event.CaptureSeq = a.nextCaptureSeq
	event.ConnectionID = a.connectionID
	if event.ConnectionID == "" {
		event.ConnectionID = "conn-0"
	}
	event.ID = fmt.Sprintf("%s:%d", event.ConnectionID, event.CaptureSeq)
	a.sequences.detect(&event)
	a.eventCount++
	a.issueCount += int64(len(event.Issues))
	a.events = append(a.events, event)
	if len(a.events) > maxBufferedEvents {
		copy(a.events, a.events[len(a.events)-maxBufferedEvents:])
		a.events = a.events[:maxBufferedEvents]
	}
	topic, hasTopic = a.topics.record(event)
	a.mu.Unlock()

	a.broadcast(agentMessage{Type: "capture.event", Payload: event})
	if hasTopic {
		a.broadcast(agentMessage{Type: "topic.updated", Payload: topic})
	}
	a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
}

func (a *agent) runStaleEvaluator(ctx context.Context) {
	ticker := time.NewTicker(staleTickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			a.evaluateStaleTopics(now.UTC())
		}
	}
}

func (a *agent) evaluateStaleTopics(now time.Time) []topicState {
	a.mu.Lock()
	a.ensureCaptureModulesLocked()
	result := a.topics.evaluateStale(now)
	a.issueCount += result.issueDelta
	a.mu.Unlock()

	for _, topic := range result.changed {
		a.broadcast(agentMessage{Type: "topic.updated", Payload: topic})
	}
	if len(result.changed) > 0 {
		a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
	}
	return result.changed
}

func (a *agent) stopConnection(state agentState, lastError string) {
	a.mu.Lock()
	session := a.session
	a.session = nil
	a.state = state
	a.lastError = lastError
	a.connectedAt = nil
	a.mu.Unlock()

	if session != nil {
		session.cancel()
		<-session.done
	}

	a.broadcast(agentMessage{Type: "agent.ready", Payload: a.status()})
	a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
}

func (a *agent) setConnectionState(state agentState, lastError string) {
	a.mu.Lock()
	a.state = state
	a.lastError = lastError
	if state != stateConnected {
		a.connectedAt = nil
	}
	a.mu.Unlock()

	a.broadcast(agentMessage{Type: "agent.ready", Payload: a.status()})
	a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
}

func (a *agent) status() agentStatus {
	a.mu.RLock()
	state := a.state
	lastError := a.lastError
	config := a.activeConfig
	a.mu.RUnlock()

	targetURL := ""
	if config != nil {
		targetURL = config.URL
	}

	return agentStatus{
		AgentID:     a.id,
		Version:     a.version,
		State:       state,
		StartedAt:   a.startedAt.Format(time.RFC3339Nano),
		UptimeMs:    a.uptimeMs(),
		LiveClients: a.liveClients.Load(),
		TargetURL:   targetURL,
		LastError:   lastError,
		Endpoints: map[string]string{
			"health":     "http://localhost:8790/health",
			"stats":      "http://localhost:8790/stats",
			"events":     "http://localhost:8790/events",
			"topics":     "http://localhost:8790/topics",
			"connect":    "http://localhost:8790/connect",
			"disconnect": "http://localhost:8790/disconnect",
			"reconnect":  "http://localhost:8790/reconnect",
			"clear":      "http://localhost:8790/clear",
			"live":       "ws://localhost:8790/live",
		},
	}
}

func (a *agent) stats() captureStats {
	a.mu.RLock()
	stats := captureStats{
		Connections: a.connectionCount,
		Events:      a.eventCount,
		Issues:      a.issueCount,
		LiveClients: a.liveClients.Load(),
		UptimeMs:    a.uptimeMs(),
		State:       a.state,
	}
	if a.activeConfig != nil {
		stats.TargetURL = a.activeConfig.URL
	}
	if a.connectedAt != nil {
		stats.ConnectedAt = a.connectedAt.Format(time.RFC3339Nano)
	}
	a.mu.RUnlock()
	return stats
}

func (a *agent) eventSnapshot() []captureEvent {
	a.mu.RLock()
	defer a.mu.RUnlock()

	events := make([]captureEvent, len(a.events))
	copy(events, a.events)
	return events
}

func (a *agent) topicSnapshot() []topicState {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.ensureCaptureModulesLocked()
	return a.topics.snapshot(time.Now().UTC())
}

func (a *agent) uptimeMs() int64 {
	return time.Since(a.startedAt).Milliseconds()
}

func (a *agent) ensureCaptureModulesLocked() {
	if a.topics == nil {
		a.topics = newTopicTracker()
	}
	if a.sequences == nil {
		a.sequences = newSequenceTracker()
	}
}

func (a *agent) addSubscriber(client *liveClient) {
	a.liveClients.Add(1)
	a.mu.Lock()
	a.subscribers[client] = struct{}{}
	a.mu.Unlock()
}

func (a *agent) removeSubscriber(client *liveClient) {
	a.liveClients.Add(-1)
	a.mu.Lock()
	delete(a.subscribers, client)
	close(client.send)
	a.mu.Unlock()
}

func (a *agent) sendToClient(client *liveClient, message agentMessage) {
	data, err := json.Marshal(message)
	if err != nil {
		slog.Error("failed to marshal live message", "error", err)
		return
	}

	select {
	case client.send <- data:
	default:
	}
}

func (a *agent) broadcast(message agentMessage) {
	data, err := json.Marshal(message)
	if err != nil {
		slog.Error("failed to marshal live message", "error", err)
		return
	}

	a.mu.RLock()
	defer a.mu.RUnlock()
	for client := range a.subscribers {
		select {
		case client.send <- data:
		default:
		}
	}
}

func (request *connectRequest) validate() error {
	request.URL = strings.TrimSpace(request.URL)
	if request.URL == "" {
		return errors.New("url is required")
	}

	parsed, err := url.Parse(request.URL)
	if err != nil {
		return fmt.Errorf("invalid websocket url: %w", err)
	}

	if parsed.Scheme != "ws" && parsed.Scheme != "wss" {
		return errors.New("url must use ws:// or wss://")
	}
	if parsed.Host == "" {
		return errors.New("url must include a host")
	}

	request.APIKeyHeader = strings.TrimSpace(request.APIKeyHeader)
	cleanHeaders := make(map[string]string)
	for key, value := range request.Headers {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		cleanHeaders[key] = strings.TrimSpace(value)
	}
	request.Headers = cleanHeaders

	subprotocols := request.Subprotocols[:0]
	for _, protocol := range request.Subprotocols {
		protocol = strings.TrimSpace(protocol)
		if protocol != "" {
			subprotocols = append(subprotocols, protocol)
		}
	}
	request.Subprotocols = subprotocols
	return nil
}

func dialUpstream(ctx context.Context, config connectRequest) (*upstreamConn, error) {
	parsed, err := url.Parse(config.URL)
	if err != nil {
		return nil, err
	}

	dialer := net.Dialer{Timeout: 10 * time.Second}
	var conn net.Conn
	if parsed.Scheme == "wss" {
		tlsDialer := tls.Dialer{
			NetDialer: &dialer,
			Config:    &tls.Config{ServerName: parsed.Hostname(), MinVersion: tls.VersionTLS12},
		}
		conn, err = tlsDialer.DialContext(ctx, "tcp", addressWithDefaultPort(parsed, "443"))
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addressWithDefaultPort(parsed, "80"))
	}
	if err != nil {
		return nil, err
	}

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		_ = conn.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)

	header := http.Header{}
	header.Set("Host", parsed.Host)
	header.Set("Upgrade", "websocket")
	header.Set("Connection", "Upgrade")
	header.Set("Sec-WebSocket-Version", "13")
	header.Set("Sec-WebSocket-Key", key)
	if len(config.Subprotocols) > 0 {
		header.Set("Sec-WebSocket-Protocol", strings.Join(config.Subprotocols, ", "))
	}
	for name, value := range config.Headers {
		header.Set(name, value)
	}
	if strings.TrimSpace(config.BearerToken) != "" {
		header.Set("Authorization", "Bearer "+strings.TrimSpace(config.BearerToken))
	}
	if config.APIKeyHeader != "" && strings.TrimSpace(config.APIKey) != "" {
		header.Set(config.APIKeyHeader, strings.TrimSpace(config.APIKey))
	}

	requestURI := parsed.RequestURI()
	if requestURI == "" {
		requestURI = "/"
	}

	request := &http.Request{
		Method:     http.MethodGet,
		URL:        &url.URL{Scheme: parsed.Scheme, Host: parsed.Host, Path: parsed.Path, RawQuery: parsed.RawQuery},
		Host:       parsed.Host,
		Proto:      "HTTP/1.1",
		ProtoMajor: 1,
		ProtoMinor: 1,
		Header:     header,
		RequestURI: requestURI,
	}

	if err := request.Write(conn); err != nil {
		_ = conn.Close()
		return nil, err
	}

	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, request)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusSwitchingProtocols {
		_ = conn.Close()
		return nil, fmt.Errorf("websocket upgrade returned %s", response.Status)
	}

	expectedAccept := websocketAccept(key)
	if response.Header.Get("Sec-WebSocket-Accept") != expectedAccept {
		_ = conn.Close()
		return nil, errors.New("websocket upgrade returned an invalid accept key")
	}

	return &upstreamConn{Conn: conn, reader: reader}, nil
}

func addressWithDefaultPort(parsed *url.URL, fallbackPort string) string {
	if parsed.Port() != "" {
		return parsed.Host
	}
	return net.JoinHostPort(parsed.Hostname(), fallbackPort)
}

func readServerFrame(conn *upstreamConn) (upstreamFrame, error) {
	var header [2]byte
	if _, err := io.ReadFull(conn.reader, header[:]); err != nil {
		return upstreamFrame{}, err
	}

	opcode := header[0] & 0x0F
	masked := header[1]&0x80 != 0
	length := int64(header[1] & 0x7F)

	switch length {
	case 126:
		var extended [2]byte
		if _, err := io.ReadFull(conn.reader, extended[:]); err != nil {
			return upstreamFrame{}, err
		}
		length = int64(binary.BigEndian.Uint16(extended[:]))
	case 127:
		var extended [8]byte
		if _, err := io.ReadFull(conn.reader, extended[:]); err != nil {
			return upstreamFrame{}, err
		}
		value := binary.BigEndian.Uint64(extended[:])
		if value > math.MaxInt64 {
			return upstreamFrame{}, errors.New("websocket frame length exceeds int64")
		}
		length = int64(value)
	}

	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(conn.reader, maskKey[:]); err != nil {
			return upstreamFrame{}, err
		}
	}

	oversized := length > maxRawMessageBytes
	readLength := length
	if oversized && readLength > rawPreviewBytes {
		readLength = rawPreviewBytes
	}
	if readLength > math.MaxInt32 {
		return upstreamFrame{}, errors.New("websocket frame preview is too large")
	}

	payload := make([]byte, readLength)
	if _, err := io.ReadFull(conn.reader, payload); err != nil {
		return upstreamFrame{}, err
	}

	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}

	remaining := length - readLength
	if remaining > 0 {
		if _, err := io.CopyN(io.Discard, conn.reader, remaining); err != nil {
			return upstreamFrame{}, err
		}
	}

	return upstreamFrame{opcode: opcode, payload: payload, sizeBytes: length, oversized: oversized}, nil
}

func normalizeCapture(frame upstreamFrame) captureEvent {
	event := captureEvent{
		ReceivedAt:        time.Now().UTC().Format(time.RFC3339Nano),
		Direction:         "inbound",
		Opcode:            opcodeLabel(frame.opcode),
		OriginalSizeBytes: frame.sizeBytes,
		SizeBytes:         int64(len(frame.payload)),
		Oversized:         frame.oversized,
		RawTruncated:      frame.oversized,
		Truncated:         frame.oversized,
		DisplayTopic:      "unknown",
		DisplayType:       "message",
	}

	if frame.opcode == 0x2 {
		event.RawBase64 = base64.StdEncoding.EncodeToString(frame.payload)
		event.addIssue("binary_message", "info", "Binary message preserved as base64.")
		event.addStatus("unparsed")
		finalizeStatuses(&event)
		return event
	}

	if utf8.Valid(frame.payload) {
		event.Raw = string(frame.payload)
	} else {
		event.RawBase64 = base64.StdEncoding.EncodeToString(frame.payload)
		event.ParseError = "text frame payload is not valid UTF-8"
		event.addIssue("parse_error", "error", event.ParseError)
		event.addStatus("parse_error")
		finalizeStatuses(&event)
		return event
	}

	if frame.oversized {
		event.addIssue("oversized", "error", fmt.Sprintf("Message size %d bytes exceeds the %d byte capture limit; raw preview was retained.", frame.sizeBytes, maxRawMessageBytes))
		event.addStatus("oversized")
		finalizeStatuses(&event)
		return event
	}

	if frame.opcode != 0x1 {
		event.addStatus("unparsed")
		finalizeStatuses(&event)
		return event
	}

	parsed, err := decodeEnvelopeObject(frame.payload)
	if err != nil {
		event.ParseError = err.Error()
		event.addIssue("parse_error", "error", err.Error())
		event.addStatus("parse_error")
		finalizeStatuses(&event)
		return event
	}

	envelope := wiretapEnvelope{Payload: parsed["payload"]}
	if topic, ok := requiredStringField(parsed, "topic", &event); ok {
		envelope.Topic = topic
		event.Topic = topic
		event.DisplayTopic = topic
	}
	if eventType, ok := requiredStringField(parsed, "type", &event); ok {
		envelope.Type = eventType
		event.Type = eventType
		event.DisplayType = eventType
	}
	if key, ok := optionalStringField(parsed, "key", &event); ok {
		envelope.Key = key
		event.Key = key
		event.EffectiveKey = key
	}
	if symbol, ok := optionalStringField(parsed, "symbol", &event); ok {
		envelope.Symbol = symbol
		if event.EffectiveKey == "" {
			event.EffectiveKey = symbol
			event.Key = symbol
		}
	}
	if ts, ok := optionalTimestampField(parsed, "ts", &event); ok {
		envelope.TS = ts
		event.SourceTS = ts
	}
	if seq, ok := optionalInt64Field(parsed, "seq", &event); ok {
		envelope.Seq = &seq
		event.Seq = &seq
	}

	event.Envelope = &envelope

	if hasIssueCode(event.Issues, "schema_error") {
		event.addStatus("schema_error")
	}
	finalizeStatuses(&event)
	return event
}

func decodeEnvelopeObject(payload []byte) (map[string]interface{}, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()

	var parsed interface{}
	if err := decoder.Decode(&parsed); err != nil {
		return nil, err
	}
	var extra interface{}
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errors.New("json payload contains multiple top-level values")
	}

	values, ok := parsed.(map[string]interface{})
	if !ok {
		return nil, errors.New("wiretap envelope must be a JSON object")
	}
	return values, nil
}

func requiredStringField(values map[string]interface{}, key string, event *captureEvent) (string, bool) {
	value, exists := values[key]
	if !exists {
		event.addIssue("schema_error", "error", fmt.Sprintf("Envelope is missing required string field: %s.", key))
		return "", false
	}
	text, ok := value.(string)
	if !ok || text == "" {
		event.addIssue("schema_error", "error", fmt.Sprintf("Envelope field %s must be a non-empty string.", key))
		return "", false
	}
	return text, true
}

func optionalStringField(values map[string]interface{}, key string, event *captureEvent) (string, bool) {
	value, exists := values[key]
	if !exists || value == nil {
		return "", false
	}
	text, ok := value.(string)
	if !ok {
		event.addIssue("schema_error", "error", fmt.Sprintf("Envelope field %s must be a string when present.", key))
		return "", false
	}
	if text == "" {
		return "", false
	}
	return text, true
}

func optionalTimestampField(values map[string]interface{}, key string, event *captureEvent) (interface{}, bool) {
	value, exists := values[key]
	if !exists || value == nil {
		return nil, false
	}

	switch typed := value.(type) {
	case string:
		return typed, true
	case json.Number:
		if _, err := typed.Float64(); err == nil {
			return typed, true
		}
	}

	event.addIssue("schema_error", "error", "Envelope field ts must be a number or string when present.")
	return nil, false
}

func optionalInt64Field(values map[string]interface{}, key string, event *captureEvent) (int64, bool) {
	value, exists := values[key]
	if !exists || value == nil {
		return 0, false
	}

	number, ok := value.(json.Number)
	if !ok {
		event.addIssue("schema_error", "error", fmt.Sprintf("Envelope field %s must be an integer number when present.", key))
		return 0, false
	}

	parsed, err := number.Int64()
	if err != nil {
		event.addIssue("schema_error", "error", fmt.Sprintf("Envelope field %s must be an integer number when present.", key))
		return 0, false
	}
	return parsed, true
}

func (event *captureEvent) addIssue(code string, severity string, message string) {
	event.Issues = append(event.Issues, captureIssue{
		Code:     code,
		Severity: severity,
		Message:  message,
	})
}

func (event *captureEvent) addSequenceIssue(code string, severity string, message string, details map[string]interface{}) {
	event.Issues = append(event.Issues, captureIssue{
		Code:     code,
		Severity: severity,
		Message:  message,
		Topic:    event.Topic,
		Key:      event.EffectiveKey,
		Details:  details,
	})
	event.addStatus(code)
}

func (event *captureEvent) addStatus(status string) {
	if status != "ok" {
		statuses := event.Statuses[:0]
		for _, current := range event.Statuses {
			if current != "ok" {
				statuses = append(statuses, current)
			}
		}
		event.Statuses = statuses
	}
	for _, current := range event.Statuses {
		if current == status {
			return
		}
	}
	event.Statuses = append(event.Statuses, status)
}

func finalizeStatuses(event *captureEvent) {
	if len(event.Statuses) == 0 {
		event.addStatus("ok")
	}
}

func hasIssueCode(issues []captureIssue, code string) bool {
	for _, issue := range issues {
		if issue.Code == code {
			return true
		}
	}
	return false
}

func opcodeLabel(opcode byte) string {
	switch opcode {
	case 0x1:
		return "text"
	case 0x2:
		return "binary"
	default:
		return fmt.Sprintf("0x%x", opcode)
	}
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}

func writeUpgradeResponse(rw *bufio.ReadWriter, key string, protocol string) error {
	accept := websocketAccept(key)
	protocolHeader := ""
	if protocol != "" {
		protocolHeader = fmt.Sprintf("Sec-WebSocket-Protocol: %s\r\n", protocol)
	}
	_, err := fmt.Fprintf(
		rw,
		"HTTP/1.1 101 Switching Protocols\r\n"+
			"Upgrade: websocket\r\n"+
			"Connection: Upgrade\r\n"+
			"Sec-WebSocket-Accept: %s\r\n%s\r\n",
		accept,
		protocolHeader,
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

func writeClientControlFrame(conn net.Conn, opcode byte, payload []byte) error {
	if len(payload) > 125 {
		payload = payload[:125]
	}

	mask := make([]byte, 4)
	if _, err := rand.Read(mask); err != nil {
		return err
	}

	frame := []byte{0x80 | opcode, 0x80 | byte(len(payload))}
	frame = append(frame, mask...)
	for i, value := range payload {
		frame = append(frame, value^mask[i%4])
	}

	_, err := conn.Write(frame)
	return err
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

func writeHTTPError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"message": message})
}

func writeMethodNotAllowed(w http.ResponseWriter, methods ...string) {
	w.Header().Set("Allow", strings.Join(append(methods, http.MethodOptions), ", "))
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}
