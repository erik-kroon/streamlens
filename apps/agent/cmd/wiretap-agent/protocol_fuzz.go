package main

import (
	"encoding/json"
	"fmt"
	mrand "math/rand"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	defaultFuzzCount    = 24
	maxFuzzCount        = 512
	defaultFuzzMaxBytes = 4096
	minFuzzMaxBytes     = 128
	maxFuzzMaxBytes     = rawPreviewBytes
	defaultFuzzSeed     = int64(1)
)

type fuzzRequest struct {
	StreamID  string `json:"streamId,omitempty"`
	Transport string `json:"transport,omitempty"`
	Mode      string `json:"mode,omitempty"`
	Seed      int64  `json:"seed,omitempty"`
	Count     int    `json:"count,omitempty"`
	MaxBytes  int    `json:"maxBytes,omitempty"`
}

type fuzzConfig struct {
	StreamID  string `json:"streamId"`
	Transport string `json:"transport"`
	Mode      string `json:"mode"`
	Seed      int64  `json:"seed"`
	Count     int    `json:"count"`
	MaxBytes  int    `json:"maxBytes"`
}

type fuzzResult struct {
	StreamID  string            `json:"streamId"`
	Transport string            `json:"transport"`
	Mode      string            `json:"mode"`
	Seed      int64             `json:"seed"`
	Count     int               `json:"count"`
	MaxBytes  int               `json:"maxBytes"`
	Events    []fuzzEventResult `json:"events"`
	Summary   fuzzSummary       `json:"summary"`
}

type fuzzSummary struct {
	Generated int            `json:"generated"`
	Issues    int            `json:"issues"`
	ByStatus  map[string]int `json:"byStatus"`
	ByIssue   map[string]int `json:"byIssue"`
}

type fuzzEventResult struct {
	ID         string   `json:"id"`
	CaptureSeq int64    `json:"captureSeq"`
	Case       string   `json:"case"`
	Mode       string   `json:"mode"`
	Opcode     string   `json:"opcode"`
	SizeBytes  int64    `json:"sizeBytes"`
	Statuses   []string `json:"statuses"`
	Issues     []string `json:"issues,omitempty"`
}

type fuzzInput struct {
	Name          string
	Mode          string
	Opcode        byte
	Payload       []byte
	SizeBytes     int64
	Oversized     bool
	TransportMeta map[string]string
}

func (a *agent) handleFuzz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}

	request := fuzzRequest{}
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeHTTPError(w, http.StatusBadRequest, "invalid fuzz payload")
			return
		}
	}

	config, err := normalizeFuzzRequest(request)
	if err != nil {
		writeHTTPError(w, http.StatusBadRequest, err.Error())
		return
	}

	result := a.recordProtocolFuzz(config)
	writeJSON(w, http.StatusCreated, result)
}

func (a *agent) handleFuzzFixtures(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}

	config, err := fuzzConfigFromQuery(r.URL.Query())
	if err != nil {
		writeHTTPError(w, http.StatusBadRequest, err.Error())
		return
	}

	events := buildProtocolFuzzEvents(config, a.currentExtractionRules())
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", fuzzFixtureFilename(config)))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	encoder := json.NewEncoder(w)
	for _, event := range events {
		if err := encoder.Encode(exportEvent(event)); err != nil {
			return
		}
	}
}

func (a *agent) recordProtocolFuzz(config fuzzConfig) fuzzResult {
	inputs := generateProtocolFuzzInputs(config)
	rules := a.currentExtractionRules()
	result := fuzzResult{
		StreamID:  config.StreamID,
		Transport: config.Transport,
		Mode:      config.Mode,
		Seed:      config.Seed,
		Count:     len(inputs),
		MaxBytes:  config.MaxBytes,
		Summary: fuzzSummary{
			ByStatus: map[string]int{},
			ByIssue:  map[string]int{},
		},
	}

	for index, input := range inputs {
		event := normalizeFuzzInput(input, rules, config, index)
		recorded := a.recordEventForStream(config.StreamID, event)
		result.Events = append(result.Events, fuzzEventResult{
			ID:         recorded.ID,
			CaptureSeq: recorded.CaptureSeq,
			Case:       input.Name,
			Mode:       input.Mode,
			Opcode:     recorded.Opcode,
			SizeBytes:  recorded.OriginalSizeBytes,
			Statuses:   append([]string(nil), recorded.Statuses...),
			Issues:     issueCodes(recorded.Issues),
		})
		accumulateFuzzSummary(&result.Summary, recorded)
	}
	result.Summary.Generated = len(result.Events)
	return result
}

func buildProtocolFuzzEvents(config fuzzConfig, rules extractionRules) []captureEvent {
	inputs := generateProtocolFuzzInputs(config)
	tracker := newSequenceTracker()
	events := make([]captureEvent, 0, len(inputs))
	connectionID := fmt.Sprintf("%s-fuzz-%d", config.StreamID, config.Seed)
	for index, input := range inputs {
		event := normalizeFuzzInput(input, rules, config, index)
		event.CaptureSeq = int64(index + 1)
		event.StreamID = config.StreamID
		event.ConnectionID = connectionID
		event.ID = fmt.Sprintf("%s:%d", connectionID, event.CaptureSeq)
		tracker.detect(&event)
		events = append(events, event)
	}
	return events
}

func normalizeFuzzInput(input fuzzInput, rules extractionRules, config fuzzConfig, index int) captureEvent {
	sizeBytes := input.SizeBytes
	if sizeBytes == 0 {
		sizeBytes = int64(len(input.Payload))
	}
	meta := copyStringMap(input.TransportMeta)
	if meta == nil {
		meta = map[string]string{}
	}
	meta["fuzzCase"] = input.Name
	meta["fuzzMode"] = input.Mode
	meta["fuzzSeed"] = strconv.FormatInt(config.Seed, 10)

	event := normalizeCaptureWithRules(upstreamFrame{
		opcode:        input.Opcode,
		payload:       input.Payload,
		sizeBytes:     sizeBytes,
		oversized:     input.Oversized,
		transport:     config.Transport,
		transportMeta: meta,
	}, rules)
	event.ReceivedAt = fuzzReceivedAt(config.Seed, index).Format(time.RFC3339Nano)
	return event
}

func generateProtocolFuzzInputs(config fuzzConfig) []fuzzInput {
	rng := mrand.New(mrand.NewSource(config.Seed))
	inputs := make([]fuzzInput, 0, config.Count)
	for index := 0; index < config.Count; index++ {
		switch config.Mode {
		case "schema":
			inputs = append(inputs, schemaFuzzInput(index, rng, config))
		case "raw":
			inputs = append(inputs, rawFuzzInput(index, rng, config))
		default:
			if index%2 == 0 {
				inputs = append(inputs, schemaFuzzInput(index/2, rng, config))
			} else {
				inputs = append(inputs, rawFuzzInput(index/2, rng, config))
			}
		}
	}
	return inputs
}

func schemaFuzzInput(index int, rng *mrand.Rand, config fuzzConfig) fuzzInput {
	seqPattern := []int64{1, 2, 5, 5, 4, 6, 7, 10}
	seq := seqPattern[index%len(seqPattern)] + int64(index/len(seqPattern))*10
	caseIndex := index % 8
	caseName := "schema-valid"
	var payload []byte

	switch caseIndex {
	case 0, 1, 2, 3, 4, 7:
		caseName = "schema-sequence-" + strconv.FormatInt(seq, 10)
		payload = mustMarshalFuzzJSON(map[string]interface{}{
			"topic":       "fuzz.schema",
			"type":        "quote",
			"seq":         seq,
			"ts":          fuzzReceivedAt(config.Seed, index).Format(time.RFC3339Nano),
			"symbol":      "FUZZ",
			"traceparent": fmt.Sprintf("00-%032x-%016x-01", uint64(config.Seed)+uint64(index)+1, uint64(seq)+1),
			"resource": map[string]interface{}{
				"service": map[string]interface{}{"name": "wiretap-fuzz"},
			},
			"payload": map[string]interface{}{
				"bid":      180 + rng.Float64(),
				"ask":      181 + rng.Float64(),
				"scenario": "protocol-fuzz",
				"seed":     config.Seed,
			},
		})
	case 5:
		caseName = "schema-wrong-field-types"
		payload = mustMarshalFuzzJSON(map[string]interface{}{
			"topic": 17,
			"type":  "",
			"seq":   "not-an-integer",
			"ts":    true,
			"symbol": map[string]interface{}{
				"bad": "key",
			},
			"payload": "not-an-object",
		})
	case 6:
		caseName = "schema-missing-required"
		payload = mustMarshalFuzzJSON(map[string]interface{}{
			"payload": map[string]interface{}{
				"seed": config.Seed,
				"blob": strings.Repeat("x", 16+rng.Intn(48)),
			},
		})
	}

	return boundedFuzzInput(fuzzInput{
		Name:    caseName,
		Mode:    "schema",
		Opcode:  0x1,
		Payload: payload,
	}, config.MaxBytes)
}

func rawFuzzInput(index int, rng *mrand.Rand, config fuzzConfig) fuzzInput {
	caseIndex := index % 7
	switch caseIndex {
	case 0:
		return fuzzInput{
			Name:    "raw-malformed-json",
			Mode:    "raw",
			Opcode:  0x1,
			Payload: []byte(`{"topic":"fuzz.raw","type":"quote","seq":` + strconv.Itoa(index+1)),
		}
	case 1:
		return boundedFuzzInput(fuzzInput{
			Name:    "raw-multiple-json-values",
			Mode:    "raw",
			Opcode:  0x1,
			Payload: []byte(`{"topic":"fuzz.raw","type":"quote","seq":1} {"topic":"fuzz.raw","type":"quote","seq":2}`),
		}, config.MaxBytes)
	case 2:
		return fuzzInput{
			Name:    "raw-non-object-json",
			Mode:    "raw",
			Opcode:  0x1,
			Payload: []byte(`["topic","fuzz.raw","type","quote"]`),
		}
	case 3:
		return fuzzInput{
			Name:    "raw-invalid-utf8-text",
			Mode:    "raw",
			Opcode:  0x1,
			Payload: []byte{0xff, 0xfe, byte(rng.Intn(255)), '{', '"', 'x'},
		}
	case 4:
		payload := make([]byte, 24+rng.Intn(24))
		_, _ = rng.Read(payload)
		return fuzzInput{
			Name:    "raw-binary-frame",
			Mode:    "raw",
			Opcode:  0x2,
			Payload: payload,
		}
	case 5:
		previewSize := config.MaxBytes
		if previewSize > rawPreviewBytes {
			previewSize = rawPreviewBytes
		}
		return fuzzInput{
			Name:      "raw-oversized-preview",
			Mode:      "raw",
			Opcode:    0x1,
			Payload:   []byte(strings.Repeat("x", previewSize)),
			SizeBytes: maxRawMessageBytes + 1 + int64(rng.Intn(4096)),
			Oversized: true,
		}
	default:
		return boundedFuzzInput(fuzzInput{
			Name:   "raw-control-character-string",
			Mode:   "raw",
			Opcode: 0x1,
			Payload: []byte(fmt.Sprintf(
				`{"topic":"fuzz.raw","type":"quote","seq":%d,"symbol":"FUZZ","payload":{"text":"line\u0000break","seed":%d}}`,
				index+1,
				config.Seed,
			)),
		}, config.MaxBytes)
	}
}

func normalizeFuzzRequest(request fuzzRequest) (fuzzConfig, error) {
	return normalizeFuzzConfig(fuzzConfig{
		StreamID:  request.StreamID,
		Transport: request.Transport,
		Mode:      request.Mode,
		Seed:      request.Seed,
		Count:     request.Count,
		MaxBytes:  request.MaxBytes,
	})
}

func fuzzConfigFromQuery(values url.Values) (fuzzConfig, error) {
	seed, err := parseInt64Query(values, "seed")
	if err != nil {
		return fuzzConfig{}, err
	}
	count, err := parseIntQuery(values, "count")
	if err != nil {
		return fuzzConfig{}, err
	}
	maxBytes, err := parseIntQuery(values, "maxBytes")
	if err != nil {
		return fuzzConfig{}, err
	}
	return normalizeFuzzConfig(fuzzConfig{
		StreamID:  values.Get("streamId"),
		Transport: values.Get("transport"),
		Mode:      values.Get("mode"),
		Seed:      seed,
		Count:     count,
		MaxBytes:  maxBytes,
	})
}

func normalizeFuzzConfig(config fuzzConfig) (fuzzConfig, error) {
	config.StreamID = normalizedStreamID(config.StreamID)
	config.Transport = normalizeTransport(config.Transport, "ws")
	if config.Transport != transportWebSocket && config.Transport != transportSSE {
		return fuzzConfig{}, fmt.Errorf("fuzz transport must be websocket or sse")
	}
	config.Mode = strings.ToLower(strings.TrimSpace(config.Mode))
	switch config.Mode {
	case "":
		config.Mode = "mixed"
	case "schema", "raw", "mixed":
	default:
		return fuzzConfig{}, fmt.Errorf("fuzz mode must be schema, raw, or mixed")
	}
	if config.Seed == 0 {
		config.Seed = defaultFuzzSeed
	}
	if config.Count == 0 {
		config.Count = defaultFuzzCount
	}
	if config.Count < 0 || config.Count > maxFuzzCount {
		return fuzzConfig{}, fmt.Errorf("fuzz count must be between 1 and %d", maxFuzzCount)
	}
	if config.MaxBytes == 0 {
		config.MaxBytes = defaultFuzzMaxBytes
	}
	if config.MaxBytes < minFuzzMaxBytes || config.MaxBytes > maxFuzzMaxBytes {
		return fuzzConfig{}, fmt.Errorf("fuzz maxBytes must be between %d and %d", minFuzzMaxBytes, maxFuzzMaxBytes)
	}
	return config, nil
}

func parseIntQuery(values url.Values, key string) (int, error) {
	value := strings.TrimSpace(values.Get(key))
	if value == "" {
		return 0, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	return parsed, nil
}

func parseInt64Query(values url.Values, key string) (int64, error) {
	value := strings.TrimSpace(values.Get(key))
	if value == "" {
		return 0, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	return parsed, nil
}

func boundedFuzzInput(input fuzzInput, maxBytes int) fuzzInput {
	if len(input.Payload) > maxBytes {
		input.Payload = input.Payload[:maxBytes]
	}
	return input
}

func mustMarshalFuzzJSON(value interface{}) []byte {
	payload, err := json.Marshal(value)
	if err != nil {
		return []byte(`{"topic":"fuzz.error","type":"marshal_error","payload":{}}`)
	}
	return payload
}

func fuzzReceivedAt(seed int64, index int) time.Time {
	return time.Unix(1_777_000_000+seed%86_400, int64(index)*int64(time.Millisecond)).UTC()
}

func accumulateFuzzSummary(summary *fuzzSummary, event captureEvent) {
	summary.Issues += len(event.Issues)
	for _, status := range event.Statuses {
		summary.ByStatus[status]++
	}
	for _, issue := range event.Issues {
		summary.ByIssue[issue.Code]++
	}
}

func issueCodes(issues []captureIssue) []string {
	if len(issues) == 0 {
		return nil
	}
	codes := make([]string, 0, len(issues))
	for _, issue := range issues {
		codes = append(codes, issue.Code)
	}
	return codes
}

func fuzzFixtureFilename(config fuzzConfig) string {
	return fmt.Sprintf("wiretap-fuzz-%s-seed-%d.jsonl", config.Mode, config.Seed)
}
