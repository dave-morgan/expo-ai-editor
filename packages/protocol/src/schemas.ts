import { z } from "zod";

/**
 * Wire protocol shared by expo-ai-inspector (mobile) and expo-ai-bridge (Node).
 *
 * Every frame is a JSON object with a `type` discriminator. Frames sent by the
 * inspector are `ClientMessage`; frames sent by the bridge are `ServerMessage`.
 * The protocol is versioned through `PROTOCOL_VERSION`; the `hello` handshake
 * carries the client version and the bridge rejects unsupported versions.
 */
export const PROTOCOL_VERSION = 1 as const;

export const LIMITS = {
  /** Hard cap on a single WebSocket frame, enforced by the bridge. */
  maxFrameBytes: 8 * 1024 * 1024,
  maxInstructionChars: 4000,
  /** Base64 length cap for screenshots (~4.5 MB decoded). */
  maxScreenshotBase64Chars: 6 * 1024 * 1024,
  maxVisibleTextChars: 500,
  maxHierarchyDepth: 24,
  maxStyleEntries: 40,
} as const;

/** Identifiers that are safe to log, use as map keys and pass as CLI arguments. */
export const SafeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be alphanumeric with . _ : -");

export const RequestIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "must be url-safe");

export const BoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type Bounds = z.infer<typeof BoundsSchema>;

export const SourceLocationSchema = z.object({
  /** Path relative to the project root, POSIX separators. Never fabricated. */
  file: z.string().min(1).max(1024),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative().optional(),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

/**
 * Where the source information came from, best first.
 * - `babel-transform`: injected by expo-ai-inspector/babel at the JSX call site.
 * - `react-debug-source`: legacy React `_debugSource` (React <= 18 only).
 * - `none`: no source information was available.
 */
export const SourceOriginSchema = z.enum(["babel-transform", "react-debug-source", "none"]);
export type SourceOrigin = z.infer<typeof SourceOriginSchema>;

export const ComponentFrameSchema = z.object({
  name: z.string().min(1).max(200),
  /** JSX call site that created this element, when known. */
  source: SourceLocationSchema.optional(),
  /** True when the component is defined inside node_modules or React Native itself. */
  isLibrary: z.boolean().default(false),
});
export type ComponentFrame = z.infer<typeof ComponentFrameSchema>;

export const ConfidenceSchema = z.enum(["high", "medium", "low", "none"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const StyleValueSchema = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);

export const SelectionSchema = z.object({
  /** Current route (expo-router pathname) when available. */
  screen: z.string().max(512).optional(),
  /** Host element type, e.g. `View`, `Text`, `RCTScrollView`. */
  elementType: z.string().min(1).max(200),
  /** Nearest user-land (non-library) component that rendered the host element. */
  componentName: z.string().max(200).optional(),
  /** Most relevant editable source location (JSX call site for the selected element). */
  source: SourceLocationSchema.optional(),
  /** Source location of the owning component's definition site when known. */
  componentSource: SourceLocationSchema.optional(),
  sourceOrigin: SourceOriginSchema,
  confidence: ConfidenceSchema,
  /** Human-readable reasons why confidence is reduced. */
  confidenceNotes: z.array(z.string().max(300)).max(10).default([]),
  /** Innermost first. */
  hierarchy: z.array(ComponentFrameSchema).max(LIMITS.maxHierarchyDepth).default([]),
  visibleText: z.string().max(LIMITS.maxVisibleTextChars).optional(),
  testID: z.string().max(200).optional(),
  accessibilityLabel: z.string().max(300).optional(),
  accessibilityRole: z.string().max(100).optional(),
  nativeID: z.string().max(200).optional(),
  /** Window coordinates in density-independent pixels. */
  bounds: BoundsSchema,
  /** Flattened, size-limited subset of the host element style. */
  style: z.record(z.string(), StyleValueSchema).optional(),
  /** Number of other host elements that were also under the touch point. */
  overlappingCandidates: z.number().int().nonnegative().optional(),
});
export type Selection = z.infer<typeof SelectionSchema>;

export const ScreenshotSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png"]),
  base64: z.string().min(1).max(LIMITS.maxScreenshotBase64Chars),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Pixel ratio between screenshot pixels and window dp. */
  scale: z.number().positive().default(1),
});
export type Screenshot = z.infer<typeof ScreenshotSchema>;

/**
 * - `queue`: deliver as the thread's next turn; never interrupt (default, safest).
 * - `steer`: inject into the running turn when the adapter supports it.
 * - `auto`: steer if supported and the thread is running, otherwise queue.
 */
export const DeliveryModeSchema = z.enum(["queue", "steer", "auto"]);
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

export const DeviceInfoSchema = z.object({
  platform: z.enum(["ios", "android", "web", "other"]),
  osVersion: z.string().max(64).optional(),
  deviceName: z.string().max(128).optional(),
  windowWidth: z.number().positive().optional(),
  windowHeight: z.number().positive().optional(),
  pixelRatio: z.number().positive().optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const FeedbackSchema = z.object({
  requestId: RequestIdSchema,
  projectId: SafeIdSchema,
  /** Target thread. When omitted the bridge uses the session's selected thread. */
  threadId: SafeIdSchema.optional(),
  instruction: z.string().trim().min(1).max(LIMITS.maxInstructionChars),
  inputMethod: z.enum(["voice", "typed", "voice-edited"]),
  mode: DeliveryModeSchema.default("queue"),
  selection: SelectionSchema.optional(),
  screenshot: ScreenshotSchema.optional(),
  createdAt: z.string().datetime(),
});
export type Feedback = z.infer<typeof FeedbackSchema>;

/** Lifecycle of a feedback request as reported by the bridge. */
export const RequestPhaseSchema = z.enum([
  "received",
  "queued",
  "submitted",
  "agent_working",
  "agent_waiting",
  "agent_completed",
  "agent_failed",
  "source_changed",
  "refresh_observed",
  "refresh_failed",
  "native_rebuild_required",
  "cancelled",
  "failed",
]);
export type RequestPhase = z.infer<typeof RequestPhaseSchema>;

export const ThreadSummarySchema = z.object({
  threadId: SafeIdSchema,
  title: z.string().max(500),
  status: z.string().max(64),
  updatedAt: z.string().max(64).optional(),
  model: z.string().max(128).optional(),
  link: z.string().max(1024).optional(),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const AdapterCapabilitiesSchema = z.object({
  adapter: z.string(),
  listThreads: z.boolean(),
  queue: z.boolean(),
  steer: z.boolean(),
  attachments: z.boolean(),
  runStatus: z.boolean(),
});
export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;

// ---------------------------------------------------------------------------
// Client -> bridge
// ---------------------------------------------------------------------------

export const HelloMessageSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  /** Session token obtained from POST /pair. */
  token: z.string().min(16).max(256),
  projectId: SafeIdSchema,
  clientId: SafeIdSchema,
  inspectorVersion: z.string().max(32).optional(),
  device: DeviceInfoSchema,
});

export const SubmitMessageSchema = z.object({
  type: z.literal("feedback.submit"),
  feedback: FeedbackSchema,
});

export const CancelMessageSchema = z.object({
  type: z.literal("feedback.cancel"),
  requestId: RequestIdSchema,
});

export const ListThreadsMessageSchema = z.object({
  type: z.literal("threads.list"),
});

export const SelectThreadMessageSchema = z.object({
  type: z.literal("threads.select"),
  threadId: SafeIdSchema,
});

/** Reported by the inspector when it observes a Fast Refresh or a refresh error. */
export const RefreshEventMessageSchema = z.object({
  type: z.literal("refresh.event"),
  kind: z.enum(["applied", "full-reload", "error"]),
  message: z.string().max(2000).optional(),
  at: z.string().datetime(),
});

export const PingMessageSchema = z.object({
  type: z.literal("ping"),
  at: z.number(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  HelloMessageSchema,
  SubmitMessageSchema,
  CancelMessageSchema,
  ListThreadsMessageSchema,
  SelectThreadMessageSchema,
  RefreshEventMessageSchema,
  PingMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageInput = z.input<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------
// Bridge -> client
// ---------------------------------------------------------------------------

export const WelcomeMessageSchema = z.object({
  type: z.literal("welcome"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  bridgeVersion: z.string(),
  sessionId: z.string(),
  project: z.object({ id: SafeIdSchema, name: z.string() }),
  selectedThreadId: SafeIdSchema.nullable(),
  capabilities: AdapterCapabilitiesSchema,
  screenshotsAccepted: z.boolean(),
});

export const ThreadsMessageSchema = z.object({
  type: z.literal("threads"),
  threads: z.array(ThreadSummarySchema),
  selectedThreadId: SafeIdSchema.nullable(),
  error: z.string().optional(),
});

export const AckMessageSchema = z.object({
  type: z.literal("feedback.ack"),
  requestId: RequestIdSchema,
  result: z.enum(["accepted", "duplicate", "rejected"]),
  reason: z.string().optional(),
});

export const StatusMessageSchema = z.object({
  type: z.literal("request.status"),
  requestId: RequestIdSchema,
  phase: RequestPhaseSchema,
  threadId: SafeIdSchema.optional(),
  detail: z.string().max(4000).optional(),
  changedFiles: z.array(z.string().max(1024)).max(50).optional(),
  at: z.string(),
});

export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.enum([
    "unauthorized",
    "unsupported_version",
    "unknown_project",
    "invalid_message",
    "payload_too_large",
    "no_thread_selected",
    "adapter_unavailable",
    "rate_limited",
    "internal",
  ]),
  message: z.string(),
  /** When true the client should not reconnect automatically. */
  fatal: z.boolean().default(false),
});

export const PongMessageSchema = z.object({
  type: z.literal("pong"),
  at: z.number(),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  WelcomeMessageSchema,
  ThreadsMessageSchema,
  AckMessageSchema,
  StatusMessageSchema,
  ErrorMessageSchema,
  PongMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageInput = z.input<typeof ServerMessageSchema>;

// ---------------------------------------------------------------------------
// HTTP pairing
// ---------------------------------------------------------------------------

export const PairRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "pairing code is 6 digits"),
  projectId: SafeIdSchema,
  clientId: SafeIdSchema,
  deviceName: z.string().max(128).optional(),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  projectId: SafeIdSchema,
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

export type FeedbackInput = z.input<typeof FeedbackSchema>;
export type SelectionInput = z.input<typeof SelectionSchema>;
