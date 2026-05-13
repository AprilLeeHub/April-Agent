/**
 * Summary: Structured decision-event recording with explicit executed, skipped,
 * blocked, and error states for runtime control points.
 */

import { createMessageId, createTimestamp } from '../types/messages.js';
import type { DecisionEvent, DecisionEventState } from '../types/index.js';

export class Observability {
  private readonly events: DecisionEvent[] = [];

  emit(input: {
    sessionId: string;
    turnId: string;
    decision: string;
    state: DecisionEventState;
    message: string;
    metadata?: Record<string, unknown>;
  }): DecisionEvent {
    const event: DecisionEvent = {
      id: createMessageId('decision'),
      timestamp: createTimestamp(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      decision: input.decision,
      state: input.state,
      message: input.message,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    this.events.push(event);
    return event;
  }

  executed(sessionId: string, turnId: string, decision: string, message: string, metadata?: Record<string, unknown>): DecisionEvent {
    return this.emit({ sessionId, turnId, decision, state: 'executed', message, ...(metadata ? { metadata } : {}) });
  }

  skipped(sessionId: string, turnId: string, decision: string, message: string, metadata?: Record<string, unknown>): DecisionEvent {
    return this.emit({ sessionId, turnId, decision, state: 'skipped', message, ...(metadata ? { metadata } : {}) });
  }

  blocked(sessionId: string, turnId: string, decision: string, message: string, metadata?: Record<string, unknown>): DecisionEvent {
    return this.emit({ sessionId, turnId, decision, state: 'blocked', message, ...(metadata ? { metadata } : {}) });
  }

  error(sessionId: string, turnId: string, decision: string, message: string, metadata?: Record<string, unknown>): DecisionEvent {
    return this.emit({ sessionId, turnId, decision, state: 'error', message, ...(metadata ? { metadata } : {}) });
  }

  list(sessionId?: string): DecisionEvent[] {
    const events = sessionId ? this.events.filter((event) => event.sessionId === sessionId) : this.events;
    return structuredClone(events);
  }

  count(decision: string, state?: DecisionEventState): number {
    return this.events.filter((event) => event.decision === decision && (!state || event.state === state)).length;
  }

  assertDecisionRecorded(decision: string): void {
    if (!this.events.some((event) => event.decision === decision)) {
      throw new Error(`Expected decision event for ${decision}, but none was recorded.`);
    }
  }

  clear(): void {
    this.events.length = 0;
  }
}