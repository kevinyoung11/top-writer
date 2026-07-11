export type VoicePhase =
  | "idle"
  | "listening"
  | "understanding"
  | "clarifying"
  | "reading"
  | "preview"
  | "applied"
  | "error";

export type VoiceIntent = "read" | "control" | "locate" | "rewrite" | "undo";

export type VoiceScope =
  | { kind: "document" }
  | { kind: "selection" }
  | { kind: "effective" }
  | { kind: "current" }
  | { kind: "previous" }
  | { kind: "next" }
  | { kind: "paragraph"; index: number }
  | { kind: "semantic"; query: string }
  | { kind: "resolved-target" };

export interface VoiceAction {
  intent: VoiceIntent;
  scope: VoiceScope | null;
  constraints: string[];
  control?: "pause" | "resume" | "stop" | "faster" | "slower";
}

export interface VoicePlan {
  transcript: string;
  confidence: number;
  actions: VoiceAction[];
}

export interface ParagraphRef {
  id: string;
  index: number;
  nodeType: string;
  nodeFrom: number;
  nodeTo: number;
  from: number;
  to: number;
  text: string;
  separatorBefore?: string;
}

export interface VoiceRange {
  revision: number;
  from: number;
  to: number;
  text: string;
  paragraphIndexes: number[];
  block: boolean;
}

export interface EditorSnapshot {
  revision: number;
  paragraphs: ParagraphRef[];
  selection: VoiceRange | null;
  currentParagraphIndex: number;
  lastSpokenParagraphIndex: number | null;
}

export interface DiffSegment {
  kind: "equal" | "insert" | "delete";
  text: string;
}

export interface RewritePreview {
  id: string;
  revision: number;
  range: VoiceRange;
  originalText: string;
  replacementText: string;
  segments: DiffSegment[];
  mode: "rewrite" | "undo";
}

export interface LocateCandidate {
  range: VoiceRange;
  score: number;
  reason: string;
}

export interface VoiceCopilotState {
  phase: VoicePhase;
  documentReady: boolean;
  transcript: string;
  partialTranscript: string;
  plan: VoicePlan | null;
  candidates: LocateCandidate[];
  preview: RewritePreview | null;
  message: string;
  errorCode: string | null;
  playback: {
    active: boolean;
    paused: boolean;
    paragraphIndex: number | null;
    rate: number;
  };
}
