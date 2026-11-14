import type { AdapterCapabilities, DeliveryMode } from "@dave-morgan/expo-ai-protocol";
import { SafeIdSchema } from "@dave-morgan/expo-ai-protocol";
import { stripVTControlCharacters } from "node:util";

import { z } from "zod";

import type {
  AgentAdapter,
  AgentThread,
  AgentThreadState,
  DiagnosticReport,
  RunPhase,
  SendResult,
} from "./agent-adapter.js";
import {
  AdapterProtocolError,
  AdapterUnavailableError,
  ThreadNotFoundError,
} from "./agent-adapter.js";
import type { CommandRunner } from "./command-runner.js";
import { createCommandRunner } from "./command-runner.js";
import type { CliConfig } from "./resolve-cli.js";
import { resolveCli } from "./resolve-cli.js";
import { classifyRun } from "./run-classifier.js";

export interface T3CliAdapterOptions {
  runner?: CommandRunner;
  cli?: CliConfig;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

const ThreadSchema = z
  .object({
    threadId: SafeIdSchema,
    title: z.string(),
    status: z.string(),
    projectId: SafeIdSchema.optional(),
    updatedAt: z.string().optional(),
    model: z.string().optional(),
    link: z.string().optional(),
    archived: z.unknown().optional(),
    parentThreadId: z.string().nullable().optional(),
  })
  .passthrough();
const StateSchema = z
  .object({
    thread: ThreadSchema.extend({
      activeRunId: z.string().nullable(),
      latestRunId: z.string().nullable(),
      pendingRequestCount: z.number().int().nonnegative(),
    }),
    messages: z.array(z.object({ role: z.string(), text: z.string() }).passthrough()),
  })
  .passthrough();
const SendSchema = z
  .object({ runId: z.string().nullable(), link: z.string().optional() })
  .passthrough();
const INSTALL_FIX = "Install/open T3 Code desktop once, or set T3_CLI";
const SERVER_FIX = "Start T3 Code (desktop app or `t3 serve`)";

function validateId(value: string) {
  if (!SafeIdSchema.safeParse(value).success)
    throw new AdapterProtocolError("Invalid thread or project id");
}

function updatedAtTime(thread: AgentThread) {
  return Date.parse(thread.updatedAt ?? "") || 0;
}

export class T3CliAdapter implements AgentAdapter {
  readonly id = "t3";
  private readonly options: T3CliAdapterOptions;
  constructor(options: T3CliAdapterOptions = {}) {
    this.options = options;
  }

  capabilities(): AdapterCapabilities {
    return {
      adapter: this.id,
      queue: true,
      steer: false,
      attachments: false,
      listThreads: true,
      runStatus: true,
    };
  }

  private async runner(): Promise<CommandRunner> {
    if (this.options.runner) return this.options.runner;
    const cli = await resolveCli({ cli: this.options.cli, env: this.options.env });
    if (!cli) throw new AdapterUnavailableError(`T3 CLI was not found. ${INSTALL_FIX}`);
    return createCommandRunner(cli, { env: this.options.env });
  }

  private async execute(args: string[], stdin?: string): Promise<string> {
    const runner = await this.runner();
    const output = await runner(args, {
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: this.options.timeoutMs ?? 30_000,
    });
    const stdout = stripVTControlCharacters(output.stdout).trim();
    const stderr = stripVTControlCharacters(output.stderr).trim();
    if (output.timedOut) throw new AdapterUnavailableError("T3 CLI timed out");
    const detail = [stderr, stdout].filter(Boolean).join("\n");
    if (/Thread .+ is no longer available\./i.test(detail)) throw new ThreadNotFoundError(detail);
    if (output.code !== 0) {
      if (
        /could not connect|cannot connect|connection refused|ECONNREFUSED|server.*not running|ENOENT|not recognized|not found/i.test(
          detail,
        )
      ) {
        throw new AdapterUnavailableError(detail || "T3 Code server is unavailable");
      }
      throw new AdapterProtocolError(detail || `T3 CLI exited with code ${output.code}`);
    }
    return stdout;
  }

  private parse<T>(schema: z.ZodType<T>, output: string): T {
    try {
      return schema.parse(JSON.parse(output));
    } catch (cause) {
      throw new AdapterProtocolError("T3 CLI returned invalid JSON or an unexpected response", {
        cause,
      });
    }
  }

  async diagnose(): Promise<DiagnosticReport> {
    const checks: DiagnosticReport["checks"] = [];
    const resolved = await resolveCli({ cli: this.options.cli, env: this.options.env });
    checks.push({
      name: "cli",
      ok: resolved !== null || this.options.runner !== undefined,
      detail: resolved
        ? `${resolved.command} (${resolved.source})`
        : this.options.runner
          ? "Injected command runner"
          : "T3 CLI was not found",
      fix: INSTALL_FIX,
    });
    if (checks[0]?.ok) {
      for (const [name, args, fix] of [
        ["version", ["--version"], INSTALL_FIX],
        ["server", ["thread", "list", "--json"], SERVER_FIX],
      ] as const) {
        try {
          const output = await this.execute([...args]);
          if (name === "server") this.parse(z.array(ThreadSchema), output);
          checks.push({
            name,
            ok: true,
            detail: name === "version" ? output : "T3 Code server is reachable",
          });
        } catch (error) {
          checks.push({
            name,
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
            fix,
          });
        }
      }
    }
    checks.push({
      name: "capabilities",
      ok: true,
      detail:
        "queue, listThreads, runStatus supported; steer unsupported by CLI; attachments unsupported",
    });
    return { ok: checks.every(({ ok }) => ok), checks };
  }

  async listThreads(projectRef: string): Promise<AgentThread[]> {
    if (!/[\\/]/.test(projectRef) && !projectRef.startsWith(".")) validateId(projectRef);
    return this.parse(
      z.array(ThreadSchema),
      await this.execute(["thread", "list", "--json", "--project", projectRef]),
    )
      .filter((thread) => thread.archived !== true && thread.parentThreadId == null)
      .sort((left, right) => updatedAtTime(right) - updatedAtTime(left))
      .map(({ threadId, title, status, updatedAt, model, link, projectId }) => ({
        threadId,
        title,
        status,
        updatedAt,
        model,
        link,
        projectId,
      }));
  }

  async getThread(threadId: string): Promise<AgentThreadState> {
    validateId(threadId);
    const { thread, messages } = this.parse(
      StateSchema,
      await this.execute(["thread", "show", "--json", threadId]),
    );
    const lastAssistantMessage = messages.filter(({ role }) => role === "assistant").at(-1)?.text;
    const {
      title,
      status,
      updatedAt,
      model,
      link,
      projectId,
      activeRunId,
      latestRunId,
      pendingRequestCount,
    } = thread;
    return {
      threadId: thread.threadId,
      title,
      status,
      updatedAt,
      model,
      link,
      projectId,
      activeRunId,
      latestRunId,
      pendingRequestCount,
      lastAssistantMessage,
    };
  }

  async sendMessage(input: {
    threadId: string;
    message: string;
    mode: DeliveryMode;
  }): Promise<SendResult> {
    validateId(input.threadId);
    const result = this.parse(
      SendSchema,
      await this.execute(["thread", "send", "--json", input.threadId, "-"], input.message),
    );
    return { runId: result.runId, link: result.link, delivery: "queued" };
  }

  classifyRun(state: AgentThreadState, runId: string | null): RunPhase {
    return classifyRun(state, runId);
  }
}
