import type { EditorSnapshot } from "../voice/types";
import type {
  AgentEditOperation,
  AgentEditOperationType,
  AgentEditProtocolError,
  AgentEditProtocolErrorCode,
  AgentEditValidationResult,
} from "./types";

type UnknownRecord = Record<string, unknown>;

const operationTypes: ReadonlySet<AgentEditOperationType> = new Set([
  "replaceRange",
  "insertAfterRange",
  "deleteRange",
]);

const commonFields = new Set([
  "id",
  "type",
  "revision",
  "from",
  "to",
  "originalTextHash",
  "reason",
]);

const success = (
  operations: AgentEditOperation[],
): AgentEditValidationResult => ({
  ok: true,
  operations,
});

const failure = (
  code: AgentEditProtocolErrorCode,
  operationId?: string,
): AgentEditValidationResult => ({
  ok: false,
  error: { code, ...(operationId === undefined ? {} : { operationId }) },
});

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Number.isSafeInteger(value) &&
  value >= 0;

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const validFieldsFor = (type: AgentEditOperationType) => {
  const fields = new Set(commonFields);
  if (type !== "deleteRange") fields.add("replacement");
  return fields;
};

const parseOperation = (
  value: unknown,
): AgentEditOperation | AgentEditProtocolError => {
  if (!isRecord(value)) return { code: "invalid-operation" };

  const type = value.type;
  if (
    typeof type !== "string" ||
    !operationTypes.has(type as AgentEditOperationType)
  ) {
    return { code: "invalid-operation" };
  }

  const operationType = type as AgentEditOperationType;
  const operationId = typeof value.id === "string" ? value.id : undefined;
  for (const key of Object.keys(value)) {
    if (!validFieldsFor(operationType).has(key)) {
      return { code: "unknown-field", ...(operationId ? { operationId } : {}) };
    }
  }

  if (
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    !isNonNegativeSafeInteger(value.revision) ||
    !isSha256(value.originalTextHash) ||
    (value.reason !== undefined && typeof value.reason !== "string")
  ) {
    return {
      code: "invalid-operation",
      ...(operationId ? { operationId } : {}),
    };
  }

  if (
    !isNonNegativeSafeInteger(value.from) ||
    !isNonNegativeSafeInteger(value.to) ||
    value.from >= value.to
  ) {
    return { code: "invalid-range", operationId: value.id };
  }

  const common = {
    id: value.id,
    type: operationType,
    revision: value.revision,
    from: value.from,
    to: value.to,
    originalTextHash: value.originalTextHash,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };

  if (operationType === "deleteRange") {
    return { ...common, type: "deleteRange" };
  }

  if (typeof value.replacement !== "string" || value.replacement.length === 0) {
    return { code: "invalid-replacement", operationId: value.id };
  }

  return {
    ...common,
    type: operationType,
    replacement: value.replacement,
  } as AgentEditOperation;
};

export const parseAgentEditOperations = (
  modelText: string,
): AgentEditValidationResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(modelText);
  } catch {
    return failure("invalid-json");
  }

  if (!Array.isArray(parsed)) return failure("not-an-array");

  const operations: AgentEditOperation[] = [];
  const ids = new Set<string>();
  for (const value of parsed) {
    const operation = parseOperation(value);
    if ("code" in operation) return { ok: false, error: operation };
    if (ids.has(operation.id)) return failure("duplicate-id", operation.id);
    ids.add(operation.id);
    operations.push(operation);
  }

  return success(operations);
};

const textForRange = (
  snapshot: EditorSnapshot,
  from: number,
  to: number,
): string | null => {
  const paragraphs = snapshot.paragraphs;
  const firstIndex = paragraphs.findIndex(
    (paragraph) => from >= paragraph.from && from < paragraph.to,
  );
  const lastIndex = paragraphs.findIndex(
    (paragraph) => to > paragraph.from && to <= paragraph.to,
  );

  if (firstIndex < 0 || lastIndex < firstIndex) return null;

  let text = "";
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const paragraph = paragraphs[index];
    if (
      !Number.isSafeInteger(paragraph.from) ||
      !Number.isSafeInteger(paragraph.to)
    ) {
      return null;
    }

    const startsAt = index === firstIndex ? from - paragraph.from : 0;
    const endsAt =
      index === lastIndex ? to - paragraph.from : paragraph.text.length;
    if (startsAt < 0 || endsAt > paragraph.text.length || startsAt >= endsAt) {
      return null;
    }
    if (index > firstIndex) {
      if (typeof paragraph.separatorBefore !== "string") return null;
      text += paragraph.separatorBefore;
    }
    text += paragraph.text.slice(startsAt, endsAt);
  }

  return text;
};

export const hashOriginalText = async (text: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

export const validateAgentEditOperations = async (
  operations: readonly AgentEditOperation[],
  snapshot: EditorSnapshot,
): Promise<AgentEditValidationResult> => {
  const ids = new Set<string>();
  for (const operation of operations) {
    if (ids.has(operation.id)) return failure("duplicate-id", operation.id);
    ids.add(operation.id);

    if (operation.revision !== snapshot.revision) {
      return failure("revision-mismatch", operation.id);
    }

    const originalText = textForRange(snapshot, operation.from, operation.to);
    if (originalText === null) return failure("invalid-range", operation.id);
    if ((await hashOriginalText(originalText)) !== operation.originalTextHash) {
      return failure("hash-mismatch", operation.id);
    }
  }

  return success([...operations]);
};

export const parseAndValidateAgentEditOperations = async (
  modelText: string,
  snapshot: EditorSnapshot,
): Promise<AgentEditValidationResult> => {
  const parsed = parseAgentEditOperations(modelText);
  if (!parsed.ok) return parsed;
  return validateAgentEditOperations(parsed.operations, snapshot);
};
