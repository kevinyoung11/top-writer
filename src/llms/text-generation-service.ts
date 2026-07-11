import {
  ModelFamily,
  SupportedLocalModel,
  SupportedRemoteModel,
  supportedModelReverseLookup,
  type UserConfig,
} from "../components/wordflow/user-config";
import type { TextGenWorkerMessage } from "../types/common-types";
import { textGenGemini } from "./gemini";
import { textGenGpt, type GptModel, type TextGenMessage } from "./gpt";
import { textGenWordflow } from "./wordflow";

export interface GenerateTextRequest {
  prompt: string;
  temperature: number;
  userConfig: UserConfig;
  userID: string;
  signal?: AbortSignal;
  useCache?: boolean;
}

export interface TextGenerationProviders {
  gpt: typeof textGenGpt;
  gemini: typeof textGenGemini;
  wordflow: typeof textGenWordflow;
}

export interface TextGenerationServiceOptions {
  worker: Worker;
  providers?: Partial<TextGenerationProviders>;
}

interface PendingLocalRequest {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

const localModels = new Set<string>(Object.values(SupportedLocalModel));
let fallbackRequestCounter = 0;

export const createAbortError = () => {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
};

const isAbortError = (error: unknown) =>
  (error instanceof Error && error.name === "AbortError") ||
  (typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError");

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

const requestID = () => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  fallbackRequestCounter += 1;
  return `text-gen-${Date.now()}-${fallbackRequestCounter}`;
};

export class TextGenerationService {
  readonly #worker: Worker;
  readonly #providers: TextGenerationProviders;
  readonly #pendingLocal = new Map<string, PendingLocalRequest>();
  readonly #activeControllers = new Set<AbortController>();
  #destroyed = false;
  #fatalLocalWorkerError: Error | undefined;

  readonly #onWorkerMessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data !== "object" || event.data === null) return;
    const message = event.data as TextGenWorkerMessage;
    if (message.command !== "finishTextGen" && message.command !== "error") {
      return;
    }

    if (typeof message.payload?.requestID !== "string") return;

    const pending = this.#takeLocalRequest(message.payload.requestID);
    if (!pending) return;

    if (message.command === "finishTextGen") {
      pending.resolve(message.payload.result);
      return;
    }

    if (message.payload.message === "aborted") {
      pending.reject(createAbortError());
      return;
    }
    pending.reject(new Error(message.payload.message));
  };

  readonly #onWorkerError = (event: ErrorEvent) => {
    event.preventDefault();
    const error =
      event.error instanceof Error
        ? event.error
        : new Error(event.message || "text generation worker failed");
    this.#recordFatalLocalWorkerError(error);
  };

  readonly #onWorkerMessageError = () => {
    this.#recordFatalLocalWorkerError(
      new Error("worker message could not be decoded"),
    );
  };

  constructor({ worker, providers = {} }: TextGenerationServiceOptions) {
    this.#worker = worker;
    this.#providers = {
      gpt: providers.gpt ?? textGenGpt,
      gemini: providers.gemini ?? textGenGemini,
      wordflow: providers.wordflow ?? textGenWordflow,
    };

    this.#worker.addEventListener("message", this.#onWorkerMessage);
    this.#worker.addEventListener("error", this.#onWorkerError);
    this.#worker.addEventListener("messageerror", this.#onWorkerMessageError);
  }

  async generate(request: GenerateTextRequest): Promise<string> {
    if (this.#destroyed) {
      throw new Error("TextGenerationService has been destroyed");
    }
    const id = requestID();
    if (request.signal?.aborted) throw createAbortError();

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onCallerAbort, { once: true });
    this.#activeControllers.add(controller);

    try {
      const model = request.userConfig.preferredLLM;
      if (localModels.has(model)) {
        return await this.#generateLocal(id, request, controller.signal);
      }
      return await this.#generateRemote(id, request, controller.signal);
    } finally {
      request.signal?.removeEventListener("abort", onCallerAbort);
      this.#activeControllers.delete(controller);
    }
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;

    for (const controller of this.#activeControllers) controller.abort();
    this.#worker.removeEventListener("message", this.#onWorkerMessage);
    this.#worker.removeEventListener("error", this.#onWorkerError);
    this.#worker.removeEventListener(
      "messageerror",
      this.#onWorkerMessageError,
    );
  }

  async #generateRemote(
    id: string,
    request: GenerateTextRequest,
    signal: AbortSignal,
  ): Promise<string> {
    const model = request.userConfig.preferredLLM;
    const modelID = supportedModelReverseLookup[model];
    const useCache = request.useCache ?? false;
    let providerPromise: Promise<TextGenMessage>;

    try {
      if (model === SupportedRemoteModel["gpt-5-nano-free"]) {
        providerPromise = this.#providers.wordflow(
          id,
          "",
          request.prompt,
          request.temperature,
          request.userID,
          "gpt-5-nano-free",
          useCache,
          "",
          signal,
        );
      } else if (model === SupportedRemoteModel["gemini-pro"]) {
        providerPromise = this.#providers.gemini(
          request.userConfig.llmAPIKeys[ModelFamily.google],
          id,
          request.prompt,
          request.temperature,
          useCache,
          [],
          "",
          signal,
        );
      } else {
        const gptModel =
          modelID !== undefined && modelID.startsWith("gpt-")
            ? (modelID as GptModel)
            : "gpt-5.4-mini";
        providerPromise = this.#providers.gpt(
          request.userConfig.llmAPIKeys[ModelFamily.openAI],
          id,
          request.prompt,
          request.temperature,
          gptModel,
          useCache,
          [],
          "",
          signal,
        );
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw createAbortError();
      throw toError(error);
    }

    const message = await this.#raceWithAbort(providerPromise, signal);
    if (message.command === "finishTextGen") return message.payload.result;
    if (message.payload.message === "aborted") throw createAbortError();
    throw new Error(message.payload.message);
  }

  #generateLocal(
    id: string,
    request: GenerateTextRequest,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) return Promise.reject(createAbortError());
    if (this.#fatalLocalWorkerError) {
      return Promise.reject(this.#fatalLocalWorkerError);
    }

    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        const pending = this.#takeLocalRequest(id);
        pending?.reject(createAbortError());
      };
      this.#pendingLocal.set(id, { resolve, reject, signal, onAbort });
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        const message: TextGenWorkerMessage = {
          command: "startTextGen",
          payload: {
            requestID: id,
            apiKey: "",
            prompt: request.prompt,
            temperature: request.temperature,
          },
        };
        this.#worker.postMessage(message);
      } catch (error) {
        const pending = this.#takeLocalRequest(id);
        pending?.reject(toError(error));
      }
    });
  }

  #raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(createAbortError());

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = () => settle(() => reject(createAbortError()));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (result) => settle(() => resolve(result)),
        (error) =>
          settle(() =>
            reject(
              signal.aborted || isAbortError(error)
                ? createAbortError()
                : toError(error),
            ),
          ),
      );
    });
  }

  #takeLocalRequest(requestId: string) {
    const pending = this.#pendingLocal.get(requestId);
    if (!pending) return undefined;
    this.#pendingLocal.delete(requestId);
    pending.signal.removeEventListener("abort", pending.onAbort);
    return pending;
  }

  #rejectAllLocal(error: Error) {
    for (const requestId of [...this.#pendingLocal.keys()]) {
      this.#takeLocalRequest(requestId)?.reject(error);
    }
  }

  #recordFatalLocalWorkerError(error: Error) {
    this.#fatalLocalWorkerError ??= error;
    this.#rejectAllLocal(this.#fatalLocalWorkerError);
  }
}
