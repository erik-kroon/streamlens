package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

const tapeSessionSchemaVersion = 1

type tapeExportRecord struct {
	Meta    *tapeExportMetadata    `json:"meta,omitempty"`
	Type    string                 `json:"type,omitempty"`
	Payload map[string]interface{} `json:"payload,omitempty"`
	Index   *int                   `json:"index,omitempty"`
}

type tapeExportMetadata struct {
	SchemaVersion       int                  `json:"schema_version"`
	SourceInfo          tapeExportSourceInfo `json:"source_info"`
	SymbolUniverse      []string             `json:"symbol_universe"`
	EventFamilies       []string             `json:"event_families"`
	TimezoneAssumptions []string             `json:"timezone_assumptions"`
}

type tapeExportSourceInfo struct {
	Sources []tapeExportSource `json:"sources"`
}

type tapeExportSource struct {
	Path   string `json:"path"`
	Format string `json:"format"`
}

func (a *agent) handleExportTape(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}

	var session captureSession
	if a.recorder != nil {
		session = a.recorder.currentSession()
	}
	writeTapeHTTP(w, session, a.eventSnapshot(), exportTapeFilename(time.Now().UTC()), "current")
}

func (a *agent) handleExportSessionTape(w http.ResponseWriter, sessionID string) {
	session, err := a.recorder.store.readSession(sessionID)
	if err != nil {
		writeSessionStoreError(w, err)
		return
	}
	events, err := a.recorder.store.readAllEvents(sessionID)
	if err != nil {
		writeHTTPError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeTapeHTTP(w, session, events, exportSessionTapeFilename(session), sessionID)
}

func writeTapeHTTP(w http.ResponseWriter, session captureSession, events []captureEvent, filename string, logSession string) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	if err := writeTapeExport(w, session, events); err != nil {
		slog.Error("failed to write tape export", "session", logSession, "error", err)
	}
}

func writeTapeExport(writer io.Writer, session captureSession, events []captureEvent) error {
	encoder := json.NewEncoder(writer)
	if err := encoder.Encode(tapeMetadataRecord(session, events)); err != nil {
		return err
	}
	for index, event := range events {
		if err := encoder.Encode(tapeEventRecord(event, index)); err != nil {
			return err
		}
	}
	return nil
}

func tapeMetadataRecord(session captureSession, events []captureEvent) tapeExportRecord {
	symbols := map[string]struct{}{}
	families := map[string]struct{}{}
	for index, event := range events {
		record := tapeEventRecord(event, index)
		families[record.Type] = struct{}{}
		if symbol, ok := record.Payload["symbol"].(string); ok && strings.TrimSpace(symbol) != "" {
			symbols[symbol] = struct{}{}
		}
	}

	sources := []tapeExportSource{}
	if session.TargetURL != "" {
		sources = append(sources, tapeExportSource{Path: session.TargetURL, Format: "streamlens"})
	}

	return tapeExportRecord{
		Meta: &tapeExportMetadata{
			SchemaVersion: tapeSessionSchemaVersion,
			SourceInfo: tapeExportSourceInfo{
				Sources: sources,
			},
			SymbolUniverse:      sortedStringSet(symbols),
			EventFamilies:       sortedStringSet(families),
			TimezoneAssumptions: []string{"StreamLens sourceTs is used when parseable; receivedAt is used otherwise"},
		},
	}
}

func tapeEventRecord(event captureEvent, index int) tapeExportRecord {
	eventType := "tick"
	payload := tapeTickPayload(event)
	if isTapeBarEvent(event) {
		eventType = "bar"
		payload = tapeBarPayload(event)
	}

	payload["streamlens"] = streamlensTapeMetadata(event)
	return tapeExportRecord{
		Type:    eventType,
		Payload: payload,
		Index:   &index,
	}
}

func tapeTickPayload(event captureEvent) map[string]interface{} {
	values := envelopePayloadMap(event)
	return map[string]interface{}{
		"time":   tapeEventTimestamp(event).UTC().Format(time.RFC3339Nano),
		"symbol": tapeEventSymbol(event, values),
		"price":  numericField(values, 0, "price", "last", "bid", "ask"),
		"size":   numericField(values, 0, "size", "qty", "quantity", "volume"),
		"seq":    tapeEventSequence(event),
	}
}

func tapeBarPayload(event captureEvent) map[string]interface{} {
	values := envelopePayloadMap(event)
	return map[string]interface{}{
		"time":   tapeEventTimestamp(event).UTC().Format(time.RFC3339Nano),
		"symbol": tapeEventSymbol(event, values),
		"open":   numericField(values, 0, "open"),
		"high":   numericField(values, 0, "high"),
		"low":    numericField(values, 0, "low"),
		"close":  numericField(values, 0, "close"),
		"volume": numericField(values, 0, "volume", "size", "qty", "quantity"),
		"seq":    tapeEventSequence(event),
	}
}

func isTapeBarEvent(event captureEvent) bool {
	values := envelopePayloadMap(event)
	return hasNumericField(values, "open") &&
		hasNumericField(values, "high") &&
		hasNumericField(values, "low") &&
		hasNumericField(values, "close")
}

func envelopePayloadMap(event captureEvent) map[string]interface{} {
	values := map[string]interface{}{}
	if event.Envelope == nil {
		return values
	}

	if payload, ok := event.Envelope.Payload.(map[string]interface{}); ok {
		for key, value := range payload {
			values[key] = value
		}
	}
	return values
}

func tapeEventSymbol(event captureEvent, values map[string]interface{}) string {
	if event.Envelope != nil {
		if symbol := strings.TrimSpace(event.Envelope.Symbol); symbol != "" {
			return symbol
		}
	}
	for _, key := range []string{"symbol", "ticker", "instrument"} {
		if value := stringField(values, key); value != "" {
			return value
		}
	}
	for _, value := range []string{event.EffectiveKey, event.Key, event.Topic} {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func tapeEventSequence(event captureEvent) int64 {
	if event.Seq != nil {
		return *event.Seq
	}
	return event.CaptureSeq
}

func tapeEventTimestamp(event captureEvent) time.Time {
	if parsed, ok := parseTapeTimestamp(event.SourceTS); ok {
		return parsed
	}
	if parsed, err := time.Parse(time.RFC3339Nano, event.ReceivedAt); err == nil {
		return parsed
	}
	return time.Unix(0, 0).UTC()
}

func parseTapeTimestamp(value interface{}) (time.Time, bool) {
	switch typed := value.(type) {
	case string:
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05.999999999", "2006-01-02 15:04:05"} {
			if parsed, err := time.Parse(layout, typed); err == nil {
				return parsed, true
			}
		}
	case float64:
		return time.UnixMilli(int64(typed)).UTC(), true
	case int64:
		return time.UnixMilli(typed).UTC(), true
	case int:
		return time.UnixMilli(int64(typed)).UTC(), true
	case json.Number:
		if value, err := typed.Int64(); err == nil {
			return time.UnixMilli(value).UTC(), true
		}
	}
	return time.Time{}, false
}

func hasNumericField(values map[string]interface{}, key string) bool {
	_, ok := numberValue(values[key])
	return ok
}

func numericField(values map[string]interface{}, fallback float64, keys ...string) float64 {
	for _, key := range keys {
		if value, ok := numberValue(values[key]); ok {
			return value
		}
	}
	return fallback
}

func numberValue(value interface{}) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func stringField(values map[string]interface{}, key string) string {
	value, ok := values[key]
	if !ok {
		return ""
	}
	if typed, ok := value.(string); ok {
		return strings.TrimSpace(typed)
	}
	return ""
}

func streamlensTapeMetadata(event captureEvent) map[string]interface{} {
	metadata := map[string]interface{}{
		"captureSeq":        event.CaptureSeq,
		"streamId":          event.StreamID,
		"connectionId":      event.ConnectionID,
		"receivedAt":        event.ReceivedAt,
		"direction":         event.Direction,
		"opcode":            event.Opcode,
		"topic":             event.Topic,
		"displayTopic":      event.DisplayTopic,
		"eventType":         event.Type,
		"displayType":       event.DisplayType,
		"key":               event.Key,
		"effectiveKey":      event.EffectiveKey,
		"sourceTs":          event.SourceTS,
		"statuses":          event.Statuses,
		"issues":            event.Issues,
		"parseError":        event.ParseError,
		"raw":               event.Raw,
		"rawBase64":         event.RawBase64,
		"rawTruncated":      event.RawTruncated,
		"truncated":         event.Truncated,
		"oversized":         event.Oversized,
		"originalSizeBytes": event.OriginalSizeBytes,
		"sizeBytes":         event.SizeBytes,
	}
	if event.Envelope != nil {
		metadata["envelope"] = event.Envelope
	}
	return metadata
}

func sortedStringSet(values map[string]struct{}) []string {
	items := make([]string, 0, len(values))
	for value := range values {
		items = append(items, value)
	}
	sort.Strings(items)
	return items
}

func exportTapeFilename(now time.Time) string {
	return "streamlens-capture-" + now.Format("20060102T150405Z") + ".tape"
}

func exportSessionTapeFilename(session captureSession) string {
	id := strings.TrimSpace(session.ID)
	if id == "" {
		id = "session"
	}
	return fmt.Sprintf("streamlens-%s.tape", id)
}
