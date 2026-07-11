import type {
  GenerateTextRequest,
  TextGenerationService,
} from "../llms/text-generation-service";
import type { EditorSnapshot, ParagraphRef } from "../voice/types";
import { hashOriginalText, parseAndValidateAgentEditOperations } from "./edit-protocol";
import type { AgentEditOperation, AgentEditProtocolError } from "./types";

export type AgentContextScope =
  | "selection"
  | "current-block"
  | "document-outline"
  | "document";

export type AgentContext =
  | {
      kind: "selection";
      revision: number;
      from: number;
      to: number;
      text: string;
      originalTextHash: string;
    }
  | {
      kind: "current-block";
      revision: number;
      index: number;
      from: number;
      to: number;
      text: string;
      originalTextHash: string;
    }
  | {
      kind: "document-outline";
      revision: number;
      blocks: Array<{
        index: number;
        nodeType: string;
        from: number;
        to: number;
        length: number;
        originalTextHash: string;
      }>;
    }
  | {
      kind: "document";
      revision: number;
      text: string;
      targets: Array<{
        from: number;
        to: number;
        originalTextHash: string;
      }>;
    };

export interface AgentEditorBridge {
  getRevision(): number;
  getSnapshot(): EditorSnapshot;
  addAgentSuggestions(
    operations: readonly AgentEditOperation[],
    canCommit?: () => boolean,
  ): Promise<{ ok: boolean; value?: string[] }>;
  onRevisionChange(listener: (revision: number) => void): () => void;
}

export interface AgentSessionRequest {
  instruction: string;
  context?: AgentContextScope;
}

export type AgentSessionResult =
  | { status: "suggested"; suggestionIds: string[] }
  | { status: "cancelled" }
  | { status: "stale-revision" }
  | { status: "invalid-output"; error: AgentEditProtocolError }
  | { status: "suggestion-rejected" }
  | { status: "error"; error: Error };

export interface AgentSessionState {
  phase: "idle" | "running" | "completed" | "cancelled" | "error";
  sessionId: number | null;
  revision: number | null;
  result: AgentSessionResult | null;
}

export interface AgentSessionControllerOptions {
  bridge: AgentEditorBridge;
  generator: Pick<TextGenerationService, "generate">;
  temperature: number;
  userConfig: GenerateTextRequest["userConfig"];
  userID: string;
  createOutputAccumulator?: () => AgentOutputAccumulatorPort;
}

interface ActiveSession {
  id: number;
  revision: number;
  controller: AbortController;
  invalidated: "cancelled" | "stale-revision" | null;
}

/**
 * A transport-neutral boundary for a future streaming generator.  The current
 * text generation service returns one completed string, so no network
 * streaming is invented here; consumers cannot read a partial JSON payload.
 */
export interface AgentOutputAccumulatorPort {
  append(chunk: string): void;
  finish(): string;
  completeText(): string | null;
}

export class AgentOutputAccumulator implements AgentOutputAccumulatorPort {
  #chunks: string[] = [];
  #finished = false;

  append(chunk: string) {
    if (this.#finished) throw new Error("Cannot append after completion");
    this.#chunks.push(chunk);
  }

  finish() {
    this.#finished = true;
    return this.#chunks.join("");
  }

  completeText() {
    return this.#finished ? this.#chunks.join("") : null;
  }
}

const paragraphForCurrentBlock = (snapshot: EditorSnapshot): ParagraphRef | null =>
  snapshot.paragraphs[snapshot.currentParagraphIndex] ?? null;

const documentText = (snapshot: EditorSnapshot) =>
  snapshot.paragraphs
    .map((paragraph) => `${paragraph.separatorBefore ?? ""}${paragraph.text}`)
    .join("");

const hashFor = async (text: string) => {
  const result = await hashOriginalText(text);
  if (!result.ok) throw new Error("Unable to create a trusted source hash");
  return result.hash;
};

/**
 * Reads only the context granted by the caller.  The document scope is kept
 * explicit because it is the only scope that may include all document text.
 */
export const readAgentContext = async (
  snapshot: EditorSnapshot,
  scope: AgentContextScope,
): Promise<AgentContext> => {
  if (scope === "selection") {
    if (!snapshot.selection) {
      throw new Error("No selection is available for the agent session");
    }
    return {
      kind: "selection",
      revision: snapshot.revision,
      from: snapshot.selection.from,
      to: snapshot.selection.to,
      text: snapshot.selection.text,
      originalTextHash: await hashFor(snapshot.selection.text),
    };
  }

  if (scope === "current-block") {
    const paragraph = paragraphForCurrentBlock(snapshot);
    if (!paragraph) {
      throw new Error("No current block is available for the agent session");
    }
    return {
      kind: "current-block",
      revision: snapshot.revision,
      index: paragraph.index,
      from: paragraph.from,
      to: paragraph.to,
      text: paragraph.text,
      originalTextHash: await hashFor(paragraph.text),
    };
  }

  if (scope === "document-outline") {
    return {
      kind: "document-outline",
      revision: snapshot.revision,
      blocks: await Promise.all(snapshot.paragraphs.map(async (paragraph) => ({
        index: paragraph.index,
        nodeType: paragraph.nodeType,
        from: paragraph.from,
        to: paragraph.to,
        length: paragraph.text.length,
        originalTextHash: await hashFor(paragraph.text),
      }))),
    };
  }

  return {
    kind: "document",
    revision: snapshot.revision,
    text: documentText(snapshot),
    targets: await Promise.all(snapshot.paragraphs.map(async (paragraph) => ({
      from: paragraph.from,
      to: paragraph.to,
      originalTextHash: await hashFor(paragraph.text),
    }))),
  };
};

const isAbortError = (error: unknown) =>
  (error instanceof Error && error.name === "AbortError") ||
  (typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError");

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

const promptFor = (instruction: string, context: AgentContext) =>
  [
    "You are a document editing agent.",
    "Return only a JSON array of edit operations; do not wrap it in Markdown or add commentary.",
    "Each operation must use replaceRange, insertAfterRange, or deleteRange and include id, revision, from, to, originalTextHash, and replacement where required.",
    "Use only range/hash pairs supplied by CONTEXT. Copy originalTextHash exactly from the trusted context; never calculate or invent a hash.",
    `INSTRUCTION:\n${JSON.stringify(instruction)}`,
    `CONTEXT:\n${JSON.stringify(context)}`,
  ].join("\n\n");

const targetsFor = (context: AgentContext) => {
  if (context.kind === "document") return context.targets;
  if (context.kind === "document-outline") {
    return context.blocks.map(({ from, to, originalTextHash }) => ({
      from,
      to,
      originalTextHash,
    }));
  }
  return [{
    from: context.from,
    to: context.to,
    originalTextHash: context.originalTextHash,
  }];
};

const firstOperationOutsideTrustedContext = (
  operations: readonly AgentEditOperation[],
  context: AgentContext,
) => {
  const targets = targetsFor(context);
  return operations.find((operation) => !targets.some((target) =>
    target.from === operation.from &&
    target.to === operation.to &&
    target.originalTextHash === operation.originalTextHash,
  ));
};

export class AgentSessionController extends EventTarget {
  readonly #bridge: AgentEditorBridge;
  readonly #generator: Pick<TextGenerationService, "generate">;
  readonly #temperature: number;
  readonly #userConfig: GenerateTextRequest["userConfig"];
  readonly #userID: string;
  readonly #createOutputAccumulator: () => AgentOutputAccumulatorPort;
  #nextSessionId = 0;
  #active: ActiveSession | null = null;
  #state: AgentSessionState = {
    phase: "idle",
    sessionId: null,
    revision: null,
    result: null,
  };
  #unsubscribeRevision: (() => void) | null = null;

  constructor({
    bridge,
    generator,
    temperature,
    userConfig,
    userID,
    createOutputAccumulator = () => new AgentOutputAccumulator(),
  }: AgentSessionControllerOptions) {
    super();
    this.#bridge = bridge;
    this.#generator = generator;
    this.#temperature = temperature;
    this.#userConfig = userConfig;
    this.#userID = userID;
    this.#createOutputAccumulator = createOutputAccumulator;
    this.#unsubscribeRevision = bridge.onRevisionChange((revision) => {
      const active = this.#active;
      if (!active || revision === active.revision) return;
      this.#invalidate(active, "stale-revision");
    });
  }

  get state(): AgentSessionState {
    return { ...this.#state };
  }

  cancel() {
    if (this.#active) this.#invalidate(this.#active, "cancelled");
  }

  destroy() {
    this.cancel();
    this.#unsubscribeRevision?.();
    this.#unsubscribeRevision = null;
  }

  async run(request: AgentSessionRequest): Promise<AgentSessionResult> {
    this.cancel();
    const snapshot = this.#bridge.getSnapshot();
    const session: ActiveSession = {
      id: ++this.#nextSessionId,
      revision: snapshot.revision,
      controller: new AbortController(),
      invalidated: null,
    };
    this.#active = session;
    this.#setState({ phase: "running", sessionId: session.id, revision: session.revision, result: null });

    try {
      const scope = request.context ?? (snapshot.selection ? "selection" : "current-block");
      const context = await readAgentContext(snapshot, scope);
      if (!this.#isCurrent(session)) return this.#discardedResult(session);
      const output = await this.#generator.generate({
        prompt: promptFor(request.instruction, context),
        temperature: this.#temperature,
        userConfig: this.#userConfig,
        userID: this.#userID,
        signal: session.controller.signal,
        useCache: false,
      });
      if (!this.#isCurrent(session)) return this.#discardedResult(session);

      const accumulator = this.#createOutputAccumulator();
      accumulator.append(output);
      const completeOutput = accumulator.finish();
      const parsed = await parseAndValidateAgentEditOperations(completeOutput, snapshot);
      if (!this.#isCurrent(session)) return this.#discardedResult(session);
      if (!parsed.ok) {
        return this.#finish(session, { status: "invalid-output", error: parsed.error });
      }
      const untrustedOperation = firstOperationOutsideTrustedContext(
        parsed.operations,
        context,
      );
      if (untrustedOperation) {
        return this.#finish(session, {
          status: "invalid-output",
          error: { code: "hash-mismatch", operationId: untrustedOperation.id },
        });
      }

      if (!this.#isCurrent(session)) return this.#discardedResult(session);
      const added = await this.#bridge.addAgentSuggestions(
        parsed.operations,
        () => this.#isCurrent(session),
      );
      if (!this.#isCurrent(session)) return this.#discardedResult(session);
      if (!added.ok) return this.#finish(session, { status: "suggestion-rejected" });
      return this.#finish(session, {
        status: "suggested",
        suggestionIds: added.value ?? parsed.operations.map((operation) => operation.id),
      });
    } catch (error) {
      if (session.invalidated || isAbortError(error)) return this.#discardedResult(session);
      return this.#finish(session, { status: "error", error: toError(error) });
    }
  }

  #invalidate(session: ActiveSession, reason: "cancelled" | "stale-revision") {
    if (session.invalidated) return;
    session.invalidated = reason;
    session.controller.abort();
  }

  #isCurrent(session: ActiveSession) {
    return this.#active === session && !session.invalidated && this.#bridge.getRevision() === session.revision;
  }

  #discardedResult(session: ActiveSession): AgentSessionResult {
    const result: AgentSessionResult = {
      status: session.invalidated === "stale-revision" || this.#bridge.getRevision() !== session.revision
        ? "stale-revision"
        : "cancelled",
    };
    if (this.#active === session) this.#finish(session, result);
    return result;
  }

  #finish(session: ActiveSession, result: AgentSessionResult): AgentSessionResult {
    if (this.#active !== session) return this.#discardedResult(session);
    this.#active = null;
    this.#setState({
      phase: result.status === "error" || result.status === "invalid-output" ? "error" : result.status === "cancelled" || result.status === "stale-revision" ? "cancelled" : "completed",
      sessionId: session.id,
      revision: session.revision,
      result,
    });
    return result;
  }

  #setState(state: AgentSessionState) {
    this.#state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}
