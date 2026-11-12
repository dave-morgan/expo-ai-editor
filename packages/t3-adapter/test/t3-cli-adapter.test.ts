import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AdapterProtocolError,
  AdapterUnavailableError,
  ThreadNotFoundError,
} from "../src/agent-adapter.js";
import type { CommandRunner } from "../src/command-runner.js";
import { createCommandRunner, quoteWindowsCommand } from "../src/command-runner.js";
import { resolveCli } from "../src/resolve-cli.js";
import { T3CliAdapter } from "../src/t3-cli-adapter.js";

const cli = { command: process.execPath, args: ["fake.mjs"] };
const thread = { threadId: "mcp:42", title: "Example", status: "running", projectId: "project" };
const result = (value: unknown) => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: "",
  timedOut: false,
});
function fakeRunner(value: unknown) {
  const calls: { args: string[]; opts: { stdin?: string; timeoutMs: number } }[] = [];
  const runner: CommandRunner = async (args, opts) => {
    calls.push({ args, opts });
    return result(value);
  };
  return { runner, calls };
}
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("T3CliAdapter", () => {
  it("exposes the CLI's actual capabilities", () => {
    expect(new T3CliAdapter({ cli }).capabilities()).toEqual({
      adapter: "t3",
      queue: true,
      steer: false,
      attachments: false,
      listThreads: true,
      runStatus: true,
    });
  });
  it("validates thread and project ids before invoking even an injected runner", async () => {
    const { runner, calls } = fakeRunner([]);
    const adapter = new T3CliAdapter({ runner, cli });
    for (const threadId of ['a"&calc', "bad id", "../outside", "--help"]) {
      await expect(adapter.getThread(threadId)).rejects.toBeInstanceOf(AdapterProtocolError);
      await expect(
        adapter.sendMessage({ threadId, message: "Change", mode: "queue" }),
      ).rejects.toBeInstanceOf(AdapterProtocolError);
    }
    await expect(adapter.listThreads('a"&calc')).rejects.toBeInstanceOf(AdapterProtocolError);
    expect(calls).toHaveLength(0);
  });
  it.each([{ threadId: 'a"&calc' }, { projectId: "bad project" }])(
    "rejects unsafe ids returned by the CLI: %o",
    async (changes) => {
      const { runner } = fakeRunner([{ ...thread, ...changes }]);
      await expect(new T3CliAdapter({ runner, cli }).listThreads("project")).rejects.toBeInstanceOf(
        AdapterProtocolError,
      );
    },
  );
  it("lists project threads, filters children and archives, and sorts newest first", async () => {
    const { runner, calls } = fakeRunner([
      { ...thread, updatedAt: "2026-01-01T00:00:00Z" },
      { ...thread, threadId: "archived", archived: true },
      { ...thread, threadId: "child", parentThreadId: "mcp:42" },
      {
        ...thread,
        threadId: "new",
        updatedAt: "2026-11-01T00:00:00Z",
        parentThreadId: null,
        extra: 1,
      },
    ]);
    const adapter = new T3CliAdapter({ runner, cli, timeoutMs: 123 });
    expect((await adapter.listThreads("C:/My Project")).map(({ threadId }) => threadId)).toEqual([
      "new",
      "mcp:42",
    ]);
    expect(calls).toEqual([
      {
        args: ["thread", "list", "--json", "--project", "C:/My Project"],
        opts: { timeoutMs: 123 },
      },
    ]);
  });
  it("sorts update times chronologically across timezone offsets", async () => {
    const { runner } = fakeRunner([
      { ...thread, threadId: "older", updatedAt: "2026-11-01T11:00:00+10:00" },
      { ...thread, threadId: "newer", updatedAt: "2026-11-01T02:00:00Z" },
    ]);
    expect(
      (await new T3CliAdapter({ runner, cli }).listThreads("project")).map(
        ({ threadId }) => threadId,
      ),
    ).toEqual(["newer", "older"]);
  });
  it("extracts thread state and the last assistant message", async () => {
    const { runner, calls } = fakeRunner({
      thread: {
        ...thread,
        activeRunId: "run:thread:x:ordinal:1",
        latestRunId: "run:thread:x:ordinal:2",
        pendingRequestCount: 1,
      },
      messages: [
        { role: "assistant", text: "Old" },
        { role: "user", text: "Change" },
        { role: "assistant", text: "Done" },
      ],
    });
    const state = await new T3CliAdapter({ runner, cli }).getThread("mcp:42");
    expect(state).toMatchObject({
      ...thread,
      pendingRequestCount: 1,
      lastAssistantMessage: "Done",
    });
    expect(calls[0]?.args).toEqual(["thread", "show", "--json", "mcp:42"]);
  });
  it.each(["queue", "steer", "auto"] as const)("sends %s through stdin as queued", async (mode) => {
    const { runner, calls } = fakeRunner({
      threadId: "mcp:42",
      runId: "run:thread:x:ordinal:2",
      link: "https://app.t3.codes/threads/x",
      delivery: "queued",
      status: "queued",
    });
    const message = 'Hello " & calc\n$HOME';
    expect(
      await new T3CliAdapter({ runner, cli }).sendMessage({ threadId: "mcp:42", message, mode }),
    ).toEqual({
      runId: "run:thread:x:ordinal:2",
      delivery: "queued",
      link: "https://app.t3.codes/threads/x",
    });
    expect(calls[0]).toEqual({
      args: ["thread", "send", "--json", "mcp:42", "-"],
      opts: { stdin: message, timeoutMs: 30_000 },
    });
  });
  it.each(["not json", "{}", '[{"threadId":42}]'])(
    "rejects malformed list output %s",
    async (stdout) => {
      const runner: CommandRunner = async () => ({ code: 0, stdout, stderr: "", timedOut: false });
      await expect(new T3CliAdapter({ runner, cli }).listThreads("project")).rejects.toBeInstanceOf(
        AdapterProtocolError,
      );
    },
  );
  it("rejects malformed state and send responses", async () => {
    const { runner } = fakeRunner({});
    const adapter = new T3CliAdapter({ runner, cli });
    await expect(adapter.getThread("mcp:42")).rejects.toBeInstanceOf(AdapterProtocolError);
    await expect(
      adapter.sendMessage({ threadId: "mcp:42", message: "Change", mode: "queue" }),
    ).rejects.toBeInstanceOf(AdapterProtocolError);
  });
  it("reports a missing CLI with installation instructions", async () => {
    const home = await mkdtemp(join(tmpdir(), "t3-missing-"));
    temporary.push(home);
    const adapter = new T3CliAdapter({
      env: { PATH: "", USERPROFILE: home, HOME: home, T3_CLI: "" },
    });
    const report = await adapter.diagnose();
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({
      name: "cli",
      ok: false,
      fix: "Install/open T3 Code desktop once, or set T3_CLI",
    });
    await expect(adapter.listThreads("project")).rejects.toMatchObject({
      code: "adapter_unavailable",
    });
  });
  it.each(["stdout", "stderr"] as const)("maps unknown thread text in %s", async (stream) => {
    const runner: CommandRunner = async () => ({
      code: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      [stream]: "Thread mcp:42 is no longer available.",
    });
    await expect(new T3CliAdapter({ runner, cli }).getThread("mcp:42")).rejects.toBeInstanceOf(
      ThreadNotFoundError,
    );
  });
  it.each([
    { code: 1, stdout: "", stderr: "Could not connect to T3 Code server", timedOut: false },
    { code: null, stdout: "", stderr: "", timedOut: true },
  ])("maps unavailable and timeout: %o", async (output) => {
    const runner: CommandRunner = async () => output;
    await expect(new T3CliAdapter({ runner, cli }).listThreads("project")).rejects.toBeInstanceOf(
      AdapterUnavailableError,
    );
  });
  it("maps unexpected command failures to protocol errors", async () => {
    const runner: CommandRunner = async () => ({
      code: 2,
      stdout: "",
      stderr: "Unsupported command",
      timedOut: false,
    });
    await expect(new T3CliAdapter({ runner, cli }).getThread("mcp:42")).rejects.toBeInstanceOf(
      AdapterProtocolError,
    );
  });
  it("strips ANSI sequences from injected runner output", async () => {
    const runner: CommandRunner = async () => ({
      code: 0,
      stdout: `\u001b[32m${JSON.stringify([thread])}\u001b[0m`,
      stderr: "",
      timedOut: false,
    });
    expect(await new T3CliAdapter({ runner, cli }).listThreads("project")).toMatchObject([thread]);
  });
  it("reports useful diagnostics including unsupported steering", async () => {
    const runner: CommandRunner = async (args) => result(args[0] === "--version" ? "1.0" : []);
    const report = await new T3CliAdapter({ runner, cli }).diagnose();
    expect(report.ok).toBe(true);
    expect(report.checks.map(({ detail }) => detail).join(" ")).toContain(
      "steer unsupported by CLI",
    );
  });
  it("diagnoses connection failures with an actionable fix", async () => {
    const runner: CommandRunner = async (args) =>
      args[0] === "--version"
        ? result("1.0")
        : { code: 1, stdout: "", stderr: "Could not connect to T3 Code server", timedOut: false };
    const report = await new T3CliAdapter({ runner, cli }).diagnose();
    expect(report.ok).toBe(false);
    expect(report.checks.find(({ ok }) => !ok)?.fix).toContain("t3 serve");
  });
});

describe("command runner", () => {
  it("quotes every Windows argument and rejects shell injection", () => {
    expect(quoteWindowsCommand("C:\\My Tools\\t3.cmd", ["thread", "show", "mcp:42"])).toBe(
      '"C:\\My Tools\\t3.cmd" "thread" "show" "mcp:42"',
    );
    for (const argument of ['a"&calc', "a&calc", "a|calc", "a%PATH%", "a\ncalc", "a$(calc)"]) {
      expect(() => quoteWindowsCommand("t3.cmd", [argument])).toThrow(AdapterProtocolError);
    }
  });
  it("passes stdin to real processes and strips ANSI", async () => {
    const runner = createCommandRunner({
      command: process.execPath,
      prefixArgs: [
        "-e",
        'process.stdin.on("data", data => process.stdout.write("\\u001b[32m" + data + "\\u001b[0m"))',
      ],
    });
    expect(await runner([], { stdin: "message & body", timeoutMs: 2000 })).toEqual({
      code: 0,
      stdout: "message & body",
      stderr: "",
      timedOut: false,
    });
  });
  it("preserves UTF-8 text split across stdout chunks", async () => {
    const runner = createCommandRunner({
      command: process.execPath,
      prefixArgs: [
        "-e",
        'const value=Buffer.from("😀"); process.stdout.write(value.subarray(0,2)); setTimeout(() => process.stdout.write(value.subarray(2)),20)',
      ],
    });
    expect((await runner([], { timeoutMs: 2000 })).stdout).toBe("😀");
  });
  it("kills a timed out process", async () => {
    const runner = createCommandRunner({
      command: process.execPath,
      prefixArgs: ["-e", "setInterval(() => {}, 1000)"],
    });
    expect((await runner([], { timeoutMs: 40 })).timedOut).toBe(true);
  });
  it("turns a missing executable into a typed unavailable error", async () => {
    const runner = createCommandRunner({
      command: join(tmpdir(), "missing-t3-executable-42"),
      prefixArgs: [],
    });
    await expect(runner([], { timeoutMs: 500 })).rejects.toBeInstanceOf(AdapterUnavailableError);
  });
});

describe("CLI resolution", () => {
  async function directory() {
    const dir = await mkdtemp(join(tmpdir(), "t3-resolve-"));
    temporary.push(dir);
    return dir;
  }
  it("prefers explicit command and prefix args", async () => {
    expect(
      await resolveCli({
        cli: { command: "custom", args: ["prefix"] },
        env: { T3_CLI: "environment" },
      }),
    ).toEqual({ command: "custom", prefixArgs: ["prefix"], source: "config" });
  });
  it("prefers T3_CLI over PATH", async () => {
    expect(await resolveCli({ env: { T3_CLI: "custom-env", PATH: "" } })).toEqual({
      command: "custom-env",
      prefixArgs: [],
      source: "env",
    });
  });
  it("finds launchers via PATH and PATHEXT", async () => {
    const dir = await directory();
    await writeFile(join(dir, "t3.cmd"), "@echo fake");
    expect(
      await resolveCli({
        env: { PATH: [join(dir, "missing"), dir].join(delimiter), PATHEXT: ".EXE;.CMD" },
        platform: "win32",
        homeDir: dir,
      }),
    ).toEqual({ command: join(dir, "t3.cmd"), prefixArgs: [], source: "path" });
  });
  it("falls back to the desktop install directory", async () => {
    const dir = await directory();
    await mkdir(join(dir, ".t3", "bin"), { recursive: true });
    const command = join(dir, ".t3", "bin", "t3.cmd");
    await writeFile(command, "@echo fake");
    expect(await resolveCli({ env: { PATH: "" }, platform: "win32", homeDir: dir })).toEqual({
      command,
      prefixArgs: [],
      source: "home",
    });
  });
  it("returns null when no CLI exists", async () => {
    expect(await resolveCli({ env: { PATH: "" }, homeDir: await directory() })).toBeNull();
  });
});
