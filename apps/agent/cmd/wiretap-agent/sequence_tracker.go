package main

import "fmt"

type sequenceTracker struct {
	cursors map[string]sequenceCursor
}

type sequenceCursor struct {
	Scope       string
	Topic       string
	Key         string
	LastSeq     int64
	LastEventID string
}

func newSequenceTracker() *sequenceTracker {
	return &sequenceTracker{cursors: make(map[string]sequenceCursor)}
}

func (tracker *sequenceTracker) detect(event *captureEvent) {
	if event.Topic == "" || event.Seq == nil {
		return
	}
	if tracker.cursors == nil {
		tracker.cursors = make(map[string]sequenceCursor)
	}

	key := event.EffectiveKey
	if key == "" {
		key = event.Key
	}
	scope := sequenceScopeID(event.Topic, key)
	cursor, seen := tracker.cursors[scope]
	if !seen {
		tracker.remember(scope, event.Topic, key, *event.Seq, event.ID)
		return
	}

	actual := *event.Seq
	switch {
	case actual == cursor.LastSeq:
		event.addSequenceIssue("duplicate", "warning", fmt.Sprintf("Duplicate sequence %d for %s.", actual, sequenceScopeLabel(event.Topic, key)), map[string]interface{}{
			"scope":       cursor.Scope,
			"seq":         actual,
			"previous":    cursor.LastSeq,
			"lastEventId": cursor.LastEventID,
		})
	case actual < cursor.LastSeq:
		event.addSequenceIssue("out_of_order", "warning", fmt.Sprintf("Out-of-order sequence %d arrived after %d for %s.", actual, cursor.LastSeq, sequenceScopeLabel(event.Topic, key)), map[string]interface{}{
			"scope":       cursor.Scope,
			"actual":      actual,
			"previous":    cursor.LastSeq,
			"lastEventId": cursor.LastEventID,
		})
	case actual > cursor.LastSeq+1:
		expected := cursor.LastSeq + 1
		event.addSequenceIssue("gap", "error", fmt.Sprintf("Sequence jumped from %d to %d for %s.", cursor.LastSeq, actual, sequenceScopeLabel(event.Topic, key)), map[string]interface{}{
			"scope":        cursor.Scope,
			"expected":     expected,
			"actual":       actual,
			"missingStart": expected,
			"missingEnd":   actual - 1,
			"lastEventId":  cursor.LastEventID,
		})
		tracker.remember(scope, event.Topic, key, actual, event.ID)
	default:
		tracker.remember(scope, event.Topic, key, actual, event.ID)
	}
}

func (tracker *sequenceTracker) remember(scope string, topic string, key string, seq int64, eventID string) {
	tracker.cursors[scope] = sequenceCursor{
		Scope:       scope,
		Topic:       topic,
		Key:         key,
		LastSeq:     seq,
		LastEventID: eventID,
	}
}

func sequenceScopeID(topic string, key string) string {
	if key == "" {
		return topic
	}
	return topic + "\x00" + key
}

func sequenceScopeLabel(topic string, key string) string {
	if key == "" {
		return topic
	}
	return topic + " / " + key
}
