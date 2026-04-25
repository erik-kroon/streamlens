package main

import (
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
