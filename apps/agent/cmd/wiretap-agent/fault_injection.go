package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

const (
	faultScenarioOff       = "off"
	faultScenarioDrop      = "drop"
	faultScenarioDuplicate = "duplicate"
	faultScenarioReorder   = "reorder"
	faultScenarioDelay     = "delay"
	faultScenarioMutate    = "mutate"
	faultScenarioChaos     = "chaos"

	defaultFaultDropEvery      = 5
	defaultFaultDuplicateEvery = 4
	defaultFaultReorderEvery   = 5
	defaultFaultDelayMs        = 250
	defaultFaultMutateEvery    = 4
	maxFaultDelayMs            = 10_000
)

type faultInjectionConfig struct {
	Enabled        bool   `json:"enabled"`
	Scenario       string `json:"scenario,omitempty"`
	DropEvery      int    `json:"dropEvery,omitempty"`
	DuplicateEvery int    `json:"duplicateEvery,omitempty"`
	ReorderEvery   int    `json:"reorderEvery,omitempty"`
	DelayMs        int    `json:"delayMs,omitempty"`
	MutateEvery    int    `json:"mutateEvery,omitempty"`
}

type faultInjector struct {
	config  faultInjectionConfig
	seen    int64
	pending *upstreamFrame
}

func normalizeFaultInjectionConfig(config faultInjectionConfig) (faultInjectionConfig, error) {
	config.Scenario = strings.ToLower(strings.TrimSpace(config.Scenario))
	if config.Scenario == "" {
		config.Scenario = faultScenarioOff
	}
	if !config.Enabled || config.Scenario == faultScenarioOff {
		return faultInjectionConfig{Scenario: faultScenarioOff}, nil
	}

	switch config.Scenario {
	case faultScenarioDrop, faultScenarioDuplicate, faultScenarioReorder, faultScenarioDelay, faultScenarioMutate, faultScenarioChaos:
	default:
		return config, fmt.Errorf("fault scenario must be one of off, drop, duplicate, reorder, delay, mutate, or chaos")
	}

	if config.DropEvery < 0 || config.DuplicateEvery < 0 || config.ReorderEvery < 0 || config.DelayMs < 0 || config.MutateEvery < 0 {
		return config, errors.New("fault rule values must be zero or positive")
	}
	if config.DelayMs > maxFaultDelayMs {
		return config, fmt.Errorf("fault delay must be %dms or less", maxFaultDelayMs)
	}

	if (config.Scenario == faultScenarioDrop || config.Scenario == faultScenarioChaos) && config.DropEvery == 0 {
		config.DropEvery = defaultFaultDropEvery
	}
	if (config.Scenario == faultScenarioDuplicate || config.Scenario == faultScenarioChaos) && config.DuplicateEvery == 0 {
		config.DuplicateEvery = defaultFaultDuplicateEvery
	}
	if (config.Scenario == faultScenarioReorder || config.Scenario == faultScenarioChaos) && config.ReorderEvery == 0 {
		config.ReorderEvery = defaultFaultReorderEvery
	}
	if (config.Scenario == faultScenarioDelay || config.Scenario == faultScenarioChaos) && config.DelayMs == 0 {
		config.DelayMs = defaultFaultDelayMs
	}
	if (config.Scenario == faultScenarioMutate || config.Scenario == faultScenarioChaos) && config.MutateEvery == 0 {
		config.MutateEvery = defaultFaultMutateEvery
	}
	return config, nil
}

func newFaultInjector(config faultInjectionConfig) *faultInjector {
	normalized, err := normalizeFaultInjectionConfig(config)
	if err != nil || !normalized.Enabled || normalized.Scenario == faultScenarioOff {
		return nil
	}
	return &faultInjector{config: normalized}
}

func (injector *faultInjector) apply(ctx context.Context, frame upstreamFrame) ([]upstreamFrame, error) {
	if injector == nil {
		return []upstreamFrame{frame}, nil
	}

	injector.seen++
	index := injector.seen
	if injector.shouldDrop(index) {
		return nil, nil
	}

	frame = copyUpstreamFrame(frame)
	actions := make([]string, 0, 3)
	if injector.shouldMutate(index) {
		frame = mutateFaultFrame(frame)
		actions = append(actions, "mutate")
	}

	frames := []upstreamFrame{frame}
	if injector.shouldDuplicate(index) {
		duplicate := tagFaultFrame(copyUpstreamFrame(frame), "duplicate")
		frames = append(frames, duplicate)
		actions = append(actions, "duplicate")
	}
	if len(actions) > 0 {
		frames[0] = tagFaultFrame(frames[0], strings.Join(actions, ","))
	}

	if injector.shouldReorder(index) {
		held := tagFaultFrame(frames[0], "reorder-held")
		injector.pending = &held
		frames = frames[:0]
	} else if injector.pending != nil {
		reordered := tagFaultFrame(copyUpstreamFrame(*injector.pending), "reorder-release")
		injector.pending = nil
		frames = append(frames, reordered)
	}

	if injector.config.DelayMs > 0 {
		timer := time.NewTimer(time.Duration(injector.config.DelayMs) * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
		for index := range frames {
			frames[index] = tagFaultFrame(frames[index], "delay")
		}
	}
	for index := range frames {
		frames[index] = markFaultScenario(frames[index], injector.config.Scenario)
	}
	return frames, nil
}

func (injector *faultInjector) shouldDrop(index int64) bool {
	return injector.config.DropEvery > 0 && index%int64(injector.config.DropEvery) == 0
}

func (injector *faultInjector) shouldDuplicate(index int64) bool {
	return injector.config.DuplicateEvery > 0 && index%int64(injector.config.DuplicateEvery) == 0
}

func (injector *faultInjector) shouldReorder(index int64) bool {
	return injector.config.ReorderEvery > 0 && index%int64(injector.config.ReorderEvery) == 0
}

func (injector *faultInjector) shouldMutate(index int64) bool {
	return injector.config.MutateEvery > 0 && index%int64(injector.config.MutateEvery) == 0
}

func mutateFaultFrame(frame upstreamFrame) upstreamFrame {
	if frame.opcode != 0x1 || frame.oversized {
		return tagFaultFrame(frame, "mutate")
	}

	decoder := json.NewDecoder(bytes.NewReader(frame.payload))
	decoder.UseNumber()
	var parsed interface{}
	if err := decoder.Decode(&parsed); err != nil {
		frame.payload = append(copyBytes(frame.payload), []byte(`__wiretap_fault_mutation__`)...)
		frame.sizeBytes = int64(len(frame.payload))
		return tagFaultFrame(frame, "mutate")
	}
	var extra interface{}
	if err := decoder.Decode(&extra); err != io.EOF {
		frame.payload = append(copyBytes(frame.payload), []byte(`__wiretap_fault_mutation__`)...)
		frame.sizeBytes = int64(len(frame.payload))
		return tagFaultFrame(frame, "mutate")
	}

	object, ok := parsed.(map[string]interface{})
	if !ok {
		return tagFaultFrame(frame, "mutate")
	}
	if seq, ok := numericJSONValue(object["seq"]); ok {
		object["seq"] = seq + 1000
	} else if payload, ok := object["payload"].(map[string]interface{}); ok {
		payload["wiretapFault"] = "mutated"
	} else {
		object["wiretapFault"] = "mutated"
	}

	payload, err := json.Marshal(object)
	if err != nil {
		return tagFaultFrame(frame, "mutate")
	}
	frame.payload = payload
	frame.sizeBytes = int64(len(payload))
	return tagFaultFrame(frame, "mutate")
}

func numericJSONValue(value interface{}) (int64, bool) {
	switch typed := value.(type) {
	case json.Number:
		integer, err := typed.Int64()
		if err == nil {
			return integer, true
		}
		floatValue, err := strconv.ParseFloat(typed.String(), 64)
		if err == nil {
			return int64(floatValue), true
		}
	case float64:
		return int64(typed), true
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	}
	return 0, false
}

func tagFaultFrame(frame upstreamFrame, action string) upstreamFrame {
	if frame.transportMeta == nil {
		frame.transportMeta = map[string]string{}
	} else {
		frame.transportMeta = copyStringMap(frame.transportMeta)
	}
	if current := frame.transportMeta["faultAction"]; current != "" {
		frame.transportMeta["faultAction"] = current + "," + action
	} else {
		frame.transportMeta["faultAction"] = action
	}
	return frame
}

func markFaultScenario(frame upstreamFrame, scenario string) upstreamFrame {
	if frame.transportMeta == nil {
		frame.transportMeta = map[string]string{}
	} else {
		frame.transportMeta = copyStringMap(frame.transportMeta)
	}
	frame.transportMeta["faultScenario"] = scenario
	return frame
}

func copyUpstreamFrame(frame upstreamFrame) upstreamFrame {
	frame.payload = copyBytes(frame.payload)
	frame.transportMeta = copyStringMap(frame.transportMeta)
	return frame
}

func copyBytes(value []byte) []byte {
	if len(value) == 0 {
		return nil
	}
	copied := make([]byte, len(value))
	copy(copied, value)
	return copied
}
