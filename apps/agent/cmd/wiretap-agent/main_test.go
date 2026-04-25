package main

import (
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
