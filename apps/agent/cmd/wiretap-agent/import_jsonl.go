package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

type importJSONLResult struct {
	Session        captureSession `json:"session"`
	Events         int64          `json:"events"`
	Issues         int64          `json:"issues"`
	RetainedEvents int            `json:"retainedEvents"`
}

func parseImportJSONL(reader io.Reader) ([]captureEvent, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), maxStoredEventLineBytes)

	var events []captureEvent
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var exported wiretapExportEvent
		if err := json.Unmarshal(line, &exported); err != nil {
			return nil, fmt.Errorf("line %d is not valid JSON: %w", lineNumber, err)
		}
		event, err := importExportEvent(exported)
		if err != nil {
			return nil, fmt.Errorf("line %d import failed: %w", lineNumber, err)
		}
		events = append(events, event)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(events) == 0 {
		return nil, fmt.Errorf("jsonl import did not contain any events")
	}
	return events, nil
}

func importExportEvent(exported wiretapExportEvent) (captureEvent, error) {
	payload, err := importPayload(exported)
	if err != nil {
		return captureEvent{}, err
	}

	sizeBytes := exported.OriginalSizeBytes
	if sizeBytes <= 0 {
		sizeBytes = exported.SizeBytes
	}
	if sizeBytes <= 0 {
		sizeBytes = int64(len(payload))
	}

	event := normalizeCapture(upstreamFrame{
		opcode:    importOpcode(exported),
		payload:   payload,
		sizeBytes: sizeBytes,
		oversized: exported.Oversized || exported.Truncated || exported.RawTruncated,
	})
	if exported.Direction != "" {
		event.Direction = exported.Direction
	}
	if exported.Opcode != "" {
		event.Opcode = exported.Opcode
	}
	event.StreamID = exported.StreamID
	event.ConnectionID = exported.ConnectionID
	event.Transport = exported.Transport
	event.TransportMeta = exported.TransportMeta
	if exported.ReceivedAt > 0 {
		event.ReceivedAt = time.UnixMilli(exported.ReceivedAt).UTC().Format(time.RFC3339Nano)
	}
	return event, nil
}

func importPayload(exported wiretapExportEvent) ([]byte, error) {
	if exported.RawBase64 != "" {
		payload, err := base64.StdEncoding.DecodeString(exported.RawBase64)
		if err != nil {
			return nil, err
		}
		return payload, nil
	}
	if exported.Raw != "" {
		return []byte(exported.Raw), nil
	}
	if exported.Parsed != nil {
		payload, err := json.Marshal(exported.Parsed)
		if err != nil {
			return nil, err
		}
		return payload, nil
	}
	return nil, fmt.Errorf("event has no raw, rawBase64, or parsed payload")
}

func importOpcode(exported wiretapExportEvent) byte {
	switch exported.Opcode {
	case "binary":
		return 0x2
	default:
		return 0x1
	}
}

func (a *agent) importJSONLEvents(events []captureEvent, targetURL string) (importJSONLResult, error) {
	if a.recorder == nil {
		return importJSONLResult{}, fmt.Errorf("capture database is not configured")
	}

	session, err := a.recorder.createSession(targetURL)
	if err != nil {
		return importJSONLResult{}, err
	}

	a.mu.Lock()
	a.events = nil
	a.topics = newTopicTracker()
	a.sequences = newSequenceTracker()
	a.eventCount = 0
	a.issueCount = 0
	a.nextCaptureSeq = 0
	a.connectionID = "import-" + session.ID
	a.connectedAt = nil
	a.state = stateReady
	a.lastError = ""
	a.activeConfig = nil
	a.session = nil
	a.streams = make(map[string]*streamRuntime)
	a.lastStatsSentAt = time.Time{}
	a.mu.Unlock()

	for _, event := range events {
		a.recordEventForStream(event.StreamID, event)
	}

	result := importJSONLResult{
		Session:        a.recorder.currentSession(),
		Events:         a.stats().Events,
		Issues:         a.stats().Issues,
		RetainedEvents: len(a.eventSnapshot()),
	}
	a.broadcast(agentMessage{Type: "agent.ready", Payload: a.status()})
	a.broadcast(agentMessage{Type: "capture.snapshot", Payload: a.eventSnapshot()})
	a.broadcast(agentMessage{Type: "topic.snapshot", Payload: a.topicSnapshot()})
	a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
	return result, nil
}

func (a *agent) stopAllConnections(state agentState, lastError string) {
	var sessions []*upstreamSession

	a.mu.Lock()
	a.ensureStreamsLocked()
	for _, stream := range a.streams {
		if stream.Session != nil {
			sessions = append(sessions, stream.Session)
			stream.Session = nil
		}
		stream.State = state
		stream.LastError = lastError
		stream.ConnectedAt = nil
		stream.ConnectedAtText = ""
	}
	a.refreshAggregateConnectionStateLocked()
	a.mu.Unlock()

	for _, session := range sessions {
		session.cancel()
		<-session.done
	}

	a.broadcast(agentMessage{Type: "agent.ready", Payload: a.status()})
	a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
}
