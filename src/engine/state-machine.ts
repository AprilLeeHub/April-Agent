/**
 * Summary: Explicit session state transitions for user input, confirmation,
 * execution, completion, cancellation, and failure.
 */

import { StateMachineError } from './errors.js';
import type { AgentSession, RuntimeStatus, TerminationReason } from '../types/index.js';

function touch(session: AgentSession, status: RuntimeStatus): AgentSession {
  return {
    ...session,
    status,
    updatedAt: new Date().toISOString(),
  };
}

function clearOptionalState(
  session: AgentSession,
): Omit<AgentSession, 'pendingUserTurn' | 'terminationReason' | 'errorMessage'> {
  const {
    pendingUserTurn: _pendingUserTurn,
    terminationReason: _terminationReason,
    errorMessage: _errorMessage,
    ...rest
  } = session;

  return rest;
}

export class SessionStateMachine {
  submitUserInput(session: AgentSession, content: string): AgentSession {
    if (session.status !== 'awaiting_input' && session.status !== 'completed') {
      throw new StateMachineError(
        `Cannot submit user input while session is ${session.status}.`,
      );
    }

    return {
      ...touch(clearOptionalState(session), 'awaiting_confirmation'),
      pendingUserTurn: {
        content,
        submittedAt: new Date().toISOString(),
      },
    };
  }

  confirmTurn(session: AgentSession): AgentSession {
    if (session.status !== 'awaiting_confirmation' || !session.pendingUserTurn) {
      throw new StateMachineError('Cannot confirm a turn without pending user input.');
    }

    return {
      ...touch(session, 'awaiting_confirmation'),
      pendingUserTurn: {
        ...session.pendingUserTurn,
        confirmedAt: new Date().toISOString(),
      },
    };
  }

  runTurn(session: AgentSession): AgentSession {
    if (session.status !== 'awaiting_confirmation') {
      throw new StateMachineError(`Cannot run turn while session is ${session.status}.`);
    }

    if (!session.pendingUserTurn?.confirmedAt) {
      throw new StateMachineError('Cannot run turn before the pending user input is confirmed.');
    }

    return touch(session, 'running');
  }

  markAwaitingApproval(session: AgentSession): AgentSession {
    if (session.status !== 'running') {
      throw new StateMachineError(
        `Cannot pause for approval while session is ${session.status}.`,
      );
    }

    if (session.pendingApprovals.length === 0) {
      throw new StateMachineError('Cannot enter approval state without pending approvals.');
    }

    return touch(session, 'awaiting_approval');
  }

  resumeAfterApproval(session: AgentSession): AgentSession {
    if (session.status !== 'awaiting_approval') {
      throw new StateMachineError(
        `Cannot resume after approval while session is ${session.status}.`,
      );
    }

    if (session.pendingApprovals.length > 0) {
      throw new StateMachineError('Cannot resume while pending approvals still exist.');
    }

    return touch(session, 'running');
  }

  markCompleted(session: AgentSession, terminationReason: TerminationReason): AgentSession {
    if (session.status !== 'running' && session.status !== 'awaiting_confirmation') {
      throw new StateMachineError(
        `Cannot complete a session while it is ${session.status}.`,
      );
    }

    return {
      ...touch(clearOptionalState(session), 'completed'),
      terminationReason,
    };
  }

  markError(session: AgentSession, errorMessage: string): AgentSession {
    return {
      ...touch(clearOptionalState(session), 'errored'),
      errorMessage,
      terminationReason: 'error',
    };
  }

  cancel(session: AgentSession, reason = 'cancelled'): AgentSession {
    if (
      session.status !== 'running'
      && session.status !== 'awaiting_confirmation'
      && session.status !== 'awaiting_approval'
    ) {
      throw new StateMachineError(`Cannot cancel a session while it is ${session.status}.`);
    }

    return {
      ...touch(clearOptionalState(session), 'completed'),
      terminationReason: 'cancelled',
      errorMessage: reason,
    };
  }
}