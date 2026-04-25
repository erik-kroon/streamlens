package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestNormalizeCaptureParsesWiretapEnvelope(t *testing.T) {
	event := normalizeCapture(upstreamFrame{
		opcode:    0x1,
		payload:   []byte(`{"topic":"market.AAPL","type":"trade_print","seq":42,"ts":"2026-04-25T11:00:00Z","symbol":"AAPL","payload":{"price":150.26}}`),
		sizeBytes: 130,
	})

	if event.Topic != "market.AAPL" {
		t.Fatalf("expected topic market.AAPL, got %q", event.Topic)
	}
	if event.Type != "trade_print" {
		t.Fatalf("expected type trade_print, got %q", event.Type)
	}
	if event.Seq == nil || *event.Seq != 42 {
		t.Fatalf("expected seq 42, got %#v", event.Seq)
	}
	if event.EffectiveKey != "AAPL" {
		t.Fatalf("expected symbol fallback effective key AAPL, got %q", event.EffectiveKey)
	}
	if event.DisplayTopic != "market.AAPL" || event.DisplayType != "trade_print" {
		t.Fatalf("expected display values from envelope, got topic=%q type=%q", event.DisplayTopic, event.DisplayType)
	}
	if event.SourceTS != "2026-04-25T11:00:00Z" {
		t.Fatalf("expected source timestamp to be retained, got %#v", event.SourceTS)
	}
	if len(event.Statuses) != 1 || event.Statuses[0] != "ok" {
		t.Fatalf("expected ok status, got %#v", event.Statuses)
	}
	if len(event.Issues) != 0 {
		t.Fatalf("expected no issues, got %#v", event.Issues)
	}
}

func TestNormalizeCapturePreservesMalformedJSON(t *testing.T) {
	event := normalizeCapture(upstreamFrame{
		opcode:    0x1,
		payload:   []byte(`{"topic":"market.AAPL"`),
		sizeBytes: 22,
	})

	if event.Raw == "" {
		t.Fatal("expected malformed raw payload to be preserved")
	}
	if event.ParseError == "" {
		t.Fatal("expected parse error to be retained")
	}
	if len(event.Issues) != 1 || event.Issues[0].Code != "parse_error" {
		t.Fatalf("expected parse_error issue, got %#v", event.Issues)
	}
	if len(event.Statuses) != 1 || event.Statuses[0] != "parse_error" {
		t.Fatalf("expected parse_error status, got %#v", event.Statuses)
	}
}

func TestNormalizeCapturePreservesBinaryAsBase64(t *testing.T) {
	event := normalizeCapture(upstreamFrame{
		opcode:    0x2,
		payload:   []byte{0xff, 0x00, 0x01},
		sizeBytes: 3,
	})

	if event.RawBase64 == "" {
		t.Fatal("expected binary payload to be base64 encoded")
	}
	if len(event.Issues) != 1 || event.Issues[0].Code != "binary_message" {
		t.Fatalf("expected binary_message issue, got %#v", event.Issues)
	}
}

func TestNormalizeCaptureMarksOversizedPreview(t *testing.T) {
	event := normalizeCapture(upstreamFrame{
		opcode:    0x1,
		payload:   []byte(strings.Repeat("x", 64)),
		sizeBytes: maxRawMessageBytes + 1,
		oversized: true,
	})

	if !event.Oversized || !event.Truncated {
		t.Fatalf("expected oversized truncated event, got oversized=%v truncated=%v", event.Oversized, event.Truncated)
	}
	if !event.RawTruncated {
		t.Fatal("expected rawTruncated to be true")
	}
	if event.OriginalSizeBytes != maxRawMessageBytes+1 || event.SizeBytes != 64 {
		t.Fatalf("expected original and retained byte counts, got original=%d size=%d", event.OriginalSizeBytes, event.SizeBytes)
	}
	if len(event.Issues) != 1 || event.Issues[0].Code != "oversized" {
		t.Fatalf("expected oversized issue, got %#v", event.Issues)
	}
	if len(event.Statuses) != 1 || event.Statuses[0] != "oversized" {
		t.Fatalf("expected oversized status, got %#v", event.Statuses)
	}
}

func TestNormalizeCaptureReportsSchemaErrorsAndDefaultsDisplayFields(t *testing.T) {
	event := normalizeCapture(upstreamFrame{
		opcode:    0x1,
		payload:   []byte(`{"topic":12,"type":"","seq":"42","key":17,"ts":true}`),
		sizeBytes: 55,
	})

	if event.DisplayTopic != "unknown" {
		t.Fatalf("expected unknown display topic, got %q", event.DisplayTopic)
	}
	if event.DisplayType != "message" {
		t.Fatalf("expected message display type, got %q", event.DisplayType)
	}
	if event.Envelope == nil {
		t.Fatal("expected invalid envelope to still be retained")
	}
	if !containsStatus(event.Statuses, "schema_error") {
		t.Fatalf("expected schema_error status, got %#v", event.Statuses)
	}
	if countIssueCode(event.Issues, "schema_error") != 5 {
		t.Fatalf("expected five schema errors, got %#v", event.Issues)
	}
}

func TestRecordEventAssignsRetainedIdentityAndRingBuffer(t *testing.T) {
	agent := &agent{connectionID: "conn-test", startedAt: timeNowForTest()}
	for i := 0; i < maxBufferedEvents+2; i++ {
		agent.recordEvent(captureEvent{
			ReceivedAt:        "2026-04-25T11:00:00Z",
			Direction:         "inbound",
			Opcode:            "text",
			OriginalSizeBytes: 2,
			SizeBytes:         2,
			DisplayTopic:      "unknown",
			DisplayType:       "message",
			Statuses:          []string{"ok"},
		})
	}

	events := agent.eventSnapshot()
	if len(events) != maxBufferedEvents {
		t.Fatalf("expected ring buffer length %d, got %d", maxBufferedEvents, len(events))
	}
	if events[0].CaptureSeq != 3 {
		t.Fatalf("expected oldest retained capture sequence 3, got %d", events[0].CaptureSeq)
	}
	last := events[len(events)-1]
	if last.ConnectionID != "conn-test" || last.ID != "conn-test:10002" {
		t.Fatalf("expected retained identity on latest event, got id=%q connection=%q", last.ID, last.ConnectionID)
	}

	stats := agent.stats()
	if stats.Events != maxBufferedEvents+2 || stats.RetainedEvents != maxBufferedEvents || stats.DroppedEvents != 2 {
		t.Fatalf("expected stats to report total, retained, and dropped events under load, got %#v", stats)
	}
	if stats.BufferCapacity != maxBufferedEvents {
		t.Fatalf("expected buffer capacity %d, got %d", maxBufferedEvents, stats.BufferCapacity)
	}
}

func TestDemoBurstScenarioPayloadAndCadence(t *testing.T) {
	perBatch := burstEventsPerSecond / int(time.Second/burstBatchInterval)
	totalEvents := burstEventsPerSecond * int(burstDuration/time.Second)
	if perBatch != 10 || totalEvents != 10_000 {
		t.Fatalf("expected burst to send 10 events per 10ms and 10000 total events, got perBatch=%d total=%d", perBatch, totalEvents)
	}

	payload := string(demoEventPayload("burst", 42, mustParseTimeForTest("2026-04-25T11:00:00Z")))
	for _, expected := range []string{`"topic":"market.burst"`, `"type":"quote"`, `"seq":42`, `"symbol":"BURST"`, `"scenario":"burst"`} {
		if !strings.Contains(payload, expected) {
			t.Fatalf("expected burst payload to contain %s, got %s", expected, payload)
		}
	}
}

func TestDemoIssueScenariosEmitDeterministicIssues(t *testing.T) {
	cases := map[string]string{
		"gap":          "gap",
		"duplicate":    "duplicate",
		"out_of_order": "out_of_order",
	}

	for scenario, issueCode := range cases {
		t.Run(scenario, func(t *testing.T) {
			agent := &agent{connectionID: "conn-test", startedAt: timeNowForTest()}
			for frameIndex := int64(1); frameIndex <= 6; frameIndex++ {
				payload := demoScenarioPayload(scenario, frameIndex, mustParseTimeForTest("2026-04-25T11:00:00Z"))
				event := normalizeCapture(upstreamFrame{
					opcode:    0x1,
					payload:   payload,
					sizeBytes: int64(len(payload)),
				})
				agent.recordEvent(event)
			}

			events := agent.eventSnapshot()
			found := false
			for _, event := range events {
				if countIssueCode(event.Issues, issueCode) > 0 {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("expected demo scenario %q to emit %q issue, got %#v", scenario, issueCode, events)
			}
		})
	}
}

func TestDemoMalformedAndOversizedScenariosNormalizeAsIssues(t *testing.T) {
	malformedPayload := demoScenarioPayload("malformed", 1, mustParseTimeForTest("2026-04-25T11:00:00Z"))
	malformed := normalizeCapture(upstreamFrame{
		opcode:    0x1,
		payload:   malformedPayload,
		sizeBytes: int64(len(malformedPayload)),
	})
	if countIssueCode(malformed.Issues, "parse_error") != 1 {
		t.Fatalf("expected malformed demo payload to produce parse_error, got %#v", malformed.Issues)
	}

	oversizedPayload := demoScenarioPayload("oversized", 1, mustParseTimeForTest("2026-04-25T11:00:00Z"))
	if len(oversizedPayload) <= maxRawMessageBytes {
		t.Fatalf("expected oversized demo payload to exceed %d bytes, got %d", maxRawMessageBytes, len(oversizedPayload))
	}
	oversized := normalizeCapture(upstreamFrame{
		opcode:    0x1,
		payload:   oversizedPayload[:rawPreviewBytes],
		sizeBytes: int64(len(oversizedPayload)),
		oversized: true,
	})
	if countIssueCode(oversized.Issues, "oversized") != 1 || !oversized.RawTruncated {
		t.Fatalf("expected oversized demo payload to produce oversized issue, got %#v", oversized)
	}
}

func TestExportSnapshotWritesStableRetainedCaptureFormat(t *testing.T) {
	agent := &agent{connectionID: "conn-test", startedAt: timeNowForTest()}
	first := normalizedEnvelopeForTest("market.AAPL", "AAPL", 7)
	first.ReceivedAt = "2026-04-25T11:00:00.123Z"
	agent.recordEvent(first)

	second := normalizeCapture(upstreamFrame{
		opcode:    0x1,
		payload:   []byte(strings.Repeat("x", 64)),
		sizeBytes: maxRawMessageBytes + 1,
		oversized: true,
	})
	second.ReceivedAt = "2026-04-25T11:00:01Z"
	agent.recordEvent(second)

	events := agent.exportSnapshot()
	if len(events) != 2 {
		t.Fatalf("expected two exported events, got %#v", events)
	}
	if events[0].CaptureSeq != 1 || events[0].ConnectionID != "conn-test" {
		t.Fatalf("expected retained identity in export, got %#v", events[0])
	}
	if events[0].ReceivedAt != 1777114800123 {
		t.Fatalf("expected receivedAt unix milliseconds, got %d", events[0].ReceivedAt)
	}
	if events[0].Parsed == nil || events[0].Parsed.Topic != "market.AAPL" || events[0].Parsed.Seq == nil || *events[0].Parsed.Seq != 7 {
		t.Fatalf("expected parsed envelope in export, got %#v", events[0].Parsed)
	}
	if events[1].Parsed != nil {
		t.Fatalf("expected oversized preview to omit parsed envelope, got %#v", events[1].Parsed)
	}
	if !events[1].RawTruncated || !events[1].Truncated || !events[1].Oversized {
		t.Fatalf("expected truncation metadata in export, got %#v", events[1])
	}
	if events[1].OriginalSizeBytes != maxRawMessageBytes+1 || events[1].SizeBytes != 64 {
		t.Fatalf("expected retained byte counts in export, got %#v", events[1])
	}
}

func TestHandleExportJSONLWritesOneJSONEventPerLine(t *testing.T) {
	agent := &agent{connectionID: "conn-test", startedAt: timeNowForTest()}
	event := normalizedEnvelopeForTest("market.AAPL", "AAPL", 1)
	event.ReceivedAt = "2026-04-25T11:00:00Z"
	agent.recordEvent(event)

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/export/jsonl", nil)
	agent.handleExportJSONL(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", response.Code)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/x-ndjson" {
		t.Fatalf("expected jsonl content type, got %q", contentType)
	}
	if disposition := response.Header().Get("Content-Disposition"); !strings.Contains(disposition, ".jsonl") {
		t.Fatalf("expected jsonl attachment disposition, got %q", disposition)
	}

	lines := strings.Split(strings.TrimSpace(response.Body.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected one jsonl line, got %d: %q", len(lines), response.Body.String())
	}

	var exported wiretapExportEvent
	if err := json.Unmarshal([]byte(lines[0]), &exported); err != nil {
		t.Fatalf("expected valid json line: %v", err)
	}
	if exported.CaptureSeq != 1 || exported.Raw == "" || exported.Parsed == nil {
		t.Fatalf("expected retained event export, got %#v", exported)
	}
}

func TestCaptureStoreRestoresCurrentSessionAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	first := newStoredAgentForTest(t, dir)
	first.connectionID = "conn-test"

	event := normalizedEnvelopeForTest("market.AAPL", "AAPL", 1)
	event.ReceivedAt = "2026-04-25T11:00:00Z"
	first.recordEvent(event)
	first.evaluateStaleTopics(mustParseTimeForTest("2026-04-25T11:00:01.500Z"))

	restarted := newStoredAgentForTest(t, dir)
	events := restarted.eventSnapshot()
	if len(events) != 1 {
		t.Fatalf("expected restored retained event, got %#v", events)
	}
	if events[0].ID != "conn-test:1" || events[0].CaptureSeq != 1 {
		t.Fatalf("expected restored event identity, got %#v", events[0])
	}
	if restarted.stats().Events != 1 || restarted.stats().Issues != 1 {
		t.Fatalf("expected restored session counters, got %#v", restarted.stats())
	}

	topics := restarted.topicSnapshot()
	if len(topics) != 1 || !topics[0].Stale || topics[0].StaleCount != 1 {
		t.Fatalf("expected restored topic snapshot with stale state, got %#v", topics)
	}

	next := normalizedEnvelopeForTest("market.AAPL", "AAPL", 2)
	next.ReceivedAt = "2026-04-25T11:00:02Z"
	restarted.connectionID = "conn-test"
	restarted.recordEvent(next)
	events = restarted.eventSnapshot()
	if events[1].CaptureSeq != 2 || len(events[1].Issues) != 0 {
		t.Fatalf("expected restored sequence tracker to continue cleanly, got %#v", events[1])
	}
}

func TestHandleCurrentSessionEventsReturnsPagedPersistedEvents(t *testing.T) {
	agent := newStoredAgentForTest(t, t.TempDir())
	agent.connectionID = "conn-test"
	for seq := int64(1); seq <= 3; seq++ {
		event := normalizedEnvelopeForTest("market.AAPL", "AAPL", seq)
		event.ReceivedAt = "2026-04-25T11:00:00Z"
		agent.recordEvent(event)
	}

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/sessions/current/events?offset=1&limit=1", nil)
	agent.handleCurrentSessionEvents(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", response.Code)
	}
	var page captureEventPage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatalf("expected valid page response: %v", err)
	}
	if page.Total != 3 || page.Offset != 1 || page.Limit != 1 || len(page.Events) != 1 {
		t.Fatalf("expected one event page out of three events, got %#v", page)
	}
	if page.Events[0].CaptureSeq != 2 {
		t.Fatalf("expected second capture event, got %#v", page.Events[0])
	}
}

func TestRecordEventDetectsSequenceGapDuplicateAndOutOfOrder(t *testing.T) {
	agent := &agent{connectionID: "conn-test", startedAt: timeNowForTest()}
	for _, seq := range []int64{1, 3, 3, 2} {
		agent.recordEvent(normalizedEnvelopeForTest("market.AAPL", "AAPL", seq))
	}

	events := agent.eventSnapshot()
	if len(events) != 4 {
		t.Fatalf("expected four events, got %d", len(events))
	}
	if countIssueCode(events[0].Issues, "gap") != 0 || !containsStatus(events[0].Statuses, "ok") {
		t.Fatalf("expected first event to be clean, got issues=%#v statuses=%#v", events[0].Issues, events[0].Statuses)
	}
	if countIssueCode(events[1].Issues, "gap") != 1 || !containsStatus(events[1].Statuses, "gap") {
		t.Fatalf("expected seq 3 to reveal a gap, got issues=%#v statuses=%#v", events[1].Issues, events[1].Statuses)
	}
	if events[1].Issues[0].Details["expected"] != int64(2) || events[1].Issues[0].Details["actual"] != int64(3) {
		t.Fatalf("expected gap details to include expected 2 and actual 3, got %#v", events[1].Issues[0].Details)
	}
	if countIssueCode(events[2].Issues, "duplicate") != 1 || !containsStatus(events[2].Statuses, "duplicate") {
		t.Fatalf("expected repeated seq 3 to be duplicate, got issues=%#v statuses=%#v", events[2].Issues, events[2].Statuses)
	}
	if countIssueCode(events[3].Issues, "out_of_order") != 1 || !containsStatus(events[3].Statuses, "out_of_order") {
		t.Fatalf("expected seq 2 after 3 to be out of order, got issues=%#v statuses=%#v", events[3].Issues, events[3].Statuses)
	}
	if agent.stats().Issues != 3 {
		t.Fatalf("expected three detected issues, got %d", agent.stats().Issues)
	}
	topics := agent.topicSnapshot()
	if len(topics) != 1 {
		t.Fatalf("expected one topic/key aggregate, got %#v", topics)
	}
	if topics[0].GapCount != 1 || topics[0].DuplicateCount != 1 || topics[0].OutOfOrderCount != 1 {
		t.Fatalf("expected topic counters to reflect sequence issues, got %#v", topics[0])
	}
	if topics[0].LastSeq == nil || *topics[0].LastSeq != 2 {
		t.Fatalf("expected topic last sequence 2, got %#v", topics[0].LastSeq)
	}
}

func TestRecordEventScopesSequenceByTopicAndEffectiveKey(t *testing.T) {
	agent := &agent{connectionID: "conn-test", startedAt: timeNowForTest()}
	agent.recordEvent(normalizedEnvelopeForTest("market.quote", "AAPL", 1))
	agent.recordEvent(normalizedEnvelopeForTest("market.quote", "MSFT", 1))
	agent.recordEvent(normalizedEnvelopeForTest("market.quote", "AAPL", 2))

	for _, event := range agent.eventSnapshot() {
		if len(event.Issues) != 0 {
			t.Fatalf("expected independent topic/key sequence scopes, got event %#v", event)
		}
	}
}

func TestEvaluateStaleTopicsTransitionsWithoutNewEvents(t *testing.T) {
	agent := &agent{connectionID: "conn-test", startedAt: timeNowForTest()}
	event := normalizedEnvelopeForTest("market.quote", "AAPL", 1)
	event.ReceivedAt = "2026-04-25T11:00:00Z"
	agent.recordEvent(event)

	changes := agent.evaluateStaleTopics(mustParseTimeForTest("2026-04-25T11:00:01.500Z"))
	if len(changes) != 1 {
		t.Fatalf("expected one stale transition, got %#v", changes)
	}
	if !changes[0].Stale || changes[0].StaleCount != 1 || changes[0].IssueCount != 1 {
		t.Fatalf("expected stale issue on market topic/key, got %#v", changes[0])
	}
	if changes[0].StaleThresholdMs == nil || *changes[0].StaleThresholdMs != 1000 {
		t.Fatalf("expected default market stale threshold, got %#v", changes[0].StaleThresholdMs)
	}
	if agent.stats().Issues != 1 {
		t.Fatalf("expected stale transition to increment stats issues, got %d", agent.stats().Issues)
	}

	repeated := agent.evaluateStaleTopics(mustParseTimeForTest("2026-04-25T11:00:02Z"))
	if len(repeated) != 0 || agent.stats().Issues != 1 {
		t.Fatalf("expected no duplicate stale issue, changes=%#v issues=%d", repeated, agent.stats().Issues)
	}

	fresh := normalizedEnvelopeForTest("market.quote", "AAPL", 2)
	fresh.ReceivedAt = "2026-04-25T11:00:02.100Z"
	agent.recordEvent(fresh)
	topics := agent.topicSnapshot()
	if len(topics) != 1 {
		t.Fatalf("expected one topic, got %#v", topics)
	}
	if topics[0].Stale || topics[0].StaleSince != "" {
		t.Fatalf("expected fresh event to clear stale state, got %#v", topics[0])
	}
	if topics[0].StaleCount != 1 || topics[0].IssueCount != 1 {
		t.Fatalf("expected stale issue count to remain cumulative, got %#v", topics[0])
	}
}

func normalizedEnvelopeForTest(topic string, symbol string, seq int64) captureEvent {
	return normalizeCapture(upstreamFrame{
		opcode:    0x1,
		payload:   []byte(`{"topic":"` + topic + `","type":"trade_print","seq":` + strconv.FormatInt(seq, 10) + `,"symbol":"` + symbol + `","payload":{}}`),
		sizeBytes: 96,
	})
}

func containsStatus(statuses []string, expected string) bool {
	for _, status := range statuses {
		if status == expected {
			return true
		}
	}
	return false
}

func countIssueCode(issues []captureIssue, code string) int {
	count := 0
	for _, issue := range issues {
		if issue.Code == code {
			count++
		}
	}
	return count
}

func timeNowForTest() time.Time {
	return time.Unix(0, 0).UTC()
}

func mustParseTimeForTest(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		panic(err)
	}
	return parsed
}

func newStoredAgentForTest(t *testing.T, dir string) *agent {
	t.Helper()

	store, err := openCaptureStore(dir)
	if err != nil {
		t.Fatalf("failed to open capture store: %v", err)
	}
	snapshot, err := store.loadOrCreateCurrentSession()
	if err != nil {
		t.Fatalf("failed to load current capture session: %v", err)
	}
	agent := &agent{
		id:             "wiretap-local-agent",
		version:        "test",
		startedAt:      timeNowForTest(),
		state:          stateReady,
		eventCount:     snapshot.Session.EventCount,
		issueCount:     snapshot.Session.IssueCount,
		nextCaptureSeq: latestCaptureSeq(snapshot.Events),
		events:         snapshot.Events,
		topics:         newTopicTrackerFromSnapshot(snapshot.Topics),
		sequences:      newSequenceTracker(),
		recorder:       newCaptureRecorder(store, snapshot.Session),
		subscribers:    make(map[*liveClient]struct{}),
	}
	agent.rebuildSequenceTrackerFromEvents()
	return agent
}
