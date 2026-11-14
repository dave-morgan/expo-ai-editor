import type { AdapterCapabilities, DeliveryMode } from "@dave-morgan/expo-ai-protocol";

export interface AgentThread {
  threadId: string;
  title: string;
  status: string;
  updatedAt?: string;
  model?: string;
  link?: string;
  projectId?: string;
}

export interface AgentThreadState extends AgentThread {
  activeRunId: string | null;
  latestRunId: string | null;
  pendingRequestCount: number;
  lastAssistantMessage?: string;
}

export interface SendResult {
  runId: string | null;
  delivery: "queued" | "steered" | "started";
  link?: string;
}

export type RunPhase = "queued" | "working" | "waiting" | "completed" | "failed" | "unknown";

export interface DiagnosticReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string; fix?: string }[];
}

export interface AgentAdapter {
  readonly id: string;
  capabilities(): AdapterCapabilities;
  diagnose(): Promise<DiagnosticReport>;
  listThreads(projectRef: string): Promise<AgentThread[]>;
  getThread(threadId: string): Promise<AgentThreadState>;
  sendMessage(input: {
    threadId: string;
    message: string;
    mode: DeliveryMode;
  }): Promise<SendResult>;
  classifyRun(state: AgentThreadState, runId: string | null): RunPhase;
}

export class AgentAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AdapterUnavailableError extends AgentAdapterError {
  constructor(message = "T3 Code is unavailable", options?: ErrorOptions) {
    super("adapter_unavailable", message, options);
  }
}

export class ThreadNotFoundError extends AgentAdapterError {
  constructor(message = "Thread is no longer available", options?: ErrorOptions) {
    super("thread_not_found", message, options);
  }
}

export class AdapterProtocolError extends AgentAdapterError {
  constructor(message = "Unexpected T3 CLI output", options?: ErrorOptions) {
    super("adapter_protocol_error", message, options);
  }
}
