/**
 * Summary: Session query facade for returning the backend-authoritative view of
 * last messages, approval state, and latest error state.
 */

import type { SessionView } from '../types/index.js';
import type { SessionStore } from '../storage/session-store.js';

export class SessionQueryService {
  constructor(private readonly sessionStore: SessionStore) {}

  async getView(sessionId: string, messageCount = 20): Promise<SessionView | undefined> {
    const session = await this.sessionStore.get(sessionId);
    if (!session) {
      return undefined;
    }

    return {
      sessionId: session.id,
      lastMessages: session.messages.slice(-messageCount),
      pendingApprovals: session.pendingApprovals,
      isRunning: session.isRunning,
      status: session.status,
      turnId: session.turnId,
      updatedAt: session.updatedAt,
      ...(session.lastError ? { lastError: session.lastError } : {}),
    };
  }
}