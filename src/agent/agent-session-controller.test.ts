import { describe, expect, it, vi } from "vitest";
import type { GenerateTextRequest } from "../llms/text-generation-service";
import { hashOriginalText } from "./edit-protocol";
import {
  AgentSessionController,
  readAgentContext,
  type AgentEditorBridge,
} from "./agent-session-controller";
import type { AgentEditOperation } from "./types";
import type { EditorSnapshot } from "../voice/types";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const snapshot = (): EditorSnapshot => ({
  revision: 4,
  paragraphs: [
    {
      id: "paragraph-0",
      index: 0,
      nodeType: "paragraph",
      nodeFrom: 0,
      nodeTo: 7,
      from: 1,
      to: 6,
      text: "Alpha",
    },
    {
      id: "paragraph-1",
      index: 1,
      nodeType: "paragraph",
      nodeFrom: 7,
      nodeTo: 13,
      from: 8,
      to: 12,
      text: "Beta",
      separatorBefore: "",
    },
  ],
  selection: {
    revision: 4,
    from: 2,
    to: 5,
    text: "lph",
    paragraphIndexes: [0],
    block: false,
  },
  currentParagraphIndex: 1,
  lastSpokenParagraphIndex: null,
});

const validOperation = async (source = snapshot()): Promise<AgentEditOperation> => {
  const original = source.paragraphs[0].text;
  const hash = await hashOriginalText(original);
  if (!hash.ok) throw new Error("Web Crypto is unavailable in this test");
  return {
    id: "replace-alpha",
    type: "replaceRange",
    revision: source.revision,
    from: 1,
    to: 6,
    originalTextHash: hash.hash,
    replacement: "One",
  };
};

class FakeBridge implements AgentEditorBridge {
  current = snapshot();
  readonly added: AgentEditOperation[][] = [];
  private readonly listeners = new Set<(revision: number) => void>();

  getRevision = () => this.current.revision;
  getSnapshot = () => this.current;
  addAgentSuggestions = vi.fn(async (operations: readonly AgentEditOperation[]) => {
    this.added.push([...operations]);
    return { ok: true as const, value: operations.map((operation) => operation.id) };
  });
  onRevisionChange(listener: (revision: number) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  revise() {
    this.current = { ...this.current, revision: this.current.revision + 1 };
    for (const listener of this.listeners) listener(this.current.revision);
  }
}

const generationRequest = () => ({
  temperature: 0.2,
  userConfig: {} as GenerateTextRequest["userConfig"],
  userID: "agent-test",
});

describe("readAgentContext", () => {
  it("returns only selected text for a selection request", () => {
    const context = readAgentContext(snapshot(), "selection");

    expect(context).toEqual({ kind: "selection", revision: 4, from: 2, to: 5, text: "lph" });
    expect(JSON.stringify(context)).not.toContain("Beta");
  });

  it("returns only the current block for a current-block request", () => {
    const context = readAgentContext(snapshot(), "current-block");

    expect(context).toEqual({ kind: "current-block", revision: 4, index: 1, from: 8, to: 12, text: "Beta" });
    expect(JSON.stringify(context)).not.toContain("Alpha");
  });

  it("uses structural metadata rather than document text for a document outline", () => {
    const context = readAgentContext(snapshot(), "document-outline");

    expect(context).toEqual({
      kind: "document-outline",
      revision: 4,
      blocks: [
        { index: 0, nodeType: "paragraph", from: 1, to: 6, length: 5 },
        { index: 1, nodeType: "paragraph", from: 8, to: 12, length: 4 },
      ],
    });
    expect(JSON.stringify(context)).not.toMatch(/Alpha|Beta/);
  });
});

describe("AgentSessionController", () => {
  it("does not expose the full document unless the caller explicitly requests it", async () => {
    const bridge = new FakeBridge();
    const generate = vi.fn<(request: GenerateTextRequest) => Promise<string>>(async () => "[]");
    const controller = new AgentSessionController({ bridge, generator: { generate }, ...generationRequest() });

    await controller.run({ instruction: "Improve this", context: "current-block" });
    const firstRequest = generate.mock.calls[0]?.[0];
    expect(firstRequest?.prompt).toContain('"text":"Beta"');
    expect(firstRequest?.prompt).not.toContain("Alpha");

    await controller.run({ instruction: "Improve all", context: "document" });
    const secondRequest = generate.mock.calls[1]?.[0];
    expect(secondRequest?.prompt).toContain("Alpha");
    expect(secondRequest?.prompt).toContain("Beta");
  });

  it("adds only parsed and validated operations as suggestions", async () => {
    const bridge = new FakeBridge();
    const operation = await validOperation();
    const controller = new AgentSessionController({
      bridge,
      generator: { generate: vi.fn(async () => JSON.stringify([operation])) },
      ...generationRequest(),
    });

    await expect(controller.run({ instruction: "Rewrite", context: "current-block" })).resolves.toEqual({
      status: "suggested",
      suggestionIds: ["replace-alpha"],
    });
    expect(bridge.added).toEqual([[operation]]);
  });

  it("drops invalid protocol output without adding a suggestion", async () => {
    const bridge = new FakeBridge();
    const controller = new AgentSessionController({
      bridge,
      generator: { generate: vi.fn(async () => "not json") },
      ...generationRequest(),
    });

    await expect(controller.run({ instruction: "Rewrite" })).resolves.toEqual({
      status: "invalid-output",
      error: { code: "invalid-json" },
    });
    expect(bridge.added).toEqual([]);
  });

  it("aborts generation and drops its late output when cancelled", async () => {
    const bridge = new FakeBridge();
    const pending = deferred<string>();
    const generate = vi.fn((_request: GenerateTextRequest) => pending.promise);
    const controller = new AgentSessionController({ bridge, generator: { generate }, ...generationRequest() });
    const operation = await validOperation();

    const running = controller.run({ instruction: "Rewrite" });
    controller.cancel();
    pending.resolve(JSON.stringify([operation]));
    await expect(running).resolves.toEqual({ status: "cancelled" });
    expect(generate.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
    expect(bridge.added).toEqual([]);
  });

  it("discards output when the source revision changes during generation", async () => {
    const bridge = new FakeBridge();
    const pending = deferred<string>();
    const controller = new AgentSessionController({
      bridge,
      generator: { generate: vi.fn(() => pending.promise) },
      ...generationRequest(),
    });
    const operation = await validOperation();

    const running = controller.run({ instruction: "Rewrite" });
    bridge.revise();
    pending.resolve(JSON.stringify([operation]));

    await expect(running).resolves.toEqual({ status: "stale-revision" });
    expect(bridge.added).toEqual([]);
  });

  it("makes an older concurrent session inert when a newer session starts", async () => {
    const bridge = new FakeBridge();
    const first = deferred<string>();
    const second = deferred<string>();
    const generate = vi
      .fn<(request: GenerateTextRequest) => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const operation = await validOperation();
    const controller = new AgentSessionController({ bridge, generator: { generate }, ...generationRequest() });

    const earlier = controller.run({ instruction: "First" });
    const later = controller.run({ instruction: "Second" });
    first.resolve(JSON.stringify([operation]));
    second.resolve(JSON.stringify([operation]));

    await expect(earlier).resolves.toEqual({ status: "cancelled" });
    await expect(later).resolves.toEqual({ status: "suggested", suggestionIds: ["replace-alpha"] });
    expect(bridge.added).toEqual([[operation]]);
  });
});
