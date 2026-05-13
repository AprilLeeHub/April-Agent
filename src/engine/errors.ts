/**
 * Summary: Narrow runtime error classes used to separate provider, tool,
 * storage, and state-machine failures.
 */

export class AgentRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ProviderRuntimeError extends AgentRuntimeError {}

export class ToolRuntimeError extends AgentRuntimeError {}

export class StorageRuntimeError extends AgentRuntimeError {}

export class StateMachineError extends AgentRuntimeError {}

export class CancelledError extends AgentRuntimeError {}