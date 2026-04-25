package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

const maxSchemaPlugins = 16
const maxPluginChecks = 64

type extractionRules struct {
	TopicPath       string         `json:"topicPath"`
	TypePath        string         `json:"typePath"`
	SeqPath         string         `json:"seqPath"`
	TimestampPath   string         `json:"timestampPath"`
	PayloadPath     string         `json:"payloadPath"`
	KeyPaths        []string       `json:"keyPaths"`
	Otel            otelRules      `json:"otel"`
	SchemaPlugins   []schemaPlugin `json:"schemaPlugins"`
	SandboxBoundary string         `json:"sandboxBoundary"`
}

type otelRules struct {
	TraceIDPaths      []string          `json:"traceIdPaths"`
	SpanIDPaths       []string          `json:"spanIdPaths"`
	ParentSpanIDPaths []string          `json:"parentSpanIdPaths"`
	TraceparentPaths  []string          `json:"traceparentPaths"`
	TraceStatePaths   []string          `json:"traceStatePaths"`
	LogIDPaths        []string          `json:"logIdPaths"`
	ServiceNamePaths  []string          `json:"serviceNamePaths"`
	OTLPEndpoint      string            `json:"otlpEndpoint,omitempty"`
	TraceQueryURL     string            `json:"traceQueryUrl,omitempty"`
	LogQueryURL       string            `json:"logQueryUrl,omitempty"`
	Headers           map[string]string `json:"headers,omitempty"`
}

type schemaPlugin struct {
	ID            string              `json:"id"`
	Name          string              `json:"name"`
	Enabled       bool                `json:"enabled"`
	Required      []string            `json:"required,omitempty"`
	StringFields  []string            `json:"stringFields,omitempty"`
	NumberFields  []string            `json:"numberFields,omitempty"`
	IntegerFields []string            `json:"integerFields,omitempty"`
	EnumFields    map[string][]string `json:"enumFields,omitempty"`
}

func defaultExtractionRules() extractionRules {
	return extractionRules{
		TopicPath:       "topic",
		TypePath:        "type",
		SeqPath:         "seq",
		TimestampPath:   "ts",
		PayloadPath:     "payload",
		KeyPaths:        []string{"key", "symbol"},
		Otel:            defaultOtelRules(),
		SchemaPlugins:   []schemaPlugin{},
		SandboxBoundary: "declarative-json-rules-only",
	}
}

func defaultOtelRules() otelRules {
	return otelRules{
		TraceIDPaths: []string{
			"traceId",
			"trace_id",
			"trace.id",
			"context.traceId",
			"context.trace_id",
			"payload.traceId",
			"payload.trace_id",
			"payload.trace.id",
		},
		SpanIDPaths: []string{
			"spanId",
			"span_id",
			"span.id",
			"context.spanId",
			"context.span_id",
			"payload.spanId",
			"payload.span_id",
			"payload.span.id",
		},
		ParentSpanIDPaths: []string{
			"parentSpanId",
			"parent_span_id",
			"parent.spanId",
			"parent.span_id",
			"payload.parentSpanId",
			"payload.parent_span_id",
		},
		TraceparentPaths: []string{
			"traceparent",
			"context.traceparent",
			"payload.traceparent",
		},
		TraceStatePaths: []string{
			"tracestate",
			"traceState",
			"context.tracestate",
			"context.traceState",
			"payload.tracestate",
			"payload.traceState",
		},
		LogIDPaths: []string{
			"logId",
			"log_id",
			"log.id",
			"payload.logId",
			"payload.log_id",
			"payload.log.id",
		},
		ServiceNamePaths: []string{
			"service.name",
			"serviceName",
			"service_name",
			"resource.service.name",
			"resource.attributes.service.name",
			"payload.service.name",
			"payload.serviceName",
			"payload.service_name",
		},
	}
}

func normalizeExtractionRules(rules extractionRules) extractionRules {
	defaults := defaultExtractionRules()
	if strings.TrimSpace(rules.TopicPath) == "" {
		rules.TopicPath = defaults.TopicPath
	}
	if strings.TrimSpace(rules.TypePath) == "" {
		rules.TypePath = defaults.TypePath
	}
	if strings.TrimSpace(rules.SeqPath) == "" {
		rules.SeqPath = defaults.SeqPath
	}
	if strings.TrimSpace(rules.TimestampPath) == "" {
		rules.TimestampPath = defaults.TimestampPath
	}
	if strings.TrimSpace(rules.PayloadPath) == "" {
		rules.PayloadPath = defaults.PayloadPath
	}
	if len(rules.KeyPaths) == 0 {
		rules.KeyPaths = defaults.KeyPaths
	}
	rules.Otel = normalizeOtelRules(rules.Otel)
	rules.SandboxBoundary = defaults.SandboxBoundary
	return rules
}

func normalizeOtelRules(rules otelRules) otelRules {
	defaults := defaultOtelRules()
	if len(rules.TraceIDPaths) == 0 {
		rules.TraceIDPaths = defaults.TraceIDPaths
	}
	if len(rules.SpanIDPaths) == 0 {
		rules.SpanIDPaths = defaults.SpanIDPaths
	}
	if len(rules.ParentSpanIDPaths) == 0 {
		rules.ParentSpanIDPaths = defaults.ParentSpanIDPaths
	}
	if len(rules.TraceparentPaths) == 0 {
		rules.TraceparentPaths = defaults.TraceparentPaths
	}
	if len(rules.TraceStatePaths) == 0 {
		rules.TraceStatePaths = defaults.TraceStatePaths
	}
	if len(rules.LogIDPaths) == 0 {
		rules.LogIDPaths = defaults.LogIDPaths
	}
	if len(rules.ServiceNamePaths) == 0 {
		rules.ServiceNamePaths = defaults.ServiceNamePaths
	}

	rules.OTLPEndpoint = strings.TrimSpace(rules.OTLPEndpoint)
	rules.TraceQueryURL = strings.TrimSpace(rules.TraceQueryURL)
	rules.LogQueryURL = strings.TrimSpace(rules.LogQueryURL)
	if len(rules.Headers) > 0 {
		headers := make(map[string]string)
		for key, value := range rules.Headers {
			key = strings.TrimSpace(key)
			if key != "" {
				headers[key] = strings.TrimSpace(value)
			}
		}
		rules.Headers = headers
	}
	return rules
}

func (rules extractionRules) validate() error {
	rules = normalizeExtractionRules(rules)
	paths := []string{rules.TopicPath, rules.TypePath, rules.SeqPath, rules.TimestampPath, rules.PayloadPath}
	paths = append(paths, rules.KeyPaths...)
	for _, path := range paths {
		if err := validateRulePath(path); err != nil {
			return err
		}
	}
	if err := rules.Otel.validate(); err != nil {
		return err
	}
	if len(rules.SchemaPlugins) > maxSchemaPlugins {
		return fmt.Errorf("schemaPlugins is limited to %d plugins", maxSchemaPlugins)
	}
	for _, plugin := range rules.SchemaPlugins {
		if err := plugin.validate(); err != nil {
			return err
		}
	}
	return nil
}

func (rules otelRules) validate() error {
	pathGroups := [][]string{
		rules.TraceIDPaths,
		rules.SpanIDPaths,
		rules.ParentSpanIDPaths,
		rules.TraceparentPaths,
		rules.TraceStatePaths,
		rules.LogIDPaths,
		rules.ServiceNamePaths,
	}
	for _, group := range pathGroups {
		for _, path := range group {
			if err := validateRulePath(path); err != nil {
				return fmt.Errorf("otel path: %w", err)
			}
		}
	}
	for _, rawURL := range []string{rules.OTLPEndpoint, rules.TraceQueryURL, rules.LogQueryURL} {
		if strings.TrimSpace(rawURL) == "" {
			continue
		}
		parsed, err := url.Parse(rawURL)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return fmt.Errorf("otel URL %q must be an absolute URL", rawURL)
		}
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return fmt.Errorf("otel URL %q must use http:// or https://", rawURL)
		}
	}
	return nil
}

func (plugin schemaPlugin) validate() error {
	if strings.TrimSpace(plugin.ID) == "" {
		return fmt.Errorf("schema plugin id is required")
	}
	checkCount := len(plugin.Required) + len(plugin.StringFields) + len(plugin.NumberFields) + len(plugin.IntegerFields) + len(plugin.EnumFields)
	if checkCount > maxPluginChecks {
		return fmt.Errorf("schema plugin %q has %d checks; limit is %d", plugin.ID, checkCount, maxPluginChecks)
	}
	for _, path := range plugin.Required {
		if err := validateRulePath(path); err != nil {
			return fmt.Errorf("schema plugin %q required path: %w", plugin.ID, err)
		}
	}
	for _, path := range plugin.StringFields {
		if err := validateRulePath(path); err != nil {
			return fmt.Errorf("schema plugin %q string path: %w", plugin.ID, err)
		}
	}
	for _, path := range plugin.NumberFields {
		if err := validateRulePath(path); err != nil {
			return fmt.Errorf("schema plugin %q number path: %w", plugin.ID, err)
		}
	}
	for _, path := range plugin.IntegerFields {
		if err := validateRulePath(path); err != nil {
			return fmt.Errorf("schema plugin %q integer path: %w", plugin.ID, err)
		}
	}
	for path := range plugin.EnumFields {
		if err := validateRulePath(path); err != nil {
			return fmt.Errorf("schema plugin %q enum path: %w", plugin.ID, err)
		}
	}
	return nil
}

func validateRulePath(path string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("path cannot be empty")
	}
	for _, part := range strings.Split(path, ".") {
		if strings.TrimSpace(part) == "" {
			return fmt.Errorf("path %q contains an empty segment", path)
		}
	}
	return nil
}

func valueAtPath(values map[string]interface{}, path string) (interface{}, bool) {
	var current interface{} = values
	for _, part := range strings.Split(path, ".") {
		object, ok := current.(map[string]interface{})
		if !ok {
			return nil, false
		}
		next, exists := object[part]
		if !exists {
			return nil, false
		}
		current = next
	}
	return current, true
}

func stringAtPath(values map[string]interface{}, path string) (string, bool) {
	value, exists := valueAtPath(values, path)
	if !exists || value == nil {
		return "", false
	}
	text, ok := value.(string)
	if !ok || text == "" {
		return "", false
	}
	return text, true
}

func numberAtPath(values map[string]interface{}, path string) (json.Number, bool) {
	value, exists := valueAtPath(values, path)
	if !exists || value == nil {
		return "", false
	}
	number, ok := value.(json.Number)
	return number, ok
}

func requiredStringPath(values map[string]interface{}, path string, label string, event *captureEvent) (string, bool) {
	value, exists := valueAtPath(values, path)
	if !exists {
		event.addIssue("schema_error", "error", fmt.Sprintf("Envelope is missing required string field: %s.", label))
		return "", false
	}
	text, ok := value.(string)
	if !ok || text == "" {
		event.addIssue("schema_error", "error", fmt.Sprintf("Envelope field %s must be a non-empty string.", label))
		return "", false
	}
	return text, true
}

func optionalStringPath(values map[string]interface{}, path string, event *captureEvent) (string, bool) {
	value, exists := valueAtPath(values, path)
	if !exists || value == nil {
		return "", false
	}
	text, ok := value.(string)
	if !ok {
		event.addIssue("schema_error", "error", fmt.Sprintf("Envelope field %s must be a string when present.", path))
		return "", false
	}
	if text == "" {
		return "", false
	}
	return text, true
}

func optionalTimestampPath(values map[string]interface{}, path string, event *captureEvent) (interface{}, bool) {
	value, exists := valueAtPath(values, path)
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

	event.addIssue("schema_error", "error", fmt.Sprintf("Envelope field %s must be a number or string when present.", path))
	return nil, false
}

func optionalInt64Path(values map[string]interface{}, path string, event *captureEvent) (int64, bool) {
	value, exists := valueAtPath(values, path)
	if !exists || value == nil {
		return 0, false
	}

	number, ok := value.(json.Number)
	if !ok {
		event.addIssue("schema_error", "error", fmt.Sprintf("Envelope field %s must be an integer number when present.", path))
		return 0, false
	}

	parsed, err := number.Int64()
	if err != nil {
		event.addIssue("schema_error", "error", fmt.Sprintf("Envelope field %s must be an integer number when present.", path))
		return 0, false
	}
	return parsed, true
}

func applySchemaPlugins(values map[string]interface{}, plugins []schemaPlugin, event *captureEvent) {
	for _, plugin := range plugins {
		if !plugin.Enabled {
			continue
		}
		for _, path := range plugin.Required {
			if value, ok := valueAtPath(values, path); !ok || value == nil {
				event.addPluginIssue(plugin, path, "required field is missing")
			}
		}
		for _, path := range plugin.StringFields {
			if value, ok := valueAtPath(values, path); ok && value != nil {
				if _, isString := value.(string); !isString {
					event.addPluginIssue(plugin, path, "field must be a string")
				}
			}
		}
		for _, path := range plugin.NumberFields {
			if number, ok := numberAtPath(values, path); ok {
				if _, err := number.Float64(); err != nil {
					event.addPluginIssue(plugin, path, "field must be a number")
				}
			} else if value, exists := valueAtPath(values, path); exists && value != nil {
				event.addPluginIssue(plugin, path, "field must be a number")
			}
		}
		for _, path := range plugin.IntegerFields {
			if number, ok := numberAtPath(values, path); ok {
				if _, err := number.Int64(); err != nil {
					event.addPluginIssue(plugin, path, "field must be an integer")
				}
			} else if value, exists := valueAtPath(values, path); exists && value != nil {
				event.addPluginIssue(plugin, path, "field must be an integer")
			}
		}
		for path, allowed := range plugin.EnumFields {
			if text, ok := stringAtPath(values, path); ok && !stringInSlice(text, allowed) {
				event.addPluginIssue(plugin, path, fmt.Sprintf("field must be one of: %s", strings.Join(allowed, ", ")))
			}
		}
	}
}

func (event *captureEvent) addPluginIssue(plugin schemaPlugin, path string, message string) {
	name := plugin.Name
	if strings.TrimSpace(name) == "" {
		name = plugin.ID
	}
	event.Issues = append(event.Issues, captureIssue{
		Code:     "schema_plugin",
		Severity: "error",
		Message:  fmt.Sprintf("%s: %s at %s.", name, message, path),
		Topic:    event.Topic,
		Key:      event.EffectiveKey,
		Details: map[string]interface{}{
			"pluginId": plugin.ID,
			"path":     path,
		},
	})
}

func stringInSlice(value string, values []string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

var (
	traceIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
	spanIDPattern  = regexp.MustCompile(`^[0-9a-fA-F]{16}$`)
)

func extractOtelCorrelation(values map[string]interface{}, rules otelRules) *otelCorrelation {
	rules = normalizeOtelRules(rules)

	traceID, traceSource := firstStringAtAnyPath(values, rules.TraceIDPaths)
	spanID, spanSource := firstStringAtAnyPath(values, rules.SpanIDPaths)
	parentSpanID, _ := firstStringAtAnyPath(values, rules.ParentSpanIDPaths)
	traceState, _ := firstStringAtAnyPath(values, rules.TraceStatePaths)
	logID, logSource := firstStringAtAnyPath(values, rules.LogIDPaths)
	serviceName, _ := firstStringAtAnyPath(values, rules.ServiceNamePaths)

	traceID = normalizeTraceID(traceID)
	spanID = normalizeSpanID(spanID)
	parentSpanID = normalizeSpanID(parentSpanID)
	if traceparent, traceparentSource := firstStringAtAnyPath(values, rules.TraceparentPaths); traceparent != "" {
		if parsedTraceID, parsedSpanID, ok := parseTraceparent(traceparent); ok {
			if traceID == "" {
				traceID = parsedTraceID
				traceSource = traceparentSource
			}
			if spanID == "" {
				spanID = parsedSpanID
				spanSource = traceparentSource
			}
		}
	}
	if traceID == "" && spanID == "" && logID == "" {
		return nil
	}

	source := traceSource
	if source == "" {
		source = spanSource
	}
	if source == "" {
		source = logSource
	}
	return &otelCorrelation{
		TraceID:       traceID,
		SpanID:        spanID,
		ParentSpanID:  parentSpanID,
		TraceState:    traceState,
		LogID:         logID,
		ServiceName:   serviceName,
		Source:        source,
		TraceQueryURL: correlationQueryURL(rules.TraceQueryURL, traceID, spanID, logID),
		LogQueryURL:   correlationQueryURL(rules.LogQueryURL, traceID, spanID, logID),
		OTLPEndpoint:  rules.OTLPEndpoint,
	}
}

func correlationQueryURL(template string, traceID string, spanID string, logID string) string {
	template = strings.TrimSpace(template)
	if template == "" {
		return ""
	}
	replacer := strings.NewReplacer(
		"{traceId}", url.QueryEscape(traceID),
		"{spanId}", url.QueryEscape(spanID),
		"{logId}", url.QueryEscape(logID),
	)
	return replacer.Replace(template)
}

func firstStringAtAnyPath(values map[string]interface{}, paths []string) (string, string) {
	for _, path := range paths {
		if text, ok := stringAtPath(values, path); ok {
			return strings.TrimSpace(text), path
		}
	}
	return "", ""
}

func parseTraceparent(value string) (string, string, bool) {
	parts := strings.Split(strings.TrimSpace(value), "-")
	if len(parts) < 4 {
		return "", "", false
	}
	traceID := normalizeTraceID(parts[1])
	spanID := normalizeSpanID(parts[2])
	return traceID, spanID, traceID != "" && spanID != ""
}

func normalizeTraceID(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "0x")
	if !traceIDPattern.MatchString(value) || value == strings.Repeat("0", 32) {
		return ""
	}
	return value
}

func normalizeSpanID(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "0x")
	if !spanIDPattern.MatchString(value) || value == strings.Repeat("0", 16) {
		return ""
	}
	return value
}
