/**
 * Summary: Session store contracts and an in-memory implementation that keeps
 * message ordering intact for the runtime state machine.
 */

import { createSession } from '../types/runtime.js';
import type { AgentSession } from '../types/index.js';

export interface SessionStore {
  create(sessionId: string): Promise<AgentSession>;
  get(sessionId: string): Promise<AgentSession | undefined>;
  save(session: AgentSession): Promise<void>;
  update(sessionId: string, updater: (session: AgentSession) => AgentSession): Promise<AgentSession>;
  list(): Promise<AgentSession[]>;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentSession>();

  async create(sessionId: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return structuredClone(existing);
    }

    const session = createSession(sessionId);
    this.sessions.set(sessionId, structuredClone(session));
    return structuredClone(session);
  }

  async get(sessionId: string): Promise<AgentSession | undefined> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : undefined;
  }

  async save(session: AgentSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async update(sessionId: string, updater: (session: AgentSession) => AgentSession): Promise<AgentSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found.`);
    }

    const updated = updater(structuredClone(session));
    this.sessions.set(sessionId, structuredClone(updated));
    return structuredClone(updated);
  }

  async list(): Promise<AgentSession[]> {
    return Array.from(this.sessions.values(), (session) => structuredClone(session));
  }
}