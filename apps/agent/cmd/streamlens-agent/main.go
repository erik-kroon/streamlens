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
	liveClientBufferSize = 4_096
	maxRawMessageBytes   = 1 << 20
	rawPreviewBytes      = 16 << 10
	reconnectDelay       = 1200 * time.Millisecond
	staleTickInterval    = 500 * time.Millisecond
	rateWindow           = time.Second
	writeDeadlineTimeout = 5 * time.Second
	statsBroadcastEvery  = 250 * time.Millisecond
	defaultStreamID      = "default"
	transportWebSocket   = "websocket"
	transportSSE         = "sse"
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
	streams         map[string]*streamRuntime
	eventCount      int64
	issueCount      int64
	nextCaptureSeq  int64
	lastStatsSentAt time.Time
	connectionID    string
	events          []captureEvent
	topics          *topicTracker
	sequences       *sequenceTracker
	extractionRules extractionRules
	recorder        *captureRecorder
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
	StreamID      string               `json:"streamId,omitempty"`
	Transport     string               `json:"transport,omitempty"`
	URL           string               `json:"url"`
	Headers       map[string]string    `json:"headers"`
	BearerToken   string               `json:"bearerToken"`
	APIKeyHeader  string               `json:"apiKeyHeader"`
	APIKey        string               `json:"apiKey"`
	Subprotocols  []string             `json:"subprotocols"`
	AutoReconnect bool                 `json:"autoReconnect"`
	Faults        faultInjectionConfig `json:"faults,omitempty"`
}

type upstreamSession struct {
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	config   connectRequest
	streamID string
}

type streamRuntime struct {
	ID              string           `json:"id"`
	Transport       string           `json:"transport,omitempty"`
	URL             string           `json:"url,omitempty"`
	State           agentState       `json:"state"`
	LastError       string           `json:"lastError,omitempty"`
	ConnectedAt     *time.Time       `json:"-"`
	ConnectedAtText string           `json:"connectedAt,omitempty"`
	ConnectionID    string           `json:"connectionId,omitempty"`
	Connections     int64            `json:"connections"`
	Events          int64            `json:"events"`
	Issues          int64            `json:"issues"`
	Config          *connectRequest  `json:"-"`
	Session         *upstreamSession `json:"-"`
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
	Streams     []streamStatus    `json:"streams"`
	Endpoints   map[string]string `json:"endpoints"`
}

type captureStats struct {
	Connections    int64          `json:"connections"`
	Events         int64          `json:"events"`
	RetainedEvents int64          `json:"retainedEvents"`
	DroppedEvents  int64          `json:"droppedEvents"`
	BufferCapacity int64          `json:"bufferCapacity"`
	Issues         int64          `json:"issues"`
	LiveClients    int64          `json:"liveClients"`
	UptimeMs       int64          `json:"uptimeMs"`
	State          agentState     `json:"state"`
	TargetURL      string         `json:"targetUrl,omitempty"`
	ConnectedAt    string         `json:"connectedAt,omitempty"`
	ActiveStreams  int64          `json:"activeStreams"`
	Streams        []streamStatus `json:"streams"`
}

type streamStatus struct {
	ID           string     `json:"id"`
	Transport    string     `json:"transport,omitempty"`
	URL          string     `json:"url,omitempty"`
	State        agentState `json:"state"`
	LastError    string     `json:"lastError,omitempty"`
	ConnectedAt  string     `json:"connectedAt,omitempty"`
	ConnectionID string     `json:"connectionId,omitempty"`
	Connections  int64      `json:"connections"`
	Events       int64      `json:"events"`
	Issues       int64      `json:"issues"`
}

type agentMessage struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload"`
}

type liveClient struct {
	send chan []byte
}

type captureEvent struct {
	ID                string              `json:"id,omitempty"`
	StreamID          string              `json:"streamId,omitempty"`
	ConnectionID      string              `json:"connectionId,omitempty"`
	Transport         string              `json:"transport,omitempty"`
	TransportMeta     map[string]string   `json:"transportMeta,omitempty"`
	CaptureSeq        int64               `json:"captureSeq"`
	ReceivedAt        string              `json:"receivedAt"`
	Direction         string              `json:"direction"`
	Opcode            string              `json:"opcode"`
	OriginalSizeBytes int64               `json:"originalSizeBytes"`
	SizeBytes         int64               `json:"sizeBytes"`
	Raw               string              `json:"raw,omitempty"`
	RawBase64         string              `json:"rawBase64,omitempty"`
	RawTruncated      bool                `json:"rawTruncated"`
	Truncated         bool                `json:"truncated"`
	Oversized         bool                `json:"oversized"`
	Topic             string              `json:"topic,omitempty"`
	DisplayTopic      string              `json:"displayTopic"`
	Type              string              `json:"eventType,omitempty"`
	DisplayType       string              `json:"displayType"`
	Key               string              `json:"key,omitempty"`
	EffectiveKey      string              `json:"effectiveKey,omitempty"`
	Seq               *int64              `json:"seq,omitempty"`
	SourceTS          interface{}         `json:"sourceTs,omitempty"`
	Correlation       *otelCorrelation    `json:"correlation,omitempty"`
	Envelope          *streamlensEnvelope `json:"envelope,omitempty"`
	ParseError        string              `json:"parseError,omitempty"`
	Statuses          []string            `json:"statuses"`
	Issues            []captureIssue      `json:"issues,omitempty"`
}

type streamlensExportEvent struct {
	CaptureSeq        int64               `json:"captureSeq"`
	StreamID          string              `json:"streamId,omitempty"`
	ConnectionID      string              `json:"connectionId"`
	Transport         string              `json:"transport,omitempty"`
	TransportMeta     map[string]string   `json:"transportMeta,omitempty"`
	ReceivedAt        int64               `json:"receivedAt"`
	Direction         string              `json:"direction"`
	Opcode            string              `json:"opcode"`
	Raw               string              `json:"raw"`
	RawBase64         string              `json:"rawBase64,omitempty"`
	RawTruncated      bool                `json:"rawTruncated"`
	Truncated         bool                `json:"truncated"`
	Oversized         bool                `json:"oversized"`
	OriginalSizeBytes int64               `json:"originalSizeBytes"`
	SizeBytes         int64               `json:"sizeBytes"`
	Correlation       *otelCorrelation    `json:"correlation,omitempty"`
	Parsed            *streamlensEnvelope `json:"parsed"`
	ParseError        string              `json:"parseError,omitempty"`
}

type streamlensEnvelope struct {
	Topic   string      `json:"topic"`
	Type    string      `json:"type"`
	Seq     *int64      `json:"seq,omitempty"`
	TS      interface{} `json:"ts,omitempty"`
	Key     string      `json:"key,omitempty"`
	Symbol  string      `json:"symbol,omitempty"`
	Payload interface{} `json:"payload,omitempty"`
}

type otelCorrelation struct {
	TraceID       string `json:"traceId,omitempty"`
	SpanID        string `json:"spanId,omitempty"`
	ParentSpanID  string `json:"parentSpanId,omitempty"`
	TraceState    string `json:"traceState,omitempty"`
	LogID         string `json:"logId,omitempty"`
	ServiceName   string `json:"serviceName,omitempty"`
	Source        string `json:"source,omitempty"`
	TraceQueryURL string `json:"traceQueryUrl,omitempty"`
	LogQueryURL   string `json:"logQueryUrl,omitempty"`
	OTLPEndpoint  string `json:"otlpEndpoint,omitempty"`
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
	opcode        byte
	payload       []byte
	sizeBytes     int64
	oversized     bool
	transport     string
	transportMeta map[string]string
}

func main() {
	address := flag.String("addr", defaultAddress, "HTTP listen address")
	demoAddress := flag.String("demo-addr", "127.0.0.1:8791", "demo WebSocket listen address; use empty string to disable")
	dataDir := flag.String("data-dir", os.Getenv("STREAMLENS_DATA_DIR"), "capture database directory")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	store, err := openCaptureStore(*dataDir)
	if err != nil {
		logger.Error("failed to open capture database", "error", err)
		os.Exit(1)
	}
	snapshot, err := store.loadOrCreateCurrentSession()
	if err != nil {
		logger.Error("failed to load capture session", "error", err)
		os.Exit(1)
	}
	agent := &agent{
		id:              "streamlens-local-agent",
		version:         "0.2.0",
		startedAt:       time.Now().UTC(),
		state:           stateReady,
		eventCount:      snapshot.Session.EventCount,
		issueCount:      snapshot.Session.IssueCount,
		nextCaptureSeq:  latestCaptureSeq(snapshot.Events),
		events:          snapshot.Events,
		topics:          newTopicTrackerFromSnapshot(snapshot.Topics),
		sequences:       newSequenceTracker(),
		extractionRules: defaultExtractionRules(),
		recorder:        newCaptureRecorder(store, snapshot.Session),
		streams:         make(map[string]*streamRuntime),
		subscribers:     make(map[*liveClient]struct{}),
	}
	agent.rebuildSequenceTrackerFromEvents()
	agent.rebuildStreamRuntimeFromEvents()
	go agent.runStaleEvaluator(context.Background())
	if strings.TrimSpace(*demoAddress) != "" {
		go runDemoStreamServer(*demoAddress, logger)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", agent.withCORS(agent.handleHealth))
	mux.HandleFunc("/stats", agent.withCORS(agent.handleStats))
	mux.HandleFunc("/events", agent.withCORS(agent.handleEvents))
	mux.HandleFunc("/topics", agent.withCORS(agent.handleTopics))
	mux.HandleFunc("/extraction-rules", agent.withCORS(agent.handleExtractionRules))
	mux.HandleFunc("/fuzz", agent.withCORS(agent.handleFuzz))
	mux.HandleFunc("/fuzz/fixtures", agent.withCORS(agent.handleFuzzFixtures))
	mux.HandleFunc("/export/jsonl", agent.withCORS(agent.handleExportJSONL))
	mux.HandleFunc("/export/tape", agent.withCORS(agent.handleExportTape))
	mux.HandleFunc("/import/jsonl", agent.withCORS(agent.handleImportJSONL))
	mux.HandleFunc("/sessions", agent.withCORS(agent.handleSessions))
	mux.HandleFunc("/sessions/", agent.withCORS(agent.handleSessionByID))
	mux.HandleFunc("/sessions/current", agent.withCORS(agent.handleCurrentSession))
	mux.HandleFunc("/sessions/current/events", agent.withCORS(agent.handleCurrentSessionEvents))
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

	logger.Info("StreamLens agent listening", "address", "http://"+*address)
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

func (a *agent) handleExtractionRules(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, a.currentExtractionRules())
	case http.MethodPut:
		var rules extractionRules
		if err := json.NewDecoder(r.Body).Decode(&rules); err != nil {
			writeHTTPError(w, http.StatusBadRequest, "invalid extraction rules payload")
			return
		}
		rules = normalizeExtractionRules(rules)
		if err := rules.validate(); err != nil {
			writeHTTPError(w, http.StatusBadRequest, err.Error())
			return
		}
		a.setExtractionRules(rules)
		writeJSON(w, http.StatusOK, rules)
	default:
		writeMethodNotAllowed(w, http.MethodGet, http.MethodPut)
	}
}

func (a *agent) handleExportJSONL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", exportFilename(time.Now().UTC())))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	encoder := json.NewEncoder(w)
	for _, event := range a.exportSnapshot() {
		if err := encoder.Encode(event); err != nil {
			slog.Error("failed to write jsonl export", "error", err)
			return
		}
	}
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

	a.stopConnection(streamIDFromRequest(r), stateDisconnected, "")
	writeJSON(w, http.StatusOK, a.status())
}

func (a *agent) handleReconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}

	streamID := streamIDFromRequest(r)
	a.mu.RLock()
	config := a.activeConfig
	if streamID != "" {
		if stream := a.streams[streamID]; stream != nil {
			config = stream.Config
		} else {
			config = nil
		}
	}
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

	if a.recorder != nil {
		if _, err := a.recorder.createSession(""); err != nil {
			writeHTTPError(w, http.StatusInternalServerError, err.Error())
			return
		}
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

	client := &liveClient{send: make(chan []byte, liveClientBufferSize)}
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
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Disposition")
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
	streamID := normalizedStreamID(config.StreamID)
	config.StreamID = streamID
	ctx, cancel := context.WithCancel(context.Background())
	session := &upstreamSession{
		ctx:      ctx,
		cancel:   cancel,
		done:     make(chan struct{}),
		config:   config,
		streamID: streamID,
	}

	a.mu.Lock()
	a.ensureStreamsLocked()
	stream := a.streams[streamID]
	if stream == nil {
		stream = &streamRuntime{ID: streamID}
		a.streams[streamID] = stream
	}
	previous := stream.Session
	stream.Session = session
	stream.Config = &session.config
	stream.URL = config.URL
	stream.Transport = config.Transport
	stream.State = stateConnecting
	stream.LastError = ""
	stream.ConnectedAt = nil
	stream.ConnectedAtText = ""
	a.session = session
	a.activeConfig = &session.config
	a.state = stateConnecting
	a.lastError = ""
	a.connectedAt = nil
	a.mu.Unlock()

	if a.recorder != nil {
		if err := a.recorder.updateTargetURL(config.URL); err != nil {
			slog.Error("failed to update capture session target", "error", err)
		}
	}

	return previous
}

func (a *agent) runUpstream(config connectRequest) {
	streamID := normalizedStreamID(config.StreamID)
	a.mu.RLock()
	stream := a.streams[streamID]
	var session *upstreamSession
	if stream != nil {
		session = stream.Session
	}
	a.mu.RUnlock()
	if session == nil {
		return
	}
	defer close(session.done)

	ctx := session.ctx

	firstAttempt := true
	for {
		if !firstAttempt {
			a.setConnectionState(streamID, stateReconnecting, "")
			select {
			case <-ctx.Done():
				a.setConnectionState(streamID, stateDisconnected, "")
				return
			case <-time.After(reconnectDelay):
			}
		}
		firstAttempt = false

		a.setConnectionState(streamID, stateConnecting, "")
		err := a.connectAndCapture(ctx, streamID, config)
		if err == nil {
			err = errors.New("upstream capture ended")
		}
		if err != nil {
			if ctx.Err() != nil {
				a.setConnectionState(streamID, stateDisconnected, "")
				return
			}
			a.setConnectionState(streamID, stateError, err.Error())
			if !config.AutoReconnect {
				return
			}
			continue
		}

	}
}

func (a *agent) connectAndCapture(ctx context.Context, streamID string, config connectRequest) error {
	switch config.Transport {
	case transportSSE:
		body, err := dialSSE(ctx, config)
		if err != nil {
			return err
		}
		a.markStreamConnected(streamID)
		err = a.captureSSE(ctx, streamID, body)
		_ = body.Close()
		return err
	default:
		conn, err := dialWebSocket(ctx, config)
		if err != nil {
			return err
		}
		a.markStreamConnected(streamID)
		err = a.captureWebSocketFrames(ctx, streamID, conn)
		_ = conn.Close()
		return err
	}
}

func (a *agent) markStreamConnected(streamID string) {
	connectedAt := time.Now().UTC()
	a.mu.Lock()
	a.connectionCount++
	connectionID := fmt.Sprintf("%s-conn-%d", streamID, a.connectionCount)
	a.connectionID = connectionID
	a.connectedAt = &connectedAt
	a.state = stateConnected
	a.lastError = ""
	if stream := a.streams[streamID]; stream != nil {
		stream.Connections++
		stream.ConnectionID = connectionID
		stream.ConnectedAt = &connectedAt
		stream.ConnectedAtText = connectedAt.Format(time.RFC3339Nano)
		stream.State = stateConnected
		stream.LastError = ""
	}
	a.mu.Unlock()
	a.broadcast(agentMessage{Type: "agent.ready", Payload: a.status()})
	a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
}

func (a *agent) captureWebSocketFrames(ctx context.Context, streamID string, conn *upstreamConn) error {
	a.mu.RLock()
	stream := a.streams[streamID]
	var injector *faultInjector
	if stream != nil && stream.Config != nil {
		injector = newFaultInjector(stream.Config.Faults)
	}
	a.mu.RUnlock()

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
			frame.transport = transportWebSocket
			frames, err := injector.apply(ctx, frame)
			if err != nil {
				return err
			}
			for _, output := range frames {
				event := normalizeCaptureWithRules(output, a.currentExtractionRules())
				a.recordEventForStream(streamID, event)
			}
		case 0x8:
			return errors.New("upstream closed websocket")
		case 0x9:
			if err := writeClientControlFrame(conn.Conn, 0xA, frame.payload); err != nil {
				return err
			}
		}
	}
}

func (a *agent) captureSSE(ctx context.Context, streamID string, reader io.Reader) error {
	scanner := newSSEScanner(reader)
	a.mu.RLock()
	stream := a.streams[streamID]
	var injector *faultInjector
	if stream != nil && stream.Config != nil {
		injector = newFaultInjector(stream.Config.Faults)
	}
	a.mu.RUnlock()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		event, err := scanner.next()
		if err != nil {
			return err
		}
		if len(event.data) == 0 {
			continue
		}

		frame := upstreamFrame{
			opcode:    0x1,
			payload:   event.data,
			sizeBytes: event.sizeBytes,
			oversized: event.oversized,
			transport: transportSSE,
		}
		if event.eventType != "" || event.id != "" {
			frame.transportMeta = map[string]string{}
			if event.eventType != "" {
				frame.transportMeta["event"] = event.eventType
			}
			if event.id != "" {
				frame.transportMeta["id"] = event.id
			}
		}
		frames, err := injector.apply(ctx, frame)
		if err != nil {
			return err
		}
		for _, output := range frames {
			capture := normalizeCaptureWithRules(output, a.currentExtractionRules())
			a.recordEventForStream(streamID, capture)
		}
	}
}

func (a *agent) recordEvent(event captureEvent) captureEvent {
	return a.recordEventForStream(defaultStreamID, event)
}

func (a *agent) recordEventForStream(streamID string, event captureEvent) captureEvent {
	var topic topicState
	var hasTopic bool
	var shouldBroadcastStats bool
	var topics []topicState
	var recorder *captureRecorder
	var eventCount int64
	var issueCount int64
	var retainedCount int

	a.mu.Lock()
	a.ensureCaptureModulesLocked()
	a.ensureStreamsLocked()
	streamID = normalizedStreamID(streamID)
	stream := a.streams[streamID]
	if stream == nil {
		stream = &streamRuntime{ID: streamID, State: stateDisconnected, ConnectionID: a.connectionID}
		a.streams[streamID] = stream
	}
	a.nextCaptureSeq++
	event.CaptureSeq = a.nextCaptureSeq
	event.StreamID = streamID
	if event.Transport == "" {
		event.Transport = stream.Transport
	}
	event.ConnectionID = stream.ConnectionID
	if event.ConnectionID == "" {
		event.ConnectionID = streamID + "-conn-0"
	}
	event.ID = fmt.Sprintf("%s:%d", event.ConnectionID, event.CaptureSeq)
	a.sequences.detect(&event)
	a.eventCount++
	a.issueCount += int64(len(event.Issues))
	stream.Events++
	stream.Issues += int64(len(event.Issues))
	a.events = append(a.events, event)
	if len(a.events) > maxBufferedEvents {
		copy(a.events, a.events[len(a.events)-maxBufferedEvents:])
		a.events = a.events[:maxBufferedEvents]
	}
	topic, hasTopic = a.topics.record(event)
	topics = a.topics.snapshot(time.Now().UTC())
	sortTopicsByID(topics)
	recorder = a.recorder
	eventCount = a.eventCount
	issueCount = a.issueCount
	retainedCount = len(a.events)
	now := time.Now().UTC()
	if a.lastStatsSentAt.IsZero() || now.Sub(a.lastStatsSentAt) >= statsBroadcastEvery {
		a.lastStatsSentAt = now
		shouldBroadcastStats = true
	}
	a.mu.Unlock()

	if recorder != nil {
		if err := recorder.recordEvent(event, topics, eventCount, issueCount, retainedCount); err != nil {
			slog.Error("failed to persist capture event", "error", err)
		}
	}
	a.broadcast(agentMessage{Type: "capture.event", Payload: event})
	if hasTopic {
		a.broadcast(agentMessage{Type: "topic.updated", Payload: topic})
	}
	if shouldBroadcastStats {
		a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
	}
	return event
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
	var topics []topicState
	var recorder *captureRecorder
	var issueCount int64
	var retainedCount int

	a.mu.Lock()
	a.ensureCaptureModulesLocked()
	result := a.topics.evaluateStale(now)
	a.issueCount += result.issueDelta
	if len(result.changed) > 0 {
		topics = a.topics.snapshot(now)
		sortTopicsByID(topics)
		recorder = a.recorder
		issueCount = a.issueCount
		retainedCount = len(a.events)
	}
	a.mu.Unlock()

	if recorder != nil && len(result.changed) > 0 {
		if err := recorder.recordTopicSnapshot(topics, issueCount, retainedCount); err != nil {
			slog.Error("failed to persist topic snapshot", "error", err)
		}
	}
	for _, topic := range result.changed {
		a.broadcast(agentMessage{Type: "topic.updated", Payload: topic})
	}
	if len(result.changed) > 0 {
		a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
	}
	return result.changed
}

func (a *agent) stopConnection(streamID string, state agentState, lastError string) {
	streamID = normalizedStreamID(streamID)
	a.mu.Lock()
	a.ensureStreamsLocked()
	stream := a.streams[streamID]
	var session *upstreamSession
	if stream != nil {
		session = stream.Session
		stream.Session = nil
		stream.State = state
		stream.LastError = lastError
		stream.ConnectedAt = nil
		stream.ConnectedAtText = ""
	}
	a.refreshAggregateConnectionStateLocked()
	a.mu.Unlock()

	if session != nil {
		session.cancel()
		<-session.done
	}

	a.broadcast(agentMessage{Type: "agent.ready", Payload: a.status()})
	a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
}

func (a *agent) setConnectionState(streamID string, state agentState, lastError string) {
	streamID = normalizedStreamID(streamID)
	a.mu.Lock()
	a.ensureStreamsLocked()
	if stream := a.streams[streamID]; stream != nil {
		stream.State = state
		stream.LastError = lastError
		if state != stateConnected {
			stream.ConnectedAt = nil
			stream.ConnectedAtText = ""
		}
	}
	a.refreshAggregateConnectionStateLocked()
	a.mu.Unlock()

	a.broadcast(agentMessage{Type: "agent.ready", Payload: a.status()})
	a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
}

func (a *agent) status() agentStatus {
	a.mu.RLock()
	state := a.state
	lastError := a.lastError
	config := a.activeConfig
	streams := a.streamStatusesLocked()
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
		Streams:     streams,
		Endpoints: map[string]string{
			"health":        "http://localhost:8790/health",
			"stats":         "http://localhost:8790/stats",
			"events":        "http://localhost:8790/events",
			"topics":        "http://localhost:8790/topics",
			"extraction":    "http://localhost:8790/extraction-rules",
			"fuzz":          "http://localhost:8790/fuzz",
			"fuzzFixtures":  "http://localhost:8790/fuzz/fixtures",
			"exportJsonl":   "http://localhost:8790/export/jsonl",
			"exportTape":    "http://localhost:8790/export/tape",
			"importJsonl":   "http://localhost:8790/import/jsonl",
			"session":       "http://localhost:8790/sessions/current",
			"sessionEvents": "http://localhost:8790/sessions/current/events",
			"sessionReplay": "ws://localhost:8790/sessions/{sessionId}/replay",
			"connect":       "http://localhost:8790/connect",
			"disconnect":    "http://localhost:8790/disconnect",
			"reconnect":     "http://localhost:8790/reconnect",
			"clear":         "http://localhost:8790/clear",
			"live":          "ws://localhost:8790/live",
		},
	}
}

func (a *agent) stats() captureStats {
	a.mu.RLock()
	streams := a.streamStatusesLocked()
	activeStreams := int64(0)
	for _, stream := range streams {
		if stream.State == stateConnecting || stream.State == stateConnected || stream.State == stateReconnecting {
			activeStreams++
		}
	}
	retainedEvents := int64(len(a.events))
	droppedEvents := a.eventCount - retainedEvents
	if droppedEvents < 0 {
		droppedEvents = 0
	}
	stats := captureStats{
		Connections:    a.connectionCount,
		Events:         a.eventCount,
		RetainedEvents: retainedEvents,
		DroppedEvents:  droppedEvents,
		BufferCapacity: maxBufferedEvents,
		Issues:         a.issueCount,
		LiveClients:    a.liveClients.Load(),
		UptimeMs:       a.uptimeMs(),
		State:          a.state,
		ActiveStreams:  activeStreams,
		Streams:        streams,
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

func (a *agent) exportSnapshot() []streamlensExportEvent {
	a.mu.RLock()
	defer a.mu.RUnlock()

	events := make([]streamlensExportEvent, 0, len(a.events))
	for _, event := range a.events {
		events = append(events, exportEvent(event))
	}
	return events
}

func (a *agent) topicSnapshot() []topicState {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.ensureCaptureModulesLocked()
	return a.topics.snapshot(time.Now().UTC())
}

func (a *agent) currentExtractionRules() extractionRules {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return normalizeExtractionRules(a.extractionRules)
}

func (a *agent) setExtractionRules(rules extractionRules) {
	a.mu.Lock()
	a.extractionRules = normalizeExtractionRules(rules)
	a.mu.Unlock()
}

func exportEvent(event captureEvent) streamlensExportEvent {
	return streamlensExportEvent{
		CaptureSeq:        event.CaptureSeq,
		StreamID:          event.StreamID,
		ConnectionID:      event.ConnectionID,
		Transport:         event.Transport,
		TransportMeta:     event.TransportMeta,
		ReceivedAt:        receivedAtMillis(event.ReceivedAt),
		Direction:         event.Direction,
		Opcode:            event.Opcode,
		Raw:               event.Raw,
		RawBase64:         event.RawBase64,
		RawTruncated:      event.RawTruncated,
		Truncated:         event.Truncated,
		Oversized:         event.Oversized,
		OriginalSizeBytes: event.OriginalSizeBytes,
		SizeBytes:         event.SizeBytes,
		Correlation:       event.Correlation,
		Parsed:            event.Envelope,
		ParseError:        event.ParseError,
	}
}

func receivedAtMillis(value string) int64 {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return 0
	}
	return parsed.UnixMilli()
}

func exportFilename(now time.Time) string {
	return "streamlens-capture-" + now.Format("20060102T150405Z") + ".jsonl"
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
	a.ensureStreamsLocked()
}

func (a *agent) rebuildSequenceTrackerFromEvents() {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.rebuildSequenceTrackerFromEventsLocked()
}

func (a *agent) rebuildSequenceTrackerFromEventsLocked() {
	a.ensureCaptureModulesLocked()
	a.sequences = newSequenceTracker()
	for _, event := range a.events {
		eventCopy := event
		a.sequences.detect(&eventCopy)
	}
}

func latestCaptureSeq(events []captureEvent) int64 {
	var latest int64
	for _, event := range events {
		if event.CaptureSeq > latest {
			latest = event.CaptureSeq
		}
	}
	return latest
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
	request.StreamID = normalizedStreamID(request.StreamID)
	request.URL = strings.TrimSpace(request.URL)
	if request.URL == "" {
		return errors.New("url is required")
	}

	parsed, err := url.Parse(request.URL)
	if err != nil {
		return fmt.Errorf("invalid upstream url: %w", err)
	}

	if parsed.Host == "" {
		return errors.New("url must include a host")
	}
	request.Transport = normalizeTransport(request.Transport, parsed.Scheme)
	switch request.Transport {
	case transportWebSocket:
		if parsed.Scheme != "ws" && parsed.Scheme != "wss" {
			return errors.New("websocket transport requires ws:// or wss://")
		}
	case transportSSE:
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return errors.New("sse transport requires http:// or https://")
		}
	default:
		return errors.New("transport must be websocket or sse")
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

	faults, err := normalizeFaultInjectionConfig(request.Faults)
	if err != nil {
		return err
	}
	request.Faults = faults
	return nil
}

func normalizeTransport(value string, scheme string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	switch value {
	case "", "auto":
		switch scheme {
		case "http", "https":
			return transportSSE
		case "ws", "wss":
			return transportWebSocket
		default:
			return value
		}
	case "ws", "websocket":
		return transportWebSocket
	case "sse", "eventsource", "event-stream":
		return transportSSE
	default:
		return value
	}
}

func dialWebSocket(ctx context.Context, config connectRequest) (*upstreamConn, error) {
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

func dialSSE(ctx context.Context, config connectRequest) (io.ReadCloser, error) {
	parsed, err := url.Parse(config.URL)
	if err != nil {
		return nil, err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Cache-Control", "no-cache")
	for name, value := range config.Headers {
		request.Header.Set(name, value)
	}
	if strings.TrimSpace(config.BearerToken) != "" {
		request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(config.BearerToken))
	}
	if config.APIKeyHeader != "" && strings.TrimSpace(config.APIKey) != "" {
		request.Header.Set(config.APIKeyHeader, strings.TrimSpace(config.APIKey))
	}

	response, err := (&http.Client{}).Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_ = response.Body.Close()
		return nil, fmt.Errorf("sse request returned %s", response.Status)
	}
	return response.Body, nil
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

type sseScanner struct {
	reader *bufio.Reader
}

type sseMessage struct {
	data      []byte
	eventType string
	id        string
	sizeBytes int64
	oversized bool
}

func newSSEScanner(reader io.Reader) *sseScanner {
	return &sseScanner{reader: bufio.NewReader(reader)}
}

func (scanner *sseScanner) next() (sseMessage, error) {
	var message sseMessage
	var dataLines int

	for {
		line, err := scanner.reader.ReadString('\n')
		if err != nil && !(errors.Is(err, io.EOF) && line != "") {
			if errors.Is(err, io.EOF) && len(message.data) > 0 {
				return message, nil
			}
			return sseMessage{}, err
		}

		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if len(message.data) > 0 || message.eventType != "" || message.id != "" {
				return message, nil
			}
			if errors.Is(err, io.EOF) {
				return sseMessage{}, err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			if errors.Is(err, io.EOF) {
				return sseMessage{}, err
			}
			continue
		}

		field, value := splitSSEField(line)
		switch field {
		case "event":
			message.eventType = value
		case "id":
			message.id = value
		case "data":
			if dataLines > 0 {
				message.sizeBytes++
				appendSSEData(&message, []byte("\n"))
			}
			message.sizeBytes += int64(len(value))
			appendSSEData(&message, []byte(value))
			dataLines++
		}

		if errors.Is(err, io.EOF) {
			if len(message.data) > 0 {
				return message, nil
			}
			return sseMessage{}, err
		}
	}
}

func splitSSEField(line string) (string, string) {
	index := strings.IndexByte(line, ':')
	if index == -1 {
		return line, ""
	}
	value := line[index+1:]
	if strings.HasPrefix(value, " ") {
		value = value[1:]
	}
	return line[:index], value
}

func appendSSEData(message *sseMessage, chunk []byte) {
	if message.sizeBytes > maxRawMessageBytes {
		message.oversized = true
	}
	if len(message.data) >= rawPreviewBytes {
		return
	}
	remaining := rawPreviewBytes - len(message.data)
	if len(chunk) > remaining {
		chunk = chunk[:remaining]
	}
	message.data = append(message.data, chunk...)
}

func normalizeCapture(frame upstreamFrame) captureEvent {
	return normalizeCaptureWithRules(frame, defaultExtractionRules())
}

func normalizeCaptureWithRules(frame upstreamFrame, rules extractionRules) captureEvent {
	rules = normalizeExtractionRules(rules)
	event := captureEvent{
		ReceivedAt:        time.Now().UTC().Format(time.RFC3339Nano),
		Direction:         "inbound",
		Transport:         frame.transport,
		TransportMeta:     copyStringMap(frame.transportMeta),
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

	envelope := streamlensEnvelope{}
	if payload, ok := valueAtPath(parsed, rules.PayloadPath); ok {
		envelope.Payload = payload
	}
	if topic, ok := requiredStringPath(parsed, rules.TopicPath, "topic", &event); ok {
		envelope.Topic = topic
		event.Topic = topic
		event.DisplayTopic = topic
	}
	if eventType, ok := requiredStringPath(parsed, rules.TypePath, "type", &event); ok {
		envelope.Type = eventType
		event.Type = eventType
		event.DisplayType = eventType
	}
	for index, path := range rules.KeyPaths {
		if key, ok := optionalStringPath(parsed, path, &event); ok {
			if index == 0 {
				envelope.Key = key
			}
			if path == "symbol" {
				envelope.Symbol = key
			}
			if event.EffectiveKey == "" {
				event.EffectiveKey = key
				event.Key = key
			}
		}
	}
	if ts, ok := optionalTimestampPath(parsed, rules.TimestampPath, &event); ok {
		envelope.TS = ts
		event.SourceTS = ts
	}
	if seq, ok := optionalInt64Path(parsed, rules.SeqPath, &event); ok {
		envelope.Seq = &seq
		event.Seq = &seq
	}

	event.Envelope = &envelope
	event.Correlation = extractOtelCorrelation(parsed, rules.Otel)
	applySchemaPlugins(parsed, rules.SchemaPlugins, &event)

	if hasIssueCode(event.Issues, "schema_error") {
		event.addStatus("schema_error")
	}
	if hasIssueCode(event.Issues, "schema_plugin") {
		event.addStatus("schema_plugin")
	}
	finalizeStatuses(&event)
	return event
}

func copyStringMap(values map[string]string) map[string]string {
	if len(values) == 0 {
		return nil
	}
	copied := make(map[string]string, len(values))
	for key, value := range values {
		copied[key] = value
	}
	return copied
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
		return nil, errors.New("streamlens envelope must be a JSON object")
	}
	return values, nil
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

func writeWebSocketText(conn interface{ Write([]byte) (int, error) }, payload []byte) error {
	return writeWebSocketMessage(conn, 0x1, payload)
}

func writeWebSocketMessage(conn interface{ Write([]byte) (int, error) }, opcode byte, payload []byte) error {
	header := make([]byte, 10)
	header[0] = 0x80 | (opcode & 0x0f)

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
