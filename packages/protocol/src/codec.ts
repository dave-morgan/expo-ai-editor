import { z } from "zod";
import {
  ClientMessageSchema,
  LIMITS,
  ServerMessageSchema,
  type ClientMessage,
  type ClientMessageInput,
  type ServerMessage,
  type ServerMessageInput,
} from "./schemas.js";

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: string };

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function decode<T>(schema: z.ZodType<T>, raw: unknown): DecodeResult<T> {
  let data: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > LIMITS.maxFrameBytes) return { ok: false, error: "frame too large" };
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: "frame is not valid JSON" };
    }
  }
  const parsed = schema.safeParse(data);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: formatIssues(parsed.error) };
}

export const decodeClientMessage = (raw: unknown): DecodeResult<ClientMessage> =>
  decode(ClientMessageSchema, raw);

export const decodeServerMessage = (raw: unknown): DecodeResult<ServerMessage> =>
  decode(ServerMessageSchema, raw);

/** Validates then serializes. Throws on invalid input so bugs surface at the sender. */
export function encodeClientMessage(message: ClientMessageInput): string {
  return JSON.stringify(ClientMessageSchema.parse(message));
}

export function encodeServerMessage(message: ServerMessageInput): string {
  return JSON.stringify(ServerMessageSchema.parse(message));
}

/** RFC 4122-ish v4 id without depending on crypto.randomUUID (missing on older Hermes). */
export function createRequestId(random: () => number = Math.random): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
