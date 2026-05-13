/**
 * Summary: Pending intervention message handling that delays history insertion
 * until the current assistant-to-tool chain is safely closed.
 */

import { createTimestamp } from '../types/messages.js';
import type { AgentSession, Message } from '../types/index.js';

export class InterventionQueue {
  enqueue(session: AgentSession, message: Message): AgentSession {
    return {
      ...session,
      pendingInterventions: [...session.pendingInterventions, structuredClone(message)],
      updatedAt: createTimestamp(),
    };
  }

  flush(session: AgentSession): AgentSession {
    if (session.pendingInterventions.length === 0) {
      return session;
    }

    return {
      ...session,
      messages: [...session.messages, ...session.pendingInterventions],
      pendingInterventions: [],
      updatedAt: createTimestamp(),
    };
  }

  hasPending(session: AgentSession): boolean {
    return session.pendingInterventions.length > 0;
  }
}