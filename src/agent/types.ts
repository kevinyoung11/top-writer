export type AgentEditOperationType =
  "replaceRange" | "insertAfterRange" | "deleteRange";

export interface AgentEditRange {
  from: number;
  to: number;
}

interface AgentEditOperationBase extends AgentEditRange {
  id: string;
  type: AgentEditOperationType;
  revision: number;
  originalTextHash: string;
  reason?: string;
}

export interface ReplaceRangeOperation extends AgentEditOperationBase {
  type: "replaceRange";
  replacement: string;
}

export interface InsertAfterRangeOperation extends AgentEditOperationBase {
  type: "insertAfterRange";
  replacement: string;
}

export interface DeleteRangeOperation extends AgentEditOperationBase {
  type: "deleteRange";
}

export type AgentEditOperation =
  ReplaceRangeOperation | InsertAfterRangeOperation | DeleteRangeOperation;

export type AgentEditProtocolErrorCode =
  | "invalid-json"
  | "not-an-array"
  | "invalid-operation"
  | "unknown-field"
  | "duplicate-id"
  | "invalid-overlap"
  | "revision-mismatch"
  | "invalid-range"
  | "hash-mismatch"
  | "hash-unavailable"
  | "invalid-replacement";

export interface AgentEditProtocolError {
  code: AgentEditProtocolErrorCode;
  operationId?: string;
}

export type AgentEditHashResult =
  { ok: true; hash: string } | { ok: false; error: AgentEditProtocolError };

export type AgentEditValidationResult =
  | { ok: true; operations: AgentEditOperation[] }
  | { ok: false; error: AgentEditProtocolError };
