import { resolveWorktree } from "./worktree.js";
import { SafeIdSchema } from "@dave-morgan/expo-ai-protocol";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

const projectSchema = z
  .object({
    id: SafeIdSchema,
    name: z.string().min(1).optional(),
    root: z.string().min(1),
    t3Project: z.string().min(1),
    t3ProjectWorktree: z.string().optional(),
    defaultThreadId: SafeIdSchema.optional(),
    allowedThreadIds: z.array(SafeIdSchema).optional(),
  })
  .transform((project) => ({ ...project, name: project.name ?? project.id }));

export const BridgeConfigSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(8790),
  projects: z
    .array(projectSchema)
    .min(1)
    .refine(
      (projects) => new Set(projects.map((project) => project.id)).size === projects.length,
      "duplicate project ids",
    ),
  screenshots: z
    .object({
      enabled: z.boolean().default(true),
      dir: z.string().min(1).default(".expo-ai/screenshots"),
      maxBytes: z.number().int().positive().default(4_500_000),
    })
    .default({ enabled: true, dir: ".expo-ai/screenshots", maxBytes: 4_500_000 }),
  t3: z
    .object({
      command: z.string().min(1).optional(),
      args: z.array(z.string()).default([]),
      pollIntervalMs: z.number().int().positive().default(2000),
      timeoutMs: z.number().int().positive().default(30_000),
    })
    .default({ args: [], pollIntervalMs: 2000, timeoutMs: 30_000 }),
  pairing: z
    .object({
      controlDir: z.string().min(1).optional(),
      codeTtlSeconds: z.number().positive().default(600),
      tokenTtlHours: z.number().positive().default(12),
      sessionsFile: z
        .string()
        .min(1)
        .default(() => resolve(homedir(), ".expo-ai-bridge/sessions.json")),
    })
    .default({
      codeTtlSeconds: 600,
      tokenTtlHours: 12,
      sessionsFile: resolve(homedir(), ".expo-ai-bridge/sessions.json"),
    }),
});
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;
export type BridgeProject = BridgeConfig["projects"][number];
export interface BridgeFlags {
  projectId?: string;
  projectRoot?: string;
  t3Project?: string;
  thread?: string;
  host?: string;
  port?: number;
  lan?: boolean;
}

export function parseCliArgs(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "project-id": { type: "string" },
      "project-root": { type: "string" },
      "t3-project": { type: "string" },
      thread: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      lan: { type: "boolean" },
    },
  });
  const command = z
    .enum(["start", "doctor", "threads", "pair-code"])
    .parse(positionals[0] ?? "start");
  if (positionals.length > 1) throw new Error("Unexpected command arguments");
  const port = values.port === undefined ? undefined : Number(values.port);
  if (
    port !== undefined &&
    (!/^\d+$/.test(values.port ?? "") || !Number.isInteger(port) || port > 65535)
  )
    throw new Error("port must be an integer from 0 to 65535");
  return {
    command,
    configPath: values.config,
    flags: {
      projectId: values["project-id"],
      projectRoot: values["project-root"],
      t3Project: values["t3-project"],
      thread: values.thread,
      host: values.host,
      port,
      lan: values.lan,
    } satisfies BridgeFlags,
  };
}

function isPathReference(value: string) {
  return (
    isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

export async function loadConfig({
  cwd = process.cwd(),
  configPath,
  flags = {},
  resolveGit = resolveWorktree,
}: {
  cwd?: string;
  configPath?: string;
  flags?: BridgeFlags;
  resolveGit?: (path: string) => Promise<string>;
} = {}): Promise<BridgeConfig> {
  const path = resolve(cwd, configPath ?? "expo-ai-bridge.config.json");
  let raw: unknown;
  let base = dirname(path);
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      configPath === undefined
    ))
      throw error;
    if (!flags.projectId || !flags.projectRoot)
      throw new Error("Provide expo-ai-bridge.config.json or --project-id and --project-root");
    base = cwd;
    raw = {
      projects: [
        {
          id: flags.projectId,
          root: flags.projectRoot,
          t3Project: flags.t3Project ?? flags.projectRoot,
        },
      ],
    };
  }
  const config = BridgeConfigSchema.parse(raw);
  if (flags.host !== undefined) config.host = flags.host;
  if (flags.lan) config.host = "0.0.0.0";
  if (flags.port !== undefined) config.port = flags.port;
  if (flags.projectRoot || flags.t3Project || flags.thread) {
    const project =
      config.projects.find((item) => item.id === flags.projectId) ??
      (config.projects.length === 1 ? config.projects[0] : undefined);
    if (!project) throw new Error("Use --project-id to choose the project to override");
    if (flags.projectRoot) project.root = resolve(cwd, flags.projectRoot);
    if (flags.t3Project)
      project.t3Project = isPathReference(flags.t3Project)
        ? resolve(cwd, flags.t3Project)
        : flags.t3Project;
    if (flags.thread) project.defaultThreadId = flags.thread;
  }
  for (const project of config.projects) {
    project.root = resolve(base, project.root);
    if (isPathReference(project.t3Project)) {
      const original = resolve(base, project.t3Project);
      project.t3Project = await resolveGit(original);
      if (original !== project.t3Project) project.t3ProjectWorktree = original;
    }
  }
  config.pairing.controlDir = resolve(
    base,
    config.pairing.controlDir ?? resolve(homedir(), ".expo-ai-bridge"),
  );
  config.pairing.sessionsFile = resolve(base, config.pairing.sessionsFile);
  if (config.t3.command && isPathReference(config.t3.command))
    config.t3.command = resolve(base, config.t3.command);
  return BridgeConfigSchema.parse(config);
}

export function isLoopbackHost(host: string) {
  return (
    host.toLowerCase() === "localhost" ||
    host === "::1" ||
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)
  );
}
