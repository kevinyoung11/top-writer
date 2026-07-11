// @vitest-environment jsdom

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModelFamily,
  SupportedLocalModel,
  SupportedRemoteModel,
  type UserConfig,
} from "../components/wordflow/user-config";
import type { PromptDataLocal } from "../types/wordflow";
import { textGenGemini } from "./gemini";
import { textGenGpt, type TextGenMessage } from "./gpt";
import {
  TextGenerationService,
  type GenerateTextRequest,
  type TextGenerationProviders,
} from "./text-generation-service";
import { textGenWordflow } from "./wordflow";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class FakeWorker extends EventTarget {
  onerror: ((this: Worker, event: ErrorEvent) => unknown) | null = null;
  onmessage: ((this: Worker, event: MessageEvent) => unknown) | null = null;
  onmessageerror: ((this: Worker, event: MessageEvent) => unknown) | null =
    null;
  readonly posted: unknown[] = [];
  readonly activeListeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();
  postMessageError: unknown = null;
  terminateCalled = false;

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    super.addEventListener(type, callback, options);
    if (callback) {
      const listeners = this.activeListeners.get(type) ?? new Set();
      listeners.add(callback);
      this.activeListeners.set(type, listeners);
    }
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    super.removeEventListener(type, callback, options);
    if (callback) this.activeListeners.get(type)?.delete(callback);
  }

  postMessage(message: unknown) {
    if (this.postMessageError !== null) throw this.postMessageError;
    this.posted.push(structuredClone(message));
  }

  terminate() {
    this.terminateCalled = true;
  }

  listenerCount(type: string) {
    return this.activeListeners.get(type)?.size ?? 0;
  }

  emitMessage(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  emitError(message: string) {
    this.dispatchEvent(
      new ErrorEvent("error", { error: new Error(message), message }),
    );
  }

  emitMessageError(data: unknown) {
    this.dispatchEvent(new MessageEvent("messageerror", { data }));
  }
}

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const finishMessage = (requestID: string, result: string): TextGenMessage => ({
  command: "finishTextGen",
  payload: {
    requestID,
    apiKey: "",
    result,
    prompt: "prompt",
    detail: "",
  },
});

const errorMessage = (requestID: string, message: string): TextGenMessage => ({
  command: "error",
  payload: {
    requestID,
    originalCommand: "startTextGen",
    message,
  },
});

const userConfigFor = (
  preferredLLM: SupportedRemoteModel | SupportedLocalModel,
): UserConfig => ({
  preferredLLM,
  llmAPIKeys: {
    [ModelFamily.openAI]: "openai-key",
    [ModelFamily.google]: "google-key",
    [ModelFamily.local]: "local-key",
  },
});

const requestFor = (
  preferredLLM: SupportedRemoteModel | SupportedLocalModel,
  prompt = "完整格式化提示",
  overrides: Partial<GenerateTextRequest> = {},
): GenerateTextRequest => ({
  prompt,
  temperature: 0.37,
  userConfig: userConfigFor(preferredLLM),
  userID: "user-7",
  useCache: true,
  ...overrides,
});

const createProviders = () => {
  const gpt = vi.fn(async (...args: Parameters<typeof textGenGpt>) =>
    finishMessage(args[1], "gpt-result"),
  );
  const gemini = vi.fn(async (...args: Parameters<typeof textGenGemini>) =>
    finishMessage(args[1], "gemini-result"),
  );
  const wordflow = vi.fn(async (...args: Parameters<typeof textGenWordflow>) =>
    finishMessage(args[0], "wordflow-result"),
  );
  return { gpt, gemini, wordflow };
};

const services: TextGenerationService[] = [];

const createService = (
  providers: Partial<TextGenerationProviders> = createProviders(),
) => {
  const worker = new FakeWorker();
  const service = new TextGenerationService({
    worker: worker as unknown as Worker,
    providers,
  });
  services.push(service);
  return { service, worker, providers };
};

const expectAbort = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toMatchObject({
    name: "AbortError",
    message: "aborted",
  });
};

const createPrompt = (prompt: string): PromptDataLocal => ({
  key: "prompt-key",
  prompt,
  tags: [],
  temperature: 0.42,
  userID: "prompt-user",
  userName: "",
  description: "",
  icon: "",
  forkFrom: "",
  promptRunCount: 0,
  created: "",
  title: "",
  outputParsingPattern: "",
  outputParsingReplacement: "",
  recommendedModels: [],
  injectionMode: "replace",
});

beforeEach(() => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
});

afterEach(() => {
  while (services.length > 0) services.pop()?.destroy();
  vi.unstubAllGlobals();
});

describe("TextGenerationService routing", () => {
  it("routes the free model through Wordflow with the full formatted prompt", async () => {
    const providers = createProviders();
    const { service } = createService(providers);

    await expect(
      service.generate(
        requestFor(
          SupportedRemoteModel["gpt-5-nano-free"],
          "已经格式化的完整提示",
        ),
      ),
    ).resolves.toBe("wordflow-result");

    expect(providers.wordflow).toHaveBeenCalledTimes(1);
    const args = providers.wordflow.mock.calls[0];
    expect(args.slice(1, 8)).toEqual([
      "",
      "已经格式化的完整提示",
      0.37,
      "user-7",
      "gpt-5-nano-free",
      true,
      "",
    ]);
    expect(args[0]).toEqual(expect.any(String));
    expect(args[0]).not.toBe("");
    expect(args[8]).toBeInstanceOf(AbortSignal);
    expect(providers.gpt).not.toHaveBeenCalled();
    expect(providers.gemini).not.toHaveBeenCalled();
  });

  it("routes Gemini with its exact key, prompt, cache, and signal arguments", async () => {
    const providers = createProviders();
    const { service } = createService(providers);

    await expect(
      service.generate(
        requestFor(SupportedRemoteModel["gemini-pro"], "Gemini prompt"),
      ),
    ).resolves.toBe("gemini-result");

    expect(providers.gemini).toHaveBeenCalledTimes(1);
    const args = providers.gemini.mock.calls[0];
    expect(args.slice(0, 8)).toEqual([
      "google-key",
      expect.any(String),
      "Gemini prompt",
      0.37,
      true,
      [],
      "",
      expect.any(AbortSignal),
    ]);
    expect(providers.gpt).not.toHaveBeenCalled();
    expect(providers.wordflow).not.toHaveBeenCalled();
  });

  it.each([
    [SupportedRemoteModel["gpt-5.4"], "gpt-5.4"],
    [SupportedRemoteModel["gpt-5.4-pro"], "gpt-5.4-pro"],
    [SupportedRemoteModel["gpt-5.4-mini"], "gpt-5.4-mini"],
    [SupportedRemoteModel["gpt-5.4-nano"], "gpt-5.4-nano"],
    [SupportedRemoteModel["gpt-5-mini"], "gpt-5-mini"],
    [SupportedRemoteModel["gpt-5-nano"], "gpt-5-nano"],
    [SupportedRemoteModel["gpt-5"], "gpt-5"],
    [SupportedRemoteModel["gpt-4.1"], "gpt-4.1"],
  ] as const)("routes %s through GPT model %s", async (model, modelID) => {
    const providers = createProviders();
    const { service } = createService(providers);

    await expect(service.generate(requestFor(model, modelID))).resolves.toBe(
      "gpt-result",
    );

    expect(providers.gpt).toHaveBeenCalledTimes(1);
    const args = providers.gpt.mock.calls[0];
    expect(args.slice(0, 9)).toEqual([
      "openai-key",
      expect.any(String),
      modelID,
      0.37,
      modelID,
      true,
      [],
      "",
      expect.any(AbortSignal),
    ]);
  });

  it("falls back to GPT 5.4 Mini for an unknown configured model", async () => {
    const providers = createProviders();
    const { service } = createService(providers);
    const request = requestFor(SupportedRemoteModel["gpt-5.4"]);
    request.userConfig.preferredLLM = "unknown-model" as SupportedRemoteModel;

    await expect(service.generate(request)).resolves.toBe("gpt-result");
    expect(providers.gpt.mock.calls[0][4]).toBe("gpt-5.4-mini");
  });

  it("assigns unique IDs and correlates all local models out of order", async () => {
    const providers = createProviders();
    const { service, worker } = createService(providers);
    const models = [
      SupportedLocalModel["gemma-2b"],
      SupportedLocalModel["phi-2"],
      SupportedLocalModel["llama-2-7b"],
      SupportedLocalModel["tinyllama-1.1b"],
    ];
    const promises = models.map((model, index) =>
      service.generate(requestFor(model, `local-${index}`)),
    );
    await Promise.resolve();

    const messages = worker.posted as Array<{
      command: string;
      payload: {
        requestID: string;
        apiKey: string;
        prompt: string;
        temperature: number;
      };
    }>;
    expect(messages).toHaveLength(models.length);
    expect(
      new Set(messages.map((message) => message.payload.requestID)).size,
    ).toBe(models.length);
    for (const message of [...messages].reverse()) {
      expect(message).toMatchObject({
        command: "startTextGen",
        payload: {
          apiKey: "",
          temperature: 0.37,
        },
      });
      worker.emitMessage(
        finishMessage(
          message.payload.requestID,
          `result:${message.payload.prompt}`,
        ),
      );
    }

    await expect(Promise.all(promises)).resolves.toEqual([
      "result:local-0",
      "result:local-1",
      "result:local-2",
      "result:local-3",
    ]);
    expect(providers.gpt).not.toHaveBeenCalled();
    expect(providers.gemini).not.toHaveBeenCalled();
    expect(providers.wordflow).not.toHaveBeenCalled();
  });
});

describe("TextGenerationService cancellation and failures", () => {
  it("rejects abort-before-start without calling a provider or worker", async () => {
    const providers = createProviders();
    const { service, worker } = createService(providers);
    const controller = new AbortController();
    controller.abort();

    await expectAbort(
      service.generate(
        requestFor(SupportedRemoteModel["gpt-5.4-mini"], "aborted", {
          signal: controller.signal,
        }),
      ),
    );
    await expectAbort(
      service.generate(
        requestFor(SupportedLocalModel["phi-2"], "aborted-local", {
          signal: controller.signal,
        }),
      ),
    );
    expect(providers.gpt).not.toHaveBeenCalled();
    expect(worker.posted).toHaveLength(0);
  });

  it("aborts a pending remote call even when the provider has not settled", async () => {
    const pending = deferred<TextGenMessage>();
    let providerSignal: AbortSignal | undefined;
    const providers = createProviders();
    providers.gpt.mockImplementation(async (...args) => {
      providerSignal = args[8] as AbortSignal;
      return pending.promise;
    });
    const { service } = createService(providers);
    const controller = new AbortController();
    const generation = service.generate(
      requestFor(SupportedRemoteModel["gpt-5.4-mini"], "remote", {
        signal: controller.signal,
      }),
    );
    const assertion = expectAbort(generation);

    controller.abort();
    await assertion;
    expect(providerSignal?.aborted).toBe(true);
    pending.resolve(finishMessage("late", "late success"));
  });

  it("aborts a pending local call and ignores its stale response", async () => {
    const { service, worker } = createService();
    const controller = new AbortController();
    const generation = service.generate(
      requestFor(SupportedLocalModel["phi-2"], "local", {
        signal: controller.signal,
      }),
    );
    await Promise.resolve();
    const requestID = (worker.posted[0] as { payload: { requestID: string } })
      .payload.requestID;
    const assertion = expectAbort(generation);

    controller.abort();
    await assertion;
    worker.emitMessage(finishMessage(requestID, "stale"));

    const next = service.generate(
      requestFor(SupportedLocalModel["phi-2"], "next"),
    );
    const nextMessage = worker.posted[1] as {
      payload: { requestID: string };
    };
    worker.emitMessage(finishMessage(nextMessage.payload.requestID, "next"));
    await expect(next).resolves.toBe("next");
  });

  it("ignores unknown worker messages and stale request IDs", async () => {
    const { service, worker } = createService();
    const generation = service.generate(
      requestFor(SupportedLocalModel["gemma-2b"], "known"),
    );
    const requestID = (worker.posted[0] as { payload: { requestID: string } })
      .payload.requestID;

    worker.emitMessage({
      command: "progressLoadModel",
      payload: { progress: 0.5, timeElapsed: 10 },
    });
    worker.emitMessage(finishMessage("stale-request", "wrong"));
    worker.emitMessage({ command: "unknown", payload: {} });
    worker.emitMessage(finishMessage(requestID, "known-result"));

    await expect(generation).resolves.toBe("known-result");
  });

  it("maps correlated local error and aborted messages to typed errors", async () => {
    const { service, worker } = createService();
    const failed = service.generate(
      requestFor(SupportedLocalModel["phi-2"], "failed"),
    );
    const failedID = (worker.posted[0] as { payload: { requestID: string } })
      .payload.requestID;
    worker.emitMessage(errorMessage(failedID, "worker failed"));
    await expect(failed).rejects.toEqual(new Error("worker failed"));

    const aborted = service.generate(
      requestFor(SupportedLocalModel["phi-2"], "aborted-message"),
    );
    const abortedID = (worker.posted[1] as { payload: { requestID: string } })
      .payload.requestID;
    worker.emitMessage(errorMessage(abortedID, "aborted"));
    await expectAbort(aborted);
  });

  it.each([
    {
      name: "error",
      expectedMessage: "worker crashed",
      emit: (worker: FakeWorker) => worker.emitError("worker crashed"),
    },
    {
      name: "messageerror",
      expectedMessage: "worker message could not be decoded",
      emit: (worker: FakeWorker) =>
        worker.emitMessageError({ malformed: true }),
    },
  ])(
    "records a fatal worker $name and fails later local requests without posting",
    async ({ expectedMessage, emit }) => {
      const providers = createProviders();
      const { service, worker } = createService(providers);
      const current = service.generate(
        requestFor(SupportedLocalModel["phi-2"], "current"),
      );
      const currentFailure = expect(current).rejects.toMatchObject({
        name: "Error",
        message: expectedMessage,
      });

      emit(worker);
      await currentFailure;

      const laterLocal = service.generate(
        requestFor(SupportedLocalModel["phi-2"], "must not post"),
      );
      void laterLocal.catch(() => undefined);
      expect(worker.posted).toHaveLength(1);
      await expect(laterLocal).rejects.toMatchObject({
        name: "Error",
        message: expectedMessage,
      });

      await expect(
        service.generate(requestFor(SupportedRemoteModel["gpt-5.4-mini"])),
      ).resolves.toBe("gpt-result");
      await expect(
        service.generate(requestFor(SupportedRemoteModel["gemini-pro"])),
      ).resolves.toBe("gemini-result");
      await expect(
        service.generate(requestFor(SupportedRemoteModel["gpt-5-nano-free"])),
      ).resolves.toBe("wordflow-result");
      expect(providers.gpt).toHaveBeenCalledTimes(1);
      expect(providers.gemini).toHaveBeenCalledTimes(1);
      expect(providers.wordflow).toHaveBeenCalledTimes(1);
      expect(worker.posted).toHaveLength(1);

      service.destroy();
      expect(worker.listenerCount("message")).toBe(0);
      expect(worker.listenerCount("error")).toBe(0);
      expect(worker.listenerCount("messageerror")).toBe(0);
      expect(worker.terminateCalled).toBe(false);
      await expect(
        service.generate(requestFor(SupportedRemoteModel["gpt-5.4-mini"])),
      ).rejects.toThrow("TextGenerationService has been destroyed");
    },
  );

  it("cleans up a local request when postMessage throws", async () => {
    const { service, worker } = createService();
    worker.postMessageError = new Error("post failed");

    await expect(
      service.generate(requestFor(SupportedLocalModel["phi-2"], "throw")),
    ).rejects.toThrow("post failed");
    worker.postMessageError = null;
    worker.emitMessage(finishMessage("unknown", "stale"));

    const next = service.generate(
      requestFor(SupportedLocalModel["phi-2"], "next"),
    );
    const nextID = (worker.posted[0] as { payload: { requestID: string } })
      .payload.requestID;
    worker.emitMessage(finishMessage(nextID, "recovered"));
    await expect(next).resolves.toBe("recovered");
  });

  it("maps provider responses, rejections, throws, and aborted messages", async () => {
    const providers = createProviders();
    const { service } = createService(providers);

    providers.gpt.mockResolvedValueOnce(errorMessage("id", "remote failed"));
    await expect(
      service.generate(requestFor(SupportedRemoteModel["gpt-5.4-mini"])),
    ).rejects.toThrow("remote failed");

    providers.gpt.mockResolvedValueOnce(errorMessage("id", "aborted"));
    await expectAbort(
      service.generate(requestFor(SupportedRemoteModel["gpt-5.4-mini"])),
    );

    providers.gpt.mockRejectedValueOnce(new Error("provider rejected"));
    await expect(
      service.generate(requestFor(SupportedRemoteModel["gpt-5.4-mini"])),
    ).rejects.toThrow("provider rejected");

    providers.gpt.mockImplementationOnce(() => {
      throw new Error("provider threw");
    });
    await expect(
      service.generate(requestFor(SupportedRemoteModel["gpt-5.4-mini"])),
    ).rejects.toThrow("provider threw");
  });

  it("destroy aborts every request, removes listeners, and never terminates the worker", async () => {
    const remotePending = deferred<TextGenMessage>();
    let remoteSignal: AbortSignal | undefined;
    const providers = createProviders();
    providers.gpt.mockImplementation(async (...args) => {
      remoteSignal = args[8] as AbortSignal;
      return remotePending.promise;
    });
    const { service, worker } = createService(providers);
    const remote = service.generate(
      requestFor(SupportedRemoteModel["gpt-5.4-mini"], "remote"),
    );
    const local = service.generate(
      requestFor(SupportedLocalModel["phi-2"], "local"),
    );
    const remoteAssertion = expectAbort(remote);
    const localAssertion = expectAbort(local);

    expect(worker.listenerCount("message")).toBe(1);
    expect(worker.listenerCount("error")).toBe(1);
    expect(worker.listenerCount("messageerror")).toBe(1);
    service.destroy();
    service.destroy();

    await Promise.all([remoteAssertion, localAssertion]);
    expect(remoteSignal?.aborted).toBe(true);
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(0);
    expect(worker.listenerCount("messageerror")).toBe(0);
    expect(worker.terminateCalled).toBe(false);
    await expect(
      service.generate(requestFor(SupportedRemoteModel["gpt-5.4-mini"])),
    ).rejects.toThrow("TextGenerationService has been destroyed");
    remotePending.resolve(finishMessage("late", "late"));
  });
});

type ProviderCase = {
  name: string;
  successBody: unknown;
  invoke(signal: AbortSignal): Promise<TextGenMessage>;
};

const providerCases = (): ProviderCase[] => [
  {
    name: "GPT",
    successBody: { output_text: "gpt-success" },
    invoke: (signal) =>
      textGenGpt(
        "key",
        "provider-request",
        "provider prompt",
        0.2,
        "gpt-5.4-mini",
        false,
        [],
        "detail",
        signal,
      ),
  },
  {
    name: "Gemini",
    successBody: {
      candidates: [{ content: { parts: [{ text: "gemini-success" }] } }],
    },
    invoke: (signal) =>
      textGenGemini(
        "key",
        "provider-request",
        "provider prompt",
        0.2,
        false,
        [],
        "detail",
        signal,
      ),
  },
  {
    name: "Wordflow",
    successBody: {
      payload: { result: "wordflow-success", fullPrompt: "full", detail: "" },
    },
    invoke: (signal) =>
      textGenWordflow(
        "provider-request",
        "prefix",
        "input",
        0.2,
        "user",
        "gpt-5-nano-free",
        false,
        "detail",
        signal,
      ),
  },
];

describe("fetch text-generation providers", () => {
  it("forwards each AbortSignal to fetch", async () => {
    for (const provider of providerCases()) {
      const fetchSpy = vi.fn(async () => ({
        status: 200,
        json: async () => provider.successBody,
      })) as unknown as typeof fetch;
      vi.stubGlobal("fetch", fetchSpy);
      const controller = new AbortController();

      const message = await provider.invoke(controller.signal);

      expect(message.command, provider.name).toBe("finishTextGen");
      const requestOptions = vi.mocked(fetchSpy).mock.calls[0][1];
      expect(requestOptions?.signal, provider.name).toBe(controller.signal);
      vi.unstubAllGlobals();
    }
  });

  it("returns the stable aborted message before fetch for every provider", async () => {
    for (const provider of providerCases()) {
      const fetchSpy = vi.fn(async () => ({
        status: 200,
        json: async () => provider.successBody,
      })) as unknown as typeof fetch;
      vi.stubGlobal("fetch", fetchSpy);
      const controller = new AbortController();
      controller.abort();

      const message = await provider.invoke(controller.signal);

      expect(message, provider.name).toMatchObject({
        command: "error",
        payload: { message: "aborted" },
      });
      expect(fetchSpy, provider.name).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it("maps fetch abort rejection to the stable aborted message", async () => {
    for (const provider of providerCases()) {
      const fetchSpy = vi.fn(
        async (_input: RequestInfo | URL, options?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      ) as unknown as typeof fetch;
      vi.stubGlobal("fetch", fetchSpy);
      const controller = new AbortController();
      const result = provider.invoke(controller.signal);
      await Promise.resolve();

      controller.abort();

      await expect(result, provider.name).resolves.toMatchObject({
        command: "error",
        payload: { message: "aborted" },
      });
      vi.unstubAllGlobals();
    }
  });

  it("preserves non-abort provider error messages as strings", async () => {
    for (const provider of providerCases()) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("network down");
        }),
      );
      const controller = new AbortController();

      const message = await provider.invoke(controller.signal);

      expect(message, provider.name).toMatchObject({
        command: "error",
        payload: { message: "network down" },
      });
      vi.unstubAllGlobals();
    }
  });
});

describe("WebLLM worker protocol", () => {
  it("serializes overlapping stateful generations and continues after a failure", async () => {
    const postMessage = vi.fn();
    const workerScope: {
      onmessage: ((event: MessageEvent) => void) | null;
    } = { onmessage: null };
    const firstCompletion = deferred<void>();
    const secondCompletion = deferred<void>();
    const recoveryCompletion = deferred<void>();
    const firstReset = deferred<void>();
    const secondReset = deferred<void>();
    const failingReset = deferred<void>();
    const recoveryReset = deferred<void>();
    const resetCompletions = new Map([
      ["first prompt", firstReset],
      ["second prompt", secondReset],
      ["failing prompt", failingReset],
      ["recovery prompt", recoveryReset],
    ]);
    let activePrompt = "";
    const createCompletion = vi.fn(
      async ({ messages }: { messages: Array<{ content: string }> }) => {
        const prompt = messages[0].content;
        activePrompt = prompt;

        if (prompt === "failing prompt") {
          throw new Error("local failure");
        }

        if (prompt === "first prompt") {
          await firstCompletion.promise;
        } else if (prompt === "second prompt") {
          await secondCompletion.promise;
        } else if (prompt === "recovery prompt") {
          await recoveryCompletion.promise;
        }

        return {
          choices: [{ message: { content: `result:${activePrompt}` } }],
        };
      },
    );
    const engine = {
      chat: { completions: { create: createCompletion } },
      resetChat: vi.fn(async () => {
        await resetCompletions.get(activePrompt)?.promise;
        activePrompt = "";
      }),
    };
    vi.stubGlobal("self", workerScope);
    vi.stubGlobal("postMessage", postMessage);
    vi.doMock("@mlc-ai/web-llm", () => ({
      CreateEngine: vi.fn(async () => engine),
      hasModelInCache: vi.fn(async () => false),
    }));

    try {
      await import("./web-llm");
      const send = workerScope.onmessage;
      expect(send).toBeTypeOf("function");
      send?.(
        new MessageEvent("message", {
          data: {
            command: "startLoadModel",
            payload: {
              model: SupportedLocalModel["phi-2"],
              temperature: 0,
            },
          },
        }),
      );
      await vi.waitFor(() =>
        expect(postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ command: "finishLoadModel" }),
        ),
      );
      postMessage.mockClear();

      const sendTextGeneration = (requestID: string, prompt: string) => {
        send?.(
          new MessageEvent("message", {
            data: {
              command: "startTextGen",
              payload: {
                requestID,
                apiKey: "",
                prompt,
                temperature: 0,
              },
            },
          }),
        );
      };

      sendTextGeneration("request-first", "first prompt");
      sendTextGeneration("request-second", "second prompt");

      await vi.waitFor(() => expect(createCompletion).toHaveBeenCalledTimes(1));
      expect(createCompletion).toHaveBeenLastCalledWith({
        messages: [{ role: "user", content: "first prompt" }],
        n: 1,
        max_gen_len: 2048,
        temperature: 0,
      });
      expect(engine.resetChat).not.toHaveBeenCalled();

      firstCompletion.resolve();
      await vi.waitFor(() => expect(engine.resetChat).toHaveBeenCalledTimes(1));
      expect(createCompletion).toHaveBeenCalledTimes(1);
      firstReset.resolve();
      await vi.waitFor(() => expect(createCompletion).toHaveBeenCalledTimes(2));
      expect(createCompletion).toHaveBeenLastCalledWith({
        messages: [{ role: "user", content: "second prompt" }],
        n: 1,
        max_gen_len: 2048,
        temperature: 0,
      });

      secondCompletion.resolve();
      await vi.waitFor(() => expect(engine.resetChat).toHaveBeenCalledTimes(2));
      secondReset.resolve();
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));

      sendTextGeneration("request-failure", "failing prompt");
      sendTextGeneration("request-recovery", "recovery prompt");
      await vi.waitFor(() => expect(createCompletion).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(engine.resetChat).toHaveBeenCalledTimes(3));
      expect(createCompletion).toHaveBeenCalledTimes(3);
      failingReset.resolve();
      await vi.waitFor(() => expect(createCompletion).toHaveBeenCalledTimes(4));
      expect(createCompletion).toHaveBeenLastCalledWith({
        messages: [{ role: "user", content: "recovery prompt" }],
        n: 1,
        max_gen_len: 2048,
        temperature: 0,
      });

      recoveryCompletion.resolve();
      await vi.waitFor(() => expect(engine.resetChat).toHaveBeenCalledTimes(4));
      recoveryReset.resolve();
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(4));
      expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
        {
          command: "finishTextGen",
          payload: {
            requestID: "request-first",
            apiKey: "",
            result: "result:first prompt",
            prompt: "first prompt",
            detail: "",
          },
        },
        {
          command: "finishTextGen",
          payload: {
            requestID: "request-second",
            apiKey: "",
            result: "result:second prompt",
            prompt: "second prompt",
            detail: "",
          },
        },
        {
          command: "error",
          payload: {
            requestID: "request-failure",
            originalCommand: "startTextGen",
            message: "local failure",
          },
        },
        {
          command: "finishTextGen",
          payload: {
            requestID: "request-recovery",
            apiKey: "",
            result: "result:recovery prompt",
            prompt: "recovery prompt",
            detail: "",
          },
        },
      ]);
    } finally {
      firstCompletion.resolve();
      secondCompletion.resolve();
      recoveryCompletion.resolve();
      firstReset.resolve();
      secondReset.resolve();
      failingReset.resolve();
      recoveryReset.resolve();
      vi.doUnmock("@mlc-ai/web-llm");
    }
  });
});

describe("shared service integration", () => {
  it("formats once and delegates TextEditor prompt generation to the shared service", async () => {
    (
      globalThis as typeof globalThis & { litIssuedWarnings: Set<string> }
    ).litIssuedWarnings = new Set(["dev-mode"]);
    const modulePath = "../components/text-editor/text-editor";
    const textEditorModule =
      await vi.importActual<Record<string, unknown>>(modulePath);
    type TestTextEditor = HTMLElement & {
      userConfig: UserConfig;
      textGenerationService: TextGenerationService;
      _runPrompt(
        prompt: PromptDataLocal,
        input: string,
        signal?: AbortSignal,
      ): Promise<TextGenMessage>;
    };
    const element = document.createElement(
      "wordflow-text-editor",
    ) as TestTextEditor;
    const generate = vi.fn(
      async (_request: GenerateTextRequest) => "generated text",
    );
    element.textGenerationService = {
      generate,
      destroy: vi.fn(),
    } as unknown as TextGenerationService;
    element.userConfig = userConfigFor(SupportedRemoteModel["gpt-5.4-mini"]);
    localStorage.setItem("user-id", "shared-user");
    const controller = new AbortController();

    const result = await element._runPrompt(
      createPrompt("前缀 {{text}} 后缀"),
      "输入",
      controller.signal,
    );

    expect(generate).toHaveBeenCalledWith({
      prompt: "前缀 输入 后缀",
      temperature: 0.42,
      userConfig: element.userConfig,
      userID: "shared-user",
      signal: controller.signal,
      useCache: true,
    });
    expect(result).toEqual({
      command: "finishTextGen",
      payload: {
        requestID: "text-gen",
        apiKey: "",
        result: "generated text",
        prompt: "前缀 输入 后缀",
        detail: "",
      },
    });

    generate.mockRejectedValueOnce(new Error("generation failed"));
    await expect(
      element._runPrompt(createPrompt("无占位符"), "正文"),
    ).resolves.toMatchObject({
      command: "error",
      payload: { message: "generation failed" },
    });
    expect(generate.mock.calls[1][0].prompt).toBe("无占位符\n正文");
  });

  it("creates one service beside the worker and shares it with TextEditor only", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    (
      globalThis as typeof globalThis & { litIssuedWarnings: Set<string> }
    ).litIssuedWarnings = new Set(["dev-mode"]);
    const modulePath = "../components/wordflow/wordflow";
    const wordflowModule =
      await vi.importActual<Record<string, unknown>>(modulePath);
    type TestRoot = HTMLElement & {
      updateComplete: Promise<boolean>;
      textGenLocalWorker: Worker;
      textGenerationService: TextGenerationService;
    };
    const RootConstructor =
      wordflowModule.WordflowWordflow as CustomElementConstructor;
    const root = document.createElement("wordflow-wordflow") as TestRoot;
    expect(root).toBeInstanceOf(RootConstructor);

    document.body.append(root);
    await root.updateComplete;
    const textEditor = root.shadowRoot?.querySelector(
      "wordflow-text-editor",
    ) as
      | (HTMLElement & {
          textGenerationService?: TextGenerationService;
          textGenLocalWorker?: Worker;
        })
      | null;
    const settingWindow = root.shadowRoot?.querySelector(
      "wordflow-setting-window",
    ) as (HTMLElement & { textGenLocalWorker?: Worker }) | null;

    expect(root.textGenerationService).toBeInstanceOf(TextGenerationService);
    expect(textEditor?.textGenerationService).toBe(root.textGenerationService);
    expect(textEditor?.textGenLocalWorker).toBeUndefined();
    expect(settingWindow?.textGenLocalWorker).toBe(root.textGenLocalWorker);

    root.textGenerationService.destroy();
    root.remove();
  });
});
