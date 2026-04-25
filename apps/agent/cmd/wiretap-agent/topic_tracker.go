package main

import (
	"strings"
	"time"
)

type topicScope string

const (
	topicScopeTopic    topicScope = "topic"
	topicScopeTopicKey topicScope = "topicKey"
)

type topicTracker struct {
	topics map[string]*topicAggregate
}

type topicRule struct {
	Pattern    string
	StaleScope topicScope
	StaleMs    *int64
}

type rateSample struct {
	At    time.Time
	Bytes int64
}

type topicAggregate struct {
	ID               string
	StreamID         string
	Topic            string
	Key              string
	Scope            topicScope
	Count            int64
	Bytes            int64
	FirstSeenAt      time.Time
	LastSeenAt       time.Time
	LastEventID      string
	LastSeq          *int64
	EventsPerSec     float64
	BytesPerSec      float64
	Stale            bool
	StaleSince       *time.Time
	StaleThresholdMs *int64
	IssueCount       int64
	StaleCount       int64
	GapCount         int64
	DuplicateCount   int64
	OutOfOrderCount  int64
	ParseErrorCount  int64
	SchemaErrorCount int64
	Samples          []rateSample
}

type topicState struct {
	ID               string     `json:"id"`
	StreamID         string     `json:"streamId,omitempty"`
	Topic            string     `json:"topic"`
	Key              string     `json:"key,omitempty"`
	Name             string     `json:"name"`
	Scope            topicScope `json:"scope"`
	Count            int64      `json:"count"`
	Bytes            int64      `json:"bytes"`
	FirstSeenAt      string     `json:"firstSeenAt"`
	LastSeenAt       string     `json:"lastSeenAt"`
	LastEventID      string     `json:"lastEventId,omitempty"`
	LastSeq          *int64     `json:"lastSeq,omitempty"`
	EventsPerSec     float64    `json:"eventsPerSec"`
	BytesPerSec      float64    `json:"bytesPerSec"`
	Stale            bool       `json:"stale"`
	StaleSince       string     `json:"staleSince,omitempty"`
	StaleThresholdMs *int64     `json:"staleThresholdMs,omitempty"`
	IssueCount       int64      `json:"issueCount"`
	StaleCount       int64      `json:"staleCount"`
	GapCount         int64      `json:"gapCount"`
	DuplicateCount   int64      `json:"duplicateCount"`
	OutOfOrderCount  int64      `json:"outOfOrderCount"`
	ParseErrorCount  int64      `json:"parseErrorCount"`
	SchemaErrorCount int64      `json:"schemaErrorCount"`
}

type staleEvaluation struct {
	changed    []topicState
	issueDelta int64
}

func newTopicTracker() *topicTracker {
	return &topicTracker{topics: make(map[string]*topicAggregate)}
}

func newTopicTrackerFromSnapshot(topics []topicState) *topicTracker {
	tracker := newTopicTracker()
	for _, state := range topics {
		firstSeenAt, err := time.Parse(time.RFC3339Nano, state.FirstSeenAt)
		if err != nil {
			firstSeenAt = time.Now().UTC()
		}
		lastSeenAt, err := time.Parse(time.RFC3339Nano, state.LastSeenAt)
		if err != nil {
			lastSeenAt = firstSeenAt
		}
		var staleSince *time.Time
		if state.StaleSince != "" {
			parsed, err := time.Parse(time.RFC3339Nano, state.StaleSince)
			if err == nil {
				staleSince = &parsed
			}
		}
		streamID := normalizedStreamID(state.StreamID)
		id := state.ID
		if state.StreamID == "" {
			id = topicID(streamID, state.Topic, state.Key)
		}
		tracker.topics[id] = &topicAggregate{
			ID:               id,
			StreamID:         streamID,
			Topic:            state.Topic,
			Key:              state.Key,
			Scope:            state.Scope,
			Count:            state.Count,
			Bytes:            state.Bytes,
			FirstSeenAt:      firstSeenAt,
			LastSeenAt:       lastSeenAt,
			LastEventID:      state.LastEventID,
			LastSeq:          state.LastSeq,
			EventsPerSec:     state.EventsPerSec,
			BytesPerSec:      state.BytesPerSec,
			Stale:            state.Stale,
			StaleSince:       staleSince,
			StaleThresholdMs: state.StaleThresholdMs,
			IssueCount:       state.IssueCount,
			StaleCount:       state.StaleCount,
			GapCount:         state.GapCount,
			DuplicateCount:   state.DuplicateCount,
			OutOfOrderCount:  state.OutOfOrderCount,
			ParseErrorCount:  state.ParseErrorCount,
			SchemaErrorCount: state.SchemaErrorCount,
		}
	}
	return tracker
}

func (tracker *topicTracker) record(event captureEvent) (topicState, bool) {
	topicName := event.Topic
	if topicName == "" {
		topicName = event.DisplayTopic
	}
	if topicName == "" {
		return topicState{}, false
	}

	receivedAt, err := time.Parse(time.RFC3339Nano, event.ReceivedAt)
	if err != nil {
		receivedAt = time.Now().UTC()
	}

	rule := matchTopicRule(topicName)
	scope := rule.StaleScope
	key := ""
	if scope == topicScopeTopicKey {
		key = event.EffectiveKey
		if key == "" {
			key = event.Key
		}
		if key == "" {
			scope = topicScopeTopic
		}
	}
	if scope == "" {
		scope = topicScopeTopic
	}

	streamID := normalizedStreamID(event.StreamID)
	id := topicID(streamID, topicName, key)
	if tracker.topics == nil {
		tracker.topics = make(map[string]*topicAggregate)
	}
	topic := tracker.topics[id]
	if topic == nil {
		topic = &topicAggregate{
			ID:               id,
			StreamID:         streamID,
			Topic:            topicName,
			Key:              key,
			Scope:            scope,
			FirstSeenAt:      receivedAt,
			StaleThresholdMs: rule.StaleMs,
		}
		tracker.topics[id] = topic
	}

	topic.Count++
	topic.Bytes += event.SizeBytes
	topic.LastSeenAt = receivedAt
	topic.LastEventID = event.ID
	topic.Samples = append(topic.Samples, rateSample{At: receivedAt, Bytes: event.SizeBytes})
	if event.Seq != nil {
		seq := *event.Seq
		topic.LastSeq = &seq
	}
	if topic.Stale {
		topic.Stale = false
		topic.StaleSince = nil
	}
	for _, issue := range event.Issues {
		topic.IssueCount++
		switch issue.Code {
		case "gap":
			topic.GapCount++
		case "duplicate":
			topic.DuplicateCount++
		case "out_of_order":
			topic.OutOfOrderCount++
		case "parse_error":
			topic.ParseErrorCount++
		case "schema_error":
			topic.SchemaErrorCount++
		}
	}
	refreshTopicRate(topic, receivedAt)
	return topic.toState(), true
}

func (tracker *topicTracker) evaluateStale(now time.Time) staleEvaluation {
	result := staleEvaluation{changed: make([]topicState, 0)}
	for _, topic := range tracker.topics {
		refreshTopicRate(topic, now)
		if topic.StaleThresholdMs == nil {
			continue
		}

		shouldBeStale := now.Sub(topic.LastSeenAt).Milliseconds() >= *topic.StaleThresholdMs
		if shouldBeStale && !topic.Stale {
			topic.Stale = true
			staleSince := now
			topic.StaleSince = &staleSince
			topic.IssueCount++
			topic.StaleCount++
			result.issueDelta++
			result.changed = append(result.changed, topic.toState())
		} else if !shouldBeStale && topic.Stale {
			topic.Stale = false
			topic.StaleSince = nil
			result.changed = append(result.changed, topic.toState())
		}
	}
	return result
}

func (tracker *topicTracker) snapshot(now time.Time) []topicState {
	topics := make([]topicState, 0, len(tracker.topics))
	for _, topic := range tracker.topics {
		refreshTopicRate(topic, now)
		topics = append(topics, topic.toState())
	}
	return topics
}

func refreshTopicRate(topic *topicAggregate, now time.Time) {
	cutoff := now.Add(-rateWindow)
	keep := 0
	var bytes int64
	for _, sample := range topic.Samples {
		if !sample.At.Before(cutoff) {
			topic.Samples[keep] = sample
			keep++
			bytes += sample.Bytes
		}
	}
	topic.Samples = topic.Samples[:keep]
	topic.EventsPerSec = float64(len(topic.Samples)) / rateWindow.Seconds()
	topic.BytesPerSec = float64(bytes) / rateWindow.Seconds()
}

func (topic *topicAggregate) toState() topicState {
	state := topicState{
		ID:               topic.ID,
		StreamID:         topic.StreamID,
		Topic:            topic.Topic,
		Key:              topic.Key,
		Name:             topicName(topic.Topic, topic.Key),
		Scope:            topic.Scope,
		Count:            topic.Count,
		Bytes:            topic.Bytes,
		FirstSeenAt:      topic.FirstSeenAt.Format(time.RFC3339Nano),
		LastSeenAt:       topic.LastSeenAt.Format(time.RFC3339Nano),
		LastEventID:      topic.LastEventID,
		LastSeq:          topic.LastSeq,
		EventsPerSec:     topic.EventsPerSec,
		BytesPerSec:      topic.BytesPerSec,
		Stale:            topic.Stale,
		StaleThresholdMs: topic.StaleThresholdMs,
		IssueCount:       topic.IssueCount,
		StaleCount:       topic.StaleCount,
		GapCount:         topic.GapCount,
		DuplicateCount:   topic.DuplicateCount,
		OutOfOrderCount:  topic.OutOfOrderCount,
		ParseErrorCount:  topic.ParseErrorCount,
		SchemaErrorCount: topic.SchemaErrorCount,
	}
	if topic.StaleSince != nil {
		state.StaleSince = topic.StaleSince.Format(time.RFC3339Nano)
	}
	return state
}

func matchTopicRule(topic string) topicRule {
	for _, rule := range defaultTopicRules() {
		if topicRuleMatches(rule.Pattern, topic) {
			return rule
		}
	}
	return topicRule{Pattern: "*", StaleScope: topicScopeTopicKey}
}

func defaultTopicRules() []topicRule {
	marketStaleMs := int64(1000)
	portfolioStaleMs := int64(5000)
	systemStaleMs := int64(10000)
	return []topicRule{
		{Pattern: "market.*", StaleScope: topicScopeTopicKey, StaleMs: &marketStaleMs},
		{Pattern: "orders", StaleScope: topicScopeTopic},
		{Pattern: "portfolio", StaleScope: topicScopeTopic, StaleMs: &portfolioStaleMs},
		{Pattern: "system", StaleScope: topicScopeTopic, StaleMs: &systemStaleMs},
		{Pattern: "*", StaleScope: topicScopeTopicKey},
	}
}

func topicRuleMatches(pattern string, topic string) bool {
	if pattern == "*" {
		return true
	}
	if strings.HasSuffix(pattern, "*") {
		return strings.HasPrefix(topic, strings.TrimSuffix(pattern, "*"))
	}
	return topic == pattern
}

func topicID(streamID string, topic string, key string) string {
	prefix := normalizedStreamID(streamID) + "\x00"
	if key == "" {
		return prefix + topic
	}
	return prefix + topic + "\x00" + key
}

func topicName(topic string, key string) string {
	if key == "" {
		return topic
	}
	return topic + " / " + key
}
