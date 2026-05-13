import { describe, expect, it } from 'vitest';

import { createSession } from '../src/types/index.js';
import { SessionStateMachine } from '../src/engine/state-machine.js';
import { StateMachineError } from '../src/engine/errors.js';

describe('SessionStateMachine', () => {
  it('allows the happy path from input to completion', () => {
    const machine = new SessionStateMachine();
    const session = createSession('session-1');

    const withInput = machine.submitUserInput(session, 'hello');
    expect(withInput.status).toBe('awaiting_confirmation');
    expect(withInput.pendingUserTurn?.content).toBe('hello');

    const confirmed = machine.confirmTurn(withInput);
    expect(confirmed.status).toBe('awaiting_confirmation');
    expect(confirmed.pendingUserTurn?.confirmedAt).toBeTruthy();

    const running = machine.runTurn(confirmed);
    expect(running.status).toBe('running');

    const completed = machine.markCompleted(running, 'assistant_completed');
    expect(completed.status).toBe('completed');
    expect(completed.terminationReason).toBe('assistant_completed');
  });

  it('rejects running a turn before confirmation', () => {
    const machine = new SessionStateMachine();
    const session = machine.submitUserInput(createSession('session-2'), 'hello');

    expect(() => machine.runTurn(session)).toThrow(StateMachineError);
  });

  it('supports cancellation while awaiting confirmation', () => {
    const machine = new SessionStateMachine();
    const session = createSession('session-3');

    const withInput = machine.submitUserInput(session, 'hello');
    const cancelled = machine.cancel(withInput, 'stop requested');

    expect(cancelled.status).toBe('completed');
    expect(cancelled.terminationReason).toBe('cancelled');
    expect(cancelled.errorMessage).toBe('stop requested');
  });

  it('moves a running session into awaiting approval when a tool is blocked for approval', () => {
    const machine = new SessionStateMachine();
    const running = machine.runTurn(
      machine.confirmTurn(machine.submitUserInput(createSession('session-4'), 'hello')),
    );

    const awaitingApproval = machine.markAwaitingApproval({
      ...running,
      pendingApprovals: [
        {
          id: 'approval-1',
          toolCallId: 'call-1',
          toolName: 'write_file',
          input: { path: 'a.txt' },
          inputSummary: '{"path":"a.txt"}',
          reason: 'file_write',
          risk: 'high',
          message: 'approval required',
          createdAt: new Date().toISOString(),
        },
      ],
    });

    expect(awaitingApproval.status).toBe('awaiting_approval');
  });
});