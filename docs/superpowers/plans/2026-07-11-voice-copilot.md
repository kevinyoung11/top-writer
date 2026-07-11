# Voice Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready Mandarin-first Voice Copilot for Top Writer that can read, navigate, semantically locate, safely rewrite, preview, apply, and undo document changes through voice.

**Architecture:** Keep speech I/O, command interpretation, document location, LLM generation, editor mutation, and Lit rendering behind separate interfaces. A deterministic state-machine controller coordinates them; only `EditorBridge` can mutate Tiptap, and every generative mutation requires a version-checked diff preview and confirmation.

**Tech Stack:** TypeScript, Lit 3, Tiptap/ProseMirror, browser `SpeechRecognition` and `speechSynthesis`, existing GPT/Gemini/Wordflow providers, Vitest 3, jsdom only for DOM-focused unit tests, Playwright Chromium plus branded Chrome smoke tests, axe-core, GitHub Actions, Vercel.

---

## Execution model

Development proceeds in dependency waves. Tasks inside the same wave may run in parallel in separate task worktrees; the integration agent reviews and cherry-picks each commit into `feature/voice-copilot` in task-number order.

| Wave | Tasks | Parallel rule |
| --- | --- | --- |
| 1 | 1–2 | Sequential: test foundation, then shared contracts |
| 2 | 3–5 | Parallel: editor bridge, recognition/preferences, and synthesis own disjoint files |
| 3 | 6–7 | Parallel after Task 3: scope/diff and shared LLM service |
| 4 | 8–9 | Sequential: semantic services, then orchestration |
| 5 | 10–11 | Parallel: player and side-panel components |
| 6 | 12–13 | Sequential: app integration, then end-to-end tests |
| 7 | 14–15 | Sequential: hardening/CI, then PR/merge/deploy |

Every implementation task follows RED → GREEN → REFACTOR, is reviewed for spec compliance and code quality, and lands as an isolated commit. Agents must not modify files outside the task boundary unless the integration agent approves the dependency change first.

## Product and safety boundaries

- Launch target is desktop Chrome; unsupported browsers keep a text-command fallback.
- Initial documents are typed or pasted. Continuous long-form voice dictation is out of scope.
- Supported intents are `READ`, `CONTROL`, `LOCATE`, `REWRITE`, and `UNDO`; a plan contains at most three ordered actions.
- Non-mutating playback/navigation executes immediately. `REWRITE` and `UNDO` always show a diff and require confirmation.
- Full document content and history stay in the browser. LLM calls receive one target plus at most one neighboring paragraph on each side; semantic ranking sends at most eight locally shortlisted paragraphs.
- Raw audio is never persisted by Top Writer. Browser-vendor speech processing is disclosed before first use.
- Cancelling, interrupting, timing out, losing permission, receiving a stale response, or changing the document invalidates pending work and never writes text.

## Planned file map

### Tooling and verification

- Modify `package.json`: unit, E2E, and aggregate verification scripts.
- Create `vitest.config.ts` and `tsconfig.test.json`: Node-first unit environment with explicit jsdom files.
- Create `src/test/setup.ts`: deterministic DOM/local-storage setup.
- Create `playwright.config.ts` and `playwright.chrome.config.ts`: deterministic Chromium E2E and real-adapter branded Chrome smoke tests.
- Create `test/e2e/helpers/speech-fakes.ts`: browser-only speech API doubles.
- Create `test/e2e/voice-copilot.spec.ts`: real application journeys.
- Create `.github/workflows/ci.yml`: build, unit, and E2E checks.

### Domain and editor boundary

- Create `src/voice/types.ts`: all stable cross-module contracts.
- Create `src/voice/command-parser.ts`: deterministic Mandarin intent parser.
- Create `src/voice/diff.ts`: safe structured diff segments.
- Create `src/voice/scope-resolver.ts`: fixed and effective range resolution.
- Create `src/voice/editor/voice-highlight-extension.ts`: decoration-only playback highlighting.
- Create `src/voice/editor/editor-bridge.ts`: the sole Tiptap mutation boundary.
- Modify `src/components/text-editor/text-editor.ts`: register the extension and expose the bridge.

### Speech, preferences, and language services

- Create `src/voice/preferences.ts`: persisted language, voice, rate, and vocabulary.
- Create `src/voice/speech/types.ts`: recognizer and synthesizer contracts.
- Create `src/voice/speech/browser-recognizer.ts`: live Mandarin transcript adapter.
- Create `src/voice/speech/browser-synthesizer.ts`: sentence queue, pause, resume, cancel, and boundaries.
- Create `src/llms/text-generation-service.ts`: shared provider dispatch and cancellation.
- Modify `src/llms/gpt.ts`, `src/llms/gemini.ts`, `src/llms/wordflow.ts`: accept `AbortSignal`.
- Modify `src/components/text-editor/text-editor.ts`: use the shared generation service.
- Create `src/voice/semantic-locator.ts`: local shortlist plus optional model ranking.
- Create `src/voice/rewrite-service.ts`: target-only rewrite prompt and response validation.

### Orchestration and UI

- Create `src/voice/voice-copilot-controller.ts`: state machine and ordered action execution.
- Create `src/components/voice-player/voice-player.ts` and `.css`: persistent playback controls.
- Create `src/components/voice-copilot/voice-copilot.ts` and `.css`: transcript, candidates, preview, settings, and recovery.
- Modify `src/components/wordflow/wordflow.ts` and `.css`: instantiate dependencies and mount both components.
- Create `src/config/brand.ts` and modify `src/components/wordflow/wordflow.ts`: preserve the already-requested `Top Writer` name in the feature branch.

## Specification coverage matrix

| Approved requirement | Implemented by | Proven by |
| --- | --- | --- |
| Visible idle/listening/understanding/clarifying/reading/preview/error states | Tasks 9, 11 | Controller and panel tests; E2E state journeys |
| Whole/selection/current/previous/next/numbered reading | Tasks 3, 5, 6, 9, 10 | Scope, synthesis, controller, and browser tests |
| Semantic paragraph location with at most three candidates | Tasks 6, 8, 9, 11 | Shortlist privacy tests and clarification E2E |
| `LOCATE → READ → REWRITE` compound command | Tasks 2, 8, 9 | Parser/controller tests and full E2E journey |
| Non-mutating diff before every rewrite | Tasks 3, 6, 9, 11 | Editor JSON comparison before apply |
| Previewed and confirmed undo | Tasks 3, 9, 11 | Isolated history integration test and E2E undo |
| Stale response, interruption, and error safety | Tasks 3, 4, 5, 7, 9, 13 | Cancellation/version/failure suites |
| Mandarin-first, mixed terms, custom vocabulary | Tasks 2, 4, 11 | Parser, literal-normalization, and settings tests |
| Minimum external text and no Top Writer audio persistence | Tasks 4, 8, 14 | Prompt inspection tests and privacy documentation |
| Chrome speech plus unsupported-browser text fallback | Tasks 4, 5, 11, 13 | Fake-boundary E2E and branded Chrome smoke |
| Responsive, keyboard, screen-reader, and reduced-motion access | Tasks 10–14 | Component assertions, axe, viewport and zoom E2E |
| CI, PR checks, merged-main deployment, and production validation | Tasks 14–15 | GitHub Actions, PR status, HTTP and production E2E |

## Task 1: Verification foundation and Top Writer brand baseline

**Boundary:** Owns package/test configuration and brand constant only. It does not add voice behavior.

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `tsconfig.test.json`
- Create: `src/test/setup.ts`
- Create: `src/config/brand.test.ts`
- Create: `src/config/brand.ts`
- Modify: `src/components/wordflow/wordflow.ts:51-53, 521-523`

- [ ] **Step 1: Install deterministic test dependencies and add scripts**

Run:

```bash
npm install --save-dev \
  vitest@3.2.7 \
  @vitest/coverage-v8@3.2.7 \
  jsdom@26.1.0 \
  @playwright/test@1.61.1 \
  @axe-core/playwright@4.12.1 \
  @types/dom-speech-recognition@0.0.12 \
  @types/node@24.13.3
```

Set these scripts in `package.json`:

```json
{
  "scripts": {
    "dev": "vite --port 3000",
    "build": "tsc && vite build",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.test.json",
    "test": "vitest run",
    "test:unit": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "test:e2e:headed": "playwright test --headed",
    "test:smoke:chrome": "playwright test -c playwright.chrome.config.ts",
    "verify": "npm run typecheck && npm run test:unit && npm run build && npm run test:e2e"
  }
}
```

- [ ] **Step 2: Add the Vitest environment**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    include: ['src/**/*.test.ts']
  }
});
```

Create `src/test/setup.ts`:

```ts
import { beforeEach } from 'vitest';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
  if (typeof document !== 'undefined') document.body.replaceChildren();
});
```

Create `tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["@webgpu/types", "dom-speech-recognition", "node", "vitest/globals"]
  },
  "include": ["src/**/*.test.ts", "src/test/**/*.ts", "test/**/*.ts"],
  "exclude": []
}
```

Add `dom-speech-recognition` to production `tsconfig.json` types and exclude `src/**/*.test.ts` from the production build. Add `coverage/`, `test-results/`, `playwright-report/`, and `blob-report/` to `.gitignore`.

- [ ] **Step 3: Write the failing brand test**

Create `src/config/brand.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from './brand';

describe('brand', () => {
  it('uses the approved Top Writer product name', () => {
    expect(PRODUCT_NAME).toBe('Top Writer');
  });
});
```

Run: `npm test -- src/config/brand.test.ts`

Expected: FAIL because `src/config/brand.ts` does not exist.

- [ ] **Step 4: Add the brand constant and render it**

Create `src/config/brand.ts`:

```ts
export const PRODUCT_NAME = 'Top Writer';
```

In `wordflow.ts`, import `PRODUCT_NAME` and replace the hard-coded header:

```ts
import { PRODUCT_NAME } from '../../config/brand';
```

```ts
<span class="name">${PRODUCT_NAME}</span>
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- src/config/brand.test.ts
npm run build
```

Expected: 1 test passes and the production build exits 0.

Commit:

```bash
git add package.json package-lock.json tsconfig.json tsconfig.test.json vitest.config.ts .gitignore src/test/setup.ts src/config/brand.ts src/config/brand.test.ts src/components/wordflow/wordflow.ts
git commit -m "test: establish voice feature verification baseline"
```

**Acceptance:** Node-first unit tests and explicit jsdom tests typecheck independently, production build passes, browser-test artifacts are ignored, and the header is sourced from `PRODUCT_NAME === 'Top Writer'`.

## Task 2: Voice domain contracts and deterministic command parser

**Boundary:** Defines stable data contracts and parses commands. It cannot read the editor, call a model, play audio, or mutate state.

**Files:**
- Create: `src/voice/types.ts`
- Create: `src/voice/command-parser.ts`
- Create: `src/voice/command-parser.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `src/voice/command-parser.test.ts` with these cases:

```ts
import { describe, expect, it } from 'vitest';
import { parseVoicePlan } from './command-parser';

describe('parseVoicePlan', () => {
  it('parses direct read navigation', () => {
    expect(parseVoicePlan('读上一段').actions).toEqual([
      { intent: 'read', scope: { kind: 'previous' }, constraints: [] }
    ]);
  });

  it('parses paragraph numbers as one-based user input', () => {
    expect(parseVoicePlan('读第 5 段').actions[0].scope).toEqual({
      kind: 'paragraph',
      index: 4
    });
  });

  it('parses a locate-read-rewrite compound command in order', () => {
    const plan = parseVoicePlan(
      '找到讲用户信任的那段，读一下，再改得更直接，保留最后一句'
    );
    expect(plan.actions.map(action => action.intent)).toEqual([
      'locate',
      'read',
      'rewrite'
    ]);
    expect(plan.actions[0].scope).toEqual({
      kind: 'semantic',
      query: '用户信任'
    });
    expect(plan.actions[2].constraints.join(' ')).toContain('保留最后一句');
  });

  it('never emits more than three actions', () => {
    expect(parseVoicePlan('找到讲产品的段落，读一下，再改写，再润色').actions)
      .toHaveLength(3);
  });

  it('marks unknown speech as unsupported instead of guessing', () => {
    expect(parseVoicePlan('今天天气不错')).toMatchObject({
      confidence: 0,
      actions: []
    });
  });
});
```

Run: `npm test -- src/voice/command-parser.test.ts`

Expected: FAIL because the parser does not exist.

- [ ] **Step 2: Add the complete shared contracts**

Create `src/voice/types.ts` with these exported contracts:

```ts
export type VoicePhase =
  | 'idle'
  | 'listening'
  | 'understanding'
  | 'clarifying'
  | 'reading'
  | 'preview'
  | 'applied'
  | 'error';

export type VoiceIntent = 'read' | 'control' | 'locate' | 'rewrite' | 'undo';

export type VoiceScope =
  | { kind: 'document' }
  | { kind: 'selection' }
  | { kind: 'effective' }
  | { kind: 'current' }
  | { kind: 'previous' }
  | { kind: 'next' }
  | { kind: 'paragraph'; index: number }
  | { kind: 'semantic'; query: string }
  | { kind: 'resolved-target' };

export interface VoiceAction {
  intent: VoiceIntent;
  scope: VoiceScope | null;
  constraints: string[];
  control?: 'pause' | 'resume' | 'stop' | 'faster' | 'slower';
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
  kind: 'equal' | 'insert' | 'delete';
  text: string;
}

export interface RewritePreview {
  id: string;
  revision: number;
  range: VoiceRange;
  originalText: string;
  replacementText: string;
  segments: DiffSegment[];
  mode: 'rewrite' | 'undo';
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
```

- [ ] **Step 3: Implement the deterministic parser**

Create `src/voice/command-parser.ts`. Normalize whitespace and Chinese punctuation, parse direct control/read/undo commands first, then extract a semantic query with this expression:

```ts
const locatePattern =
  /(?:找到|找出|定位)(?:一下)?(?:讲|关于)?(.+?)(?:的)?(?:那一段|段落|那段|地方|部分)(?=，|,|然后|再|$)/;
```

Use these exact rules:

```ts
import type { VoiceAction, VoicePlan, VoiceScope } from './types';

const normalize = (value: string) =>
  value.trim().replace(/[。！？!?]/g, '').replace(/\s+/g, ' ');

const readScope = (text: string): VoiceScope | null => {
  const numbered = text.match(/第\s*(\d+)\s*段/);
  if (numbered) {
    const oneBasedIndex = Number(numbered[1]);
    return oneBasedIndex >= 1
      ? { kind: 'paragraph', index: oneBasedIndex - 1 }
      : null;
  }
  if (/从头|全文|全部/.test(text)) return { kind: 'document' };
  if (/选中/.test(text)) return { kind: 'selection' };
  if (/上一段|前一段/.test(text)) return { kind: 'previous' };
  if (/下一段|后一段/.test(text)) return { kind: 'next' };
  return { kind: 'current' };
};

export const parseVoicePlan = (rawTranscript: string): VoicePlan => {
  const transcript = normalize(rawTranscript);
  const actions: VoiceAction[] = [];

  const control = transcript.match(/暂停|继续|停止|快一点|慢一点/);
  const locate = transcript.match(
    /(?:找到|找出|定位)(?:一下)?(?:讲|关于)?(.+?)(?:的)?(?:那一段|段落|那段|地方|部分)(?=，|,|然后|再|$)/
  );

  if (locate) {
    actions.push({
      intent: 'locate',
      scope: { kind: 'semantic', query: locate[1].trim() },
      constraints: []
    });
    if (/读|念/.test(transcript)) {
      actions.push({ intent: 'read', scope: { kind: 'resolved-target' }, constraints: [] });
    }
    if (/改|润色|调整|压缩|精简/.test(transcript)) {
      const constraint = transcript
        .replace(locate[0], '')
        .replace(/^[，,然后再\s]*(?:读|念)(?:一下|一遍)?[，,然后再\s]*/, '');
      actions.push({
        intent: 'rewrite',
        scope: { kind: 'resolved-target' },
        constraints: constraint ? [constraint] : ['保持原意并改善表达']
      });
    }
  } else if (/撤回|恢复刚才|回到修改前/.test(transcript)) {
    actions.push({ intent: 'undo', scope: null, constraints: [] });
  } else if (control) {
    const value = control[0];
    const mapped = value === '暂停' ? 'pause' : value === '继续' ? 'resume' :
      value === '停止' ? 'stop' : value === '快一点' ? 'faster' : 'slower';
    actions.push({ intent: 'control', scope: null, constraints: [], control: mapped });
  } else if (/读|念/.test(transcript)) {
    const scope = readScope(transcript);
    if (scope) actions.push({ intent: 'read', scope, constraints: [] });
  } else if (/改|润色|调整|压缩|精简/.test(transcript)) {
    actions.push({
      intent: 'rewrite',
      scope: { kind: 'effective' },
      constraints: [transcript]
    });
  }

  return {
    transcript,
    confidence: actions.length > 0 ? 1 : 0,
    actions: actions.slice(0, 3)
  };
};
```

The supported compound form normalizes to `LOCATE → READ → REWRITE` and truncates after three actions. Standalone playback controls remain one-action plans.

- [ ] **Step 4: Verify parser edges and types**

Add cases for blank input, zero/negative paragraph numbers, selection rewrite, and `停止`. Reject paragraph numbers below 1 by returning no action.

Run:

```bash
npm test -- src/voice/command-parser.test.ts
npm run build
```

Expected: parser suite passes and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/voice/types.ts src/voice/command-parser.ts src/voice/command-parser.test.ts
git commit -m "feat: define voice commands and parser"
```

**Acceptance:** The parser handles the approved Mandarin command set, does not guess unknown speech, and never emits more than three actions.

## Task 3: Decoration-based EditorBridge and revision safety

**Boundary:** Owns all Tiptap reads/writes and playback decorations. It does not parse speech, call models, or render UI.

**Files:**
- Create: `src/voice/editor/voice-highlight-extension.ts`
- Create: `src/voice/editor/editor-bridge.ts`
- Create: `src/voice/editor/editor-bridge.test.ts`
- Modify: `src/components/text-editor/text-editor.ts:25-48, 263-279, 1206-1213`

- [ ] **Step 1: Write failing integration tests against a real Tiptap Editor**

Start the test file with `// @vitest-environment jsdom`. The test must construct a real editor with `StarterKit` and verify:

```ts
it('snapshots paragraphs, selection, cursor paragraph, and revision');
it('increments revision only when the document changes');
it('highlights a range with decorations without changing revision or history');
it('applies a confirmed single-paragraph replacement in one transaction');
it('replaces cross-block plain text with a ProseMirror Slice');
it('rejects an apply when preview revision is stale');
it('rejects ranges that intersect legacy edit or loading marks');
it('undoes only when no later document change has occurred');
it('keeps typing before, voice apply, and typing after as separate history events');
```

Use this fixture:

```ts
const editor = new Editor({
  element: document.createElement('div'),
  extensions: [StarterKit, VoiceHighlightExtension],
  content: '<p>第一段内容。</p><p>第二段谈用户信任。</p><p>第三段内容。</p>'
});
const bridge = new EditorBridge(editor);
```

Run: `npm test -- src/voice/editor/editor-bridge.test.ts`

Expected: FAIL because the extension and bridge do not exist.

- [ ] **Step 2: Implement decoration-only highlighting**

Create a ProseMirror plugin keyed by `voiceEditorStatePluginKey`. Its state is `{ revision, decorationsByChannel }`. Increment revision inside plugin `apply` only when `tr.docChanged`, map decorations through transactions, and clear every voice decoration on a document change. Highlight metadata identifies `target`, `candidate`, or `playback`; metadata-only transactions set `addToHistory = false`.

```ts
export const setVoiceHighlight = (
  editor: Editor,
  channel: 'target' | 'candidate' | 'playback',
  range: Pick<VoiceRange, 'from' | 'to'> | null
) => {
  const tr = editor.state.tr.setMeta(
    voiceEditorStatePluginKey,
    { type: 'highlight', channel, range }
  );
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
};
```

Use `Decoration.inline` for text and `Decoration.node` for empty/full textblocks. Decoration attributes include `data-voice-highlight-channel`. Add visual styles to `text-editor.css` only in Task 12 so layout styling remains centralized.

- [ ] **Step 3: Implement the narrow EditorBridge**

Export this public surface:

```ts
export type BridgeFailure =
  | 'stale-revision'
  | 'invalid-range'
  | 'pending-legacy-edit'
  | 'preview-not-found'
  | 'intervening-edit'
  | 'nothing-to-undo';

export type BridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BridgeFailure };

export class EditorBridge {
  constructor(editor: Editor);
  destroy(): void;
  getRevision(): number;
  getSnapshot(lastSpokenParagraphIndex?: number | null): EditorSnapshot;
  highlight(channel: 'target' | 'candidate' | 'playback', range: VoiceRange | null): BridgeResult<void>;
  stagePreview(preview: RewritePreview): BridgeResult<void>;
  applyReplacement(previewId: string): BridgeResult<{ beforeRevision: number; afterRevision: number }>;
  previewUndoLastVoiceEdit(): BridgeResult<RewritePreview>;
  undoLastVoiceEdit(previewId: string): BridgeResult<{ beforeRevision: number; afterRevision: number }>;
}
```

Implementation rules:

- Read revision from plugin state so appended ProseMirror transactions are included.
- Traverse every `node.isTextblock`, including headings and nested list paragraphs; do not assume depth 1. Use `doc.textBetween(from, to, '\n\n', '\n')`.
- Validate and store controller-created structured previews internally by opaque ID. `stagePreview` is non-mutating and rejects mismatched revision/range/original text. `applyReplacement` accepts only an ID, guaranteeing the applied text is exactly what the user saw.
- Reject ranges intersecting `edit-highlight`, `loading-highlight`, or `collapse` until the legacy edit is accepted or rejected.
- Inline single-line ranges use `tr.insertText`. Cross-block text is converted to plain ProseMirror nodes (`\n\n` paragraphs, `\n` hard breaks) and applied with `tr.replaceRange(..., Slice.maxOpen(fragment))`; never parse model output as HTML.
- Call `closeHistory(tr)`, attach `VOICE_EDIT_META`, and dispatch exactly one document-changing root transaction. An extension `appendTransaction` adds a zero-step closing history boundary after the voice edit.
- Store the before-document, after-document, applied preview, and after-revision for only the latest voice edit. Voice undo is permitted only when current revision equals after-revision. Build the inverse preview by swapping original/replacement and mapping insert ↔ delete in the stored segments, then call native undo after confirmation and verify the result deep-equals the stored before-document. Native redo remains available.

- [ ] **Step 4: Register and expose the bridge**

Add `VoiceHighlightExtension` to the editor extensions. Construct the bridge once immediately after `new Editor(...)`, store it on `WordflowTextEditor`, and dispatch a composed event without exposing the raw Tiptap editor:

```ts
this.editorBridge = new EditorBridge(this.editor);
this.dispatchEvent(new CustomEvent('editor-bridge-ready', {
  bubbles: true,
  composed: true,
  detail: this.editorBridge
}));
```

Do not put speech or controller state in `text-editor.ts`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- src/voice/editor/editor-bridge.test.ts
npm run build
```

Expected: all bridge tests pass; TypeScript and Vite build pass.

Commit:

```bash
git add src/voice/editor src/components/text-editor/text-editor.ts
git commit -m "feat: add safe voice editor bridge"
```

**Acceptance:** Preview application is version-checked and single-transaction; decoration changes do not alter document revision; voice undo cannot accidentally undo a later manual edit.

## Task 4: Voice preferences, vocabulary normalization, and browser recognition

**Boundary:** Owns persisted speech preferences and ASR lifecycle only. It does not interpret commands.

**Files:**
- Create: `src/voice/preferences.ts`
- Create: `src/voice/preferences.test.ts`
- Create: `src/voice/speech/types.ts`
- Create: `src/voice/speech/browser-recognizer.ts`
- Create: `src/voice/speech/browser-recognizer.test.ts`

- [ ] **Step 1: Write failing preference and recognizer tests**

Cover:

```ts
it('loads Mandarin defaults when storage is empty');
it('clamps speech rate to 0.5..2');
it('normalizes custom spoken terms longest-first');
it('reports unsupported without requesting permission');
it('emits partial and final transcripts separately');
it('maps no-speech, not-allowed, audio-capture, network, language, service, and aborted errors');
it('cancel aborts the active recognition exactly once');
```

Run: `npm test -- src/voice/preferences.test.ts src/voice/speech/browser-recognizer.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 2: Implement the preferences store**

Use this contract and defaults:

```ts
export interface VocabularyEntry {
  spoken: string;
  written: string;
}

export interface VoicePreferences {
  language: 'zh-CN';
  rate: number;
  voiceURI: string | null;
  vocabulary: VocabularyEntry[];
  privacyNoticeAccepted: boolean;
}

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  language: 'zh-CN',
  rate: 1,
  voiceURI: null,
  vocabulary: [],
  privacyNoticeAccepted: false
};

export class VoicePreferencesStore extends EventTarget {
  get value(): VoicePreferences;
  update(patch: Partial<Omit<VoicePreferences, 'vocabulary'>>): void;
  addVocabulary(entry: VocabularyEntry): void;
  removeVocabulary(spoken: string): void;
  clear(): void;
}
```

Persist under `top-writer:voice-preferences`, emit `change` with a cloned value after writes, deduplicate vocabulary by normalized spoken form, and clamp rate in `update`. `normalizeTranscript` replaces literal terms longest-first, ignores empty entries, and never evaluates a user string as a regular expression.

- [ ] **Step 3: Define speech contracts using the installed DOM speech types**

`src/voice/speech/types.ts` must export:

```ts
export interface RecognitionHandlers {
  onStart(): void;
  onPartial(text: string): void;
  onFinal(text: string): void;
  onEnd(): void;
  onError(code:
    | 'no-speech'
    | 'permission-denied'
    | 'audio-capture'
    | 'network'
    | 'language-not-supported'
    | 'service-not-allowed'
    | 'aborted'
    | 'unknown'
  ): void;
}

export interface SpeechRecognizer {
  readonly supported: boolean;
  start(language: string, handlers: RecognitionHandlers): void;
  stop(): void;
  cancel(): void;
}

export interface SpeechChunk {
  text: string;
  range: VoiceRange;
}

export interface SynthesisOptions {
  language: string;
  rate: number;
  voiceURI: string | null;
  onChunkStart(chunk: SpeechChunk): void;
  onError(code: 'synthesis-failed' | 'cancelled'): void;
}

export interface SpeechSynthesizer {
  readonly supported: boolean;
  speak(chunks: SpeechChunk[], options: SynthesisOptions): Promise<void>;
  pause(): void;
  resume(): void;
  cancel(): void;
}
```

Use `@types/dom-speech-recognition` for prefixed and unprefixed constructors. Do not depend on experimental `phrases`, `processLocally`, `available()`, or `install()` APIs.

- [ ] **Step 4: Implement BrowserSpeechRecognizer**

Prefer `globalThis.SpeechRecognition`, then `globalThis.webkitSpeechRecognition`. Configure `lang = 'zh-CN'`, `continuous = false`, `interimResults = true`, and `maxAlternatives = 1`. Starting at `event.resultIndex`, emit interim text through `onPartial` and only newly finalized text through `onFinal`. Map browser errors without throwing from event handlers. `stop()` requests a final result; `cancel()` calls `abort()` and makes subsequent callbacks inert.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- src/voice/preferences.test.ts src/voice/speech/browser-recognizer.test.ts
npm run build
```

Commit:

```bash
git add src/voice/preferences* src/voice/speech
git commit -m "feat: add browser speech recognition"
```

**Acceptance:** Recognition has visible partial/final separation, cancellation is deterministic, unsupported/permission cases are typed, and user vocabulary normalization is literal and persisted.

## Task 5: Browser speech synthesis and sentence-level playback

**Boundary:** Owns text chunking and TTS queue control only. It cannot choose document scope or mutate the editor.

**Files:**
- Create: `src/voice/speech/browser-synthesizer.ts`
- Create: `src/voice/speech/browser-synthesizer.test.ts`

- [ ] **Step 1: Write failing synthesis tests**

Cover:

```ts
it('splits Chinese text on sentence punctuation and preserves range offsets');
it('speaks chunks in order and reports the active chunk');
it('resolves only after the last utterance ends');
it('pause, resume, and cancel delegate exactly once');
it('cancel rejects the active queue with SpeechCancelledError');
it('waits for voiceschanged when the initial voice list is empty');
it('uses the requested zh-CN voice when present and falls back safely');
it('ignores stale end and boundary callbacks after cancellation');
```

Run: `npm test -- src/voice/speech/browser-synthesizer.test.ts`

Expected: FAIL because the synthesizer does not exist.

- [ ] **Step 2: Implement sentence chunking**

Export:

```ts
export const splitRangeIntoSpeechChunks = (range: VoiceRange): SpeechChunk[];
```

Split after `。！？!?；;` while retaining punctuation. Each chunk derives `from` and `to` from the original range and keeps the same `revision`, `paragraphIndexes`, and `block` flag. Empty chunks are dropped; an empty range yields an empty array.

- [ ] **Step 3: Implement BrowserSpeechSynthesizer**

`speak` cancels any previous queue, increments a generation ID, creates one `SpeechSynthesisUtterance` per sentence, sets `lang`, `rate`, and selected voice, and calls `options.onChunkStart(chunk)` before each `speechSynthesis.speak`. Queue the next utterance only from the previous utterance's `onend`. Reject once on `onerror` or cancellation, and ignore every callback whose generation ID is stale.

Export `SpeechCancelledError extends Error` with `name = 'AbortError'`, and use it for cancelled queues so the controller can treat user interruption as a quiet cancellation.

`speechSynthesis.getVoices()` may initially be empty. Wait for one `voiceschanged` event with a bounded one-second timeout, prefer the configured URI, then any `zh-CN`/`zh-*` voice, then browser default. Headless tests never require audible output or a nonempty real voice list.

Use the `SynthesisOptions` contract created in Task 4:

```ts
export interface SynthesisOptions {
  language: string;
  rate: number;
  voiceURI: string | null;
  onChunkStart(chunk: SpeechChunk): void;
  onError(code: 'synthesis-failed' | 'cancelled'): void;
}
```

- [ ] **Step 4: Verify timing-independent behavior**

Use a fake `speechSynthesis` queue and invoke utterance callbacks manually; never use sleeps in tests.

Run:

```bash
npm test -- src/voice/speech/browser-synthesizer.test.ts
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/voice/speech/browser-synthesizer.ts src/voice/speech/browser-synthesizer.test.ts src/voice/speech/types.ts
git commit -m "feat: add sentence-aware speech playback"
```

**Acceptance:** Playback is ordered, cancellable, sentence-highlightable, and deterministic under tests without relying on browser word-boundary events.

## Task 6: Scope resolution and safe structured diff

**Boundary:** Pure domain logic. It receives snapshots and text, and returns ranges/candidates/diff segments without side effects.

**Files:**
- Create: `src/voice/scope-resolver.ts`
- Create: `src/voice/scope-resolver.test.ts`
- Create: `src/voice/diff.ts`
- Create: `src/voice/diff.test.ts`

- [ ] **Step 1: Write failing scope and diff tests**

Scope tests cover document, selection, effective scope priority, current/previous/next bounds, paragraph index, resolved target, and stale revision propagation. Diff tests cover equal/insert/delete/replacement, Chinese punctuation, empty strings, and HTML-like text remaining plain data.

Example assertions:

```ts
expect(resolveScope({ kind: 'effective' }, snapshot, candidate)).toEqual(
  snapshot.selection
);
expect(resolveScope({ kind: 'previous' }, snapshot, null)?.paragraphIndexes)
  .toEqual([0]);
expect(buildDiffSegments('<b>原文</b>', '<i>新文</i>'))
  .not.toContainEqual(expect.objectContaining({ text: expect.stringContaining('<mark>') }));
```

Run: `npm test -- src/voice/scope-resolver.test.ts src/voice/diff.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 2: Implement fixed scope resolution**

Export:

```ts
export const resolveScope = (
  scope: VoiceScope,
  snapshot: EditorSnapshot,
  resolvedTarget: VoiceRange | null
): VoiceRange | null;
```

Rules:

- `effective`: selection → last spoken paragraph → cursor paragraph.
- `document`: first paragraph `nodeFrom` through last paragraph `nodeTo`, `block = true`.
- Paragraph ranges use `nodeFrom/nodeTo` and `block = true`.
- Selection uses its original `from/to` and `block = false` unless it exactly spans full paragraph nodes.
- Out-of-range navigation returns `null`; never wraps around.
- `semantic` is not resolved here and returns `null`.

- [ ] **Step 3: Implement plain structured diffs**

Segment with `Intl.Segmenter('zh-CN', { granularity: 'word' })` when available, encode tokens for `diff-match-patch`, and fall back to character-level diff for Chinese when the segmenter is unavailable. This avoids treating an entire Chinese sentence as one token. Map only to:

```ts
const kindByOperation = {
  [-1]: 'delete',
  [0]: 'equal',
  [1]: 'insert'
} as const;
```

Decode tokens back to exact source text, call semantic cleanup, preserve raw text, merge adjacent segments of the same kind, and return no HTML. Enforce two invariants in tests: concatenating all non-insert segments equals the original, and concatenating all non-delete segments equals the replacement.

- [ ] **Step 4: Verify purity and build**

Run:

```bash
npm test -- src/voice/scope-resolver.test.ts src/voice/diff.test.ts
npm run build
```

Expected: all cases pass; inputs remain deeply equal to pre-call copies.

- [ ] **Step 5: Commit**

```bash
git add src/voice/scope-resolver* src/voice/diff*
git commit -m "feat: resolve voice scopes and previews"
```

**Acceptance:** Scope choice is deterministic, boundary-safe, and follows the approved priority. Diff output is safe plain data suitable for Lit rendering.

## Task 7: Shared cancellable text-generation service

**Boundary:** Owns provider dispatch, local-worker request correlation, and cancellation. It does not know voice intents, document structure, or UI.

**Files:**
- Create: `src/llms/text-generation-service.ts`
- Create: `src/llms/text-generation-service.test.ts`
- Modify: `src/llms/gpt.ts`
- Modify: `src/llms/gemini.ts`
- Modify: `src/llms/wordflow.ts`
- Modify: `src/components/text-editor/text-editor.ts:1-35, 74-82, 152-158, 956-1043`
- Modify: `src/components/wordflow/wordflow.ts:155-158, constructor, text editor properties`

- [ ] **Step 1: Write failing service tests**

Cover remote model routing, free Wordflow routing, Gemini routing, local worker request IDs, two concurrent local requests resolving correctly, abort-before-start, abort-during-fetch, and stale worker responses being ignored.

Use injected provider functions instead of global network calls:

```ts
const service = new TextGenerationService({
  worker: fakeWorker,
  providers: { gpt: gptSpy, gemini: geminiSpy, wordflow: wordflowSpy }
});
```

Run: `npm test -- src/llms/text-generation-service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 2: Add AbortSignal to existing fetch providers**

Append `signal?: AbortSignal` to each provider function and set it on `RequestInit`:

```ts
const requestOptions: RequestInit = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal
};
```

In catch blocks, map `signal?.aborted` to the stable message `'aborted'`; preserve existing error message behavior otherwise.

- [ ] **Step 3: Implement TextGenerationService**

Expose:

```ts
export interface GenerateTextRequest {
  prompt: string;
  temperature: number;
  userConfig: UserConfig;
  userID: string;
  signal?: AbortSignal;
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

export class TextGenerationService {
  constructor(options: TextGenerationServiceOptions);
  generate(request: GenerateTextRequest): Promise<string>;
  destroy(): void;
}
```

Create a UUID request ID for every call. Maintain `Map<string, { resolve, reject }>` for local-worker responses. On abort, remove the pending entry and reject with `AbortError`. Convert every successful provider message to its result string and every error message to an `Error`.

- [ ] **Step 4: Refactor the existing prompt path to use the service**

Create one service next to `textGenLocalWorker` in `WordflowWordflow`, pass it into `WordflowTextEditor`, remove the editor's one-off worker resolver/listener, and reduce `_runPrompt` to:

```ts
return this.textGenerationService
  .generate({
    prompt: curPrompt,
    temperature: promptData.temperature,
    userConfig: this.userConfig,
    userID: localStorage.getItem('user-id') ?? '',
    signal
  })
  .then(result => ({
    command: 'finishTextGen' as const,
    payload: { requestID: 'text-gen', apiKey: '', result, prompt: curPrompt, detail: '' }
  }))
  .catch(error => ({
    command: 'error' as const,
    payload: { requestID: 'text-gen', originalCommand: 'startTextGen', message: String(error) }
  }));
```

Preserve the current prompt behavior and cache settings.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- src/llms/text-generation-service.test.ts
npm test
npm run build
```

Expected: all existing/new unit tests pass; current prompt generation still compiles.

Commit:

```bash
git add src/llms src/components/text-editor/text-editor.ts src/components/wordflow/wordflow.ts
git commit -m "refactor: share cancellable text generation"
```

**Acceptance:** One service safely multiplexes local requests, all remote providers accept cancellation, and the existing prompt workflow remains behaviorally unchanged.

## Task 8: Semantic locator and constrained rewrite service

**Boundary:** Owns LLM prompts and response validation for locating and rewriting. It cannot apply text or retain editor state.

**Files:**
- Create: `src/voice/semantic-locator.ts`
- Create: `src/voice/semantic-locator.test.ts`
- Create: `src/voice/rewrite-service.ts`
- Create: `src/voice/rewrite-service.test.ts`

- [ ] **Step 1: Write failing semantic and rewrite tests**

Cover:

```ts
it('returns an exact local match without calling the model');
it('shortlists at most eight paragraphs before model ranking');
it('returns at most three candidates sorted by score');
it('falls back to local ranking on malformed JSON or provider failure');
it('rewrite sends only target plus one neighbor on each side');
it('rewrite rejects empty output and unchanged output');
it('both services propagate AbortError');
```

Use a 12-paragraph fixture and inspect the prompt passed to the fake `TextGenerationService` to prove unrelated paragraphs are absent.

Run: `npm test -- src/voice/semantic-locator.test.ts src/voice/rewrite-service.test.ts`

Expected: FAIL because both services are missing.

- [ ] **Step 2: Implement local lexical shortlisting**

Normalize Chinese punctuation and spaces, then score query character bigrams against paragraph bigrams. Exact substring matches receive score `1`; other paragraphs receive Jaccard overlap. Sort stably by score and paragraph index, then keep eight.

```ts
export const shortlistParagraphs = (
  query: string,
  paragraphs: ParagraphRef[],
  limit = 8
): Array<{ paragraph: ParagraphRef; score: number }>;
```

- [ ] **Step 3: Implement SemanticLocator**

Expose:

```ts
export class SemanticLocator {
  constructor(private readonly generator: TextGenerationService);
  locate(
    query: string,
    snapshot: EditorSnapshot,
    context: { userConfig: UserConfig; userID: string; signal?: AbortSignal }
  ): Promise<LocateCandidate[]>;
}
```

If an exact match is unique, return it without a model call. Otherwise send the shortlist as numbered JSON, ask for a strict array of `{ index, score, reason }`, discard indexes outside the shortlist and scores outside `0..1`, deduplicate, sort, and keep three. If parsing or generation fails without cancellation, return the local top three with reason `本地相关度匹配`.

- [ ] **Step 4: Implement RewriteService**

Expose:

```ts
export class RewriteService {
  constructor(private readonly generator: TextGenerationService);
  rewrite(input: {
    snapshot: EditorSnapshot;
    range: VoiceRange;
    constraints: string[];
    userConfig: UserConfig;
    userID: string;
    signal?: AbortSignal;
  }): Promise<string>;
}
```

Build the prompt with four labeled sections: `前文`, `目标原文`, `后文`, and `修改要求`. Include only the target's immediate neighboring paragraph on each side. Require plain replacement text with no commentary or Markdown fence. Trim output; reject empty or unchanged output with typed errors.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- src/voice/semantic-locator.test.ts src/voice/rewrite-service.test.ts
npm run build
```

Commit:

```bash
git add src/voice/semantic-locator* src/voice/rewrite-service*
git commit -m "feat: locate and rewrite minimal text scopes"
```

**Acceptance:** Exact matches avoid the model; semantic requests send no more than eight candidates; rewrites send only target plus immediate context and return validated plain text.

## Task 9: VoiceCopilotController state machine

**Boundary:** Coordinates dependencies and owns transient state. It cannot render DOM or directly call Tiptap/browser globals.

**Files:**
- Create: `src/voice/voice-copilot-controller.ts`
- Create: `src/voice/voice-copilot-controller.test.ts`

- [ ] **Step 1: Write failing state-machine tests with fakes**

Create in-memory fakes for recognizer, synthesizer, editor bridge, locator, rewrite service, preferences, and text generation. Cover these journeys:

```ts
it('moves idle → listening → understanding → reading → idle');
it('executes locate → read → rewrite in order');
it('pauses in clarifying when multiple candidates are close');
it('continues queued actions after candidate confirmation');
it('creates a non-mutating rewrite preview');
it('applies only after confirmPreview and records undo metadata');
it('shows an inverse preview before confirmUndo');
it('invalidates a preview when editor revision changes');
it('cancel aborts recognition, synthesis, locator, and rewrite');
it('ignores results from an older operation token');
it('never mutates the editor after permission, network, or timeout errors');
```

Run: `npm test -- src/voice/voice-copilot-controller.test.ts`

Expected: FAIL because the controller does not exist.

- [ ] **Step 2: Define the dependency and public API**

```ts
export interface VoiceCopilotDependencies {
  recognizer: SpeechRecognizer;
  synthesizer: SpeechSynthesizer;
  editor: EditorBridge;
  locator: SemanticLocator;
  rewriter: RewriteService;
  preferences: VoicePreferencesStore;
  getModelContext(): { userConfig: UserConfig; userID: string };
}

export class VoiceCopilotController extends EventTarget {
  readonly state: VoiceCopilotState;
  startListening(): void;
  stopListening(): void;
  submitTranscript(transcript: string): Promise<void>;
  read(scope: VoiceScope): Promise<void>;
  chooseCandidate(index: number): Promise<void>;
  confirmPreview(): void;
  rejectPreview(): void;
  requestUndo(): void;
  confirmUndo(): void;
  speakOriginal(): Promise<void>;
  speakReplacement(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  setRate(rate: number): void;
  cancel(): void;
  destroy(): void;
}

export const createInitialVoiceState = (): VoiceCopilotState => ({
  phase: 'idle',
  documentReady: false,
  transcript: '',
  partialTranscript: '',
  plan: null,
  candidates: [],
  preview: null,
  message: '',
  errorCode: null,
  playback: { active: false, paused: false, paragraphIndex: null, rate: 1 }
});
```

Initialize `documentReady` from `editor.getSnapshot().paragraphs.length > 0`. Dispatch a `state-change` event containing a deep snapshot after every transition. UI reads state but never mutates it.

- [ ] **Step 3: Implement ordered action execution**

Keep `pendingActions`, `resolvedTarget`, `activeAbortController`, and monotonically increasing `operationToken`. Normalize the final transcript with the current literal vocabulary before calling `parseVoicePlan`. For each action:

- `READ`: resolve the range, create speech chunks, highlight each chunk, and clear highlight on completion.
- `CONTROL`: call pause/resume/stop or clamp rate changes to `0.5..2`.
- `LOCATE`: await candidates. A unique exact result becomes `resolvedTarget`; otherwise enter `clarifying` and stop the queue.
- `REWRITE`: resolve target, generate replacement, verify operation token and revision, call `buildDiffSegments`, construct a UUID `RewritePreview`, stage it in EditorBridge, and enter `preview`.
- `UNDO`: verify EditorBridge can preview its last isolated voice edit, create the inverse preview, and require `confirmUndo`.

The queue resumes only after `chooseCandidate`. It stops at `preview` until confirmation or rejection.

- [ ] **Step 4: Implement interruption, errors, and stale-result guards**

`cancel()` increments the token, aborts the current controller, calls recognizer cancel, synthesizer cancel, clears highlight, drops queued actions, and returns to `idle`. Starting a new listening session first calls `cancel()` when phase is not `idle`. Typed errors map to stable user-facing codes/messages; `AbortError` maps to a quiet cancellation, not an error screen.

Before applying or undoing, call the bridge's version-checked stored-preview operation. A stale/intervening result enters `error` with code `stale-preview` and never performs another mutation.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- src/voice/voice-copilot-controller.test.ts
npm test
npm run build
```

Commit:

```bash
git add src/voice/voice-copilot-controller*
git commit -m "feat: orchestrate safe voice editing"
```

**Acceptance:** All approved states and transitions are deterministic; composite plans pause correctly; cancellation and stale results cannot mutate text.

## Task 10: Accessible persistent voice player

**Boundary:** Renders playback status and sends control calls to the controller. It cannot resolve scope or access the editor.

**Files:**
- Create: `src/components/voice-player/voice-player.ts`
- Create: `src/components/voice-player/voice-player.css`
- Create: `src/components/voice-player/voice-player.test.ts`

- [ ] **Step 1: Write failing component tests**

Start the test file with `// @vitest-environment jsdom`. Instantiate the Lit element with a fake controller and verify:

```ts
it('renders current paragraph and rate from controller state');
it('calls pause while playing and resume while paused');
it('calls stop, previous, and next with accessible button names');
it('clamps the rate control and announces changes');
it('is hidden when documentReady is false');
```

Query the shadow root by `aria-label`, never by private class names.

Run: `npm test -- src/components/voice-player/voice-player.test.ts`

Expected: FAIL because the component does not exist.

- [ ] **Step 2: Implement the component contract**

```ts
@customElement('top-writer-voice-player')
export class VoicePlayer extends LitElement {
  @property({ attribute: false }) controller!: VoiceCopilotController;
  @state() private voiceState = createInitialVoiceState();

  connectedCallback(): void;
  disconnectedCallback(): void;
  private handleStateChange(event: Event): void;
  render(): TemplateResult;
}
```

Subscribe/unsubscribe exactly once. Render Previous, Play/Pause, Next, Stop, rate select, and current scope. Previous/Next call `controller.read({ kind: 'previous' | 'next' })`. Use native buttons, `aria-pressed` for pause state, and an `aria-live="polite"` status.

- [ ] **Step 3: Implement responsive player CSS**

The player is sticky at the bottom of the center panel, uses existing color variables, remains keyboard reachable, and never covers the last editor paragraph. At widths below 700 px, collapse visible labels but retain accessible names.

- [ ] **Step 4: Verify keyboard and component behavior**

Run:

```bash
npm test -- src/components/voice-player/voice-player.test.ts
npm run build
```

Expected: component tests and build pass with no console errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/voice-player
git commit -m "feat: add accessible voice playback controls"
```

**Acceptance:** Every control is keyboard/assistive-technology accessible and delegates only to the controller.

## Task 11: Voice Copilot side panel, preview, clarification, and settings

**Boundary:** Renders controller state, text-command fallback, candidates, preview, errors, privacy notice, and speech settings. It does not implement domain decisions.

**Files:**
- Create: `src/components/voice-copilot/voice-copilot.ts`
- Create: `src/components/voice-copilot/voice-copilot.css`
- Create: `src/components/voice-copilot/voice-copilot.test.ts`

- [ ] **Step 1: Write failing component tests**

Start the test file with `// @vitest-environment jsdom`. Cover:

```ts
it('shows idle, listening, understanding, clarifying, preview, and error states');
it('shows interim transcript while listening and final transcript afterward');
it('submits the text-command fallback');
it('renders up to three candidate buttons and chooses the clicked candidate');
it('renders diff segments as text without interpreting HTML');
it('requires Apply or Keep original in rewrite preview');
it('requires confirmation for undo preview');
it('shows recovery actions for permission, network, and stale-preview errors');
it('persists rate, voice, and literal vocabulary entries');
it('shows the speech privacy notice before first microphone use');
```

Run: `npm test -- src/components/voice-copilot/voice-copilot.test.ts`

Expected: FAIL because the component does not exist.

- [ ] **Step 2: Implement state rendering and fallback input**

Give the component two injected properties: `controller: VoiceCopilotController` and `preferences: VoicePreferencesStore`. Use one top-level `<section aria-label="语音副驾">`. The microphone button label changes between `开始语音指令`, `结束语音指令`, and `取消当前操作`. Provide a text input and `发送` button that call `controller.submitTranscript`, so unsupported browsers retain every non-audio capability.

Use an `aria-live="polite"` region for phase/message and `aria-live="assertive"` only for errors.

- [ ] **Step 3: Render candidates and safe diff preview**

Render `DiffSegment[]` with Lit text bindings and semantic elements:

```ts
const renderSegment = (segment: DiffSegment) =>
  segment.kind === 'delete'
    ? html`<del>${segment.text}</del>`
    : segment.kind === 'insert'
      ? html`<ins>${segment.text}</ins>`
      : html`<span>${segment.text}</span>`;
```

Never use `unsafeHTML`. Color is supplementary to `<del>`/`<ins>` semantics, and complete `原文`/`新版` reading views remain available. Candidate buttons show `第 N 段`, a short excerpt, and reason. Preview buttons are `朗读原文`, `朗读新版`, `应用`, `重试`, and `保留原文`. Undo preview uses `确认撤回` and `取消`.

- [ ] **Step 4: Implement settings and privacy disclosure**

Provide rate, installed `zh-CN` voice, and vocabulary rows with spoken/written inputs. Validate non-empty unique entries. Before the first microphone start, show that Chrome may send audio to its speech provider, that Top Writer does not persist raw audio, and that text commands remain available. Persist acceptance through `VoicePreferencesStore`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- src/components/voice-copilot/voice-copilot.test.ts
npm run build
```

Commit:

```bash
git add src/components/voice-copilot
git commit -m "feat: add voice copilot panel"
```

**Acceptance:** The panel exposes all recovery/confirmation paths, never renders model text as HTML, and remains fully usable without speech APIs.

## Task 12: Top-level application integration and responsive layout

**Boundary:** Wires already-tested modules into the app and adjusts layout. It does not add new domain behavior.

**Files:**
- Modify: `src/components/wordflow/wordflow.ts`
- Modify: `src/components/wordflow/wordflow.css`
- Modify: `src/components/text-editor/text-editor.css`
- Modify: `index.html:2`
- Create: `src/components/wordflow/wordflow.voice.test.ts`

- [ ] **Step 1: Write a failing integration test**

Start the test file with `// @vitest-environment jsdom`. Mount `wordflow-wordflow` with fake speech globals and verify after `editor-bridge-ready`:

```ts
expect(root.querySelector('top-writer-voice-copilot')).not.toBeNull();
expect(root.querySelector('top-writer-voice-player')).not.toBeNull();
expect(copilot.controller).toBe(player.controller);
expect(textEditor.getVoiceEditorBridge()).toBeDefined();
```

Also assert that destroying the root destroys controller, service, and bridge listeners once.

Run: `npm test -- src/components/wordflow/wordflow.voice.test.ts`

Expected: FAIL because components are not mounted.

- [ ] **Step 2: Instantiate dependencies after editor readiness**

Add private fields for `TextGenerationService`, `EditorBridge`, `SemanticLocator`, `RewriteService`, browser speech adapters, preferences, and controller. Create the text-generation service once with the existing local worker. Handle a composed `editor-bridge-ready` event, guard against duplicate initialization, and construct the dependency graph from the bridge in the event detail.

Pass the same controller to both components. `getModelContext` returns current `this.userConfig` and the current local user ID at call time so configuration changes do not require reconstruction.

- [ ] **Step 3: Mount both components and add cleanup**

Render the player inside `.center-panel` after `.editor-content`. Render the side panel before `.footer-info` inside `.right-panel`. In `disconnectedCallback`, destroy controller, bridge, and text-generation service and then call `super.disconnectedCallback()`.

- [ ] **Step 4: Implement desktop and narrow layouts**

Set `html lang="zh-CN"`. Desktop (`min-width: 1100px`) uses `minmax(64px, 1fr) minmax(0, 70ch) clamp(320px, 26vw, 400px)`; the panel is sticky, `height: 100dvh`, and independently scrollable. Between 700–1099 px, the panel becomes a fixed right drawer with an always-visible open button. Below 700 px, it becomes a bottom sheet. At 200% zoom, the drawer path must prevent the global `overflow-x: hidden` rule from clipping the editor. Add bottom padding to the editor equal to the player height. Style decoration channels `target`, `candidate`, and `playback` distinctly without changing document marks.

Respect `prefers-reduced-motion`; state changes use opacity/color, not continuous pulsing.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- src/components/wordflow/wordflow.voice.test.ts
npm test
npm run build
```

Commit:

```bash
git add index.html src/components/wordflow src/components/text-editor/text-editor.css
git commit -m "feat: integrate voice copilot into Top Writer"
```

**Acceptance:** One dependency graph is mounted once, desktop/narrow layouts preserve editor usability, cleanup is leak-free, and all unit/integration tests pass.

## Task 13: Playwright end-to-end journeys and real browser contracts

**Boundary:** Adds browser verification only. Test fakes replace nondeterministic browser speech recognition/synthesis and external model responses, while the real built app, Lit components, controller, scope logic, Tiptap transactions, and undo path execute unchanged.

**Files:**
- Create: `playwright.config.ts`
- Create: `playwright.chrome.config.ts`
- Create: `test/e2e/helpers/speech-fakes.ts`
- Create: `test/e2e/helpers/editor-fixture.ts`
- Create: `test/e2e/voice-copilot.spec.ts`
- Create: `test/eval/voice-command-cases.json`
- Create: `test/eval/semantic-locator-cases.json`
- Create: `src/voice/voice-quality-gates.test.ts`
- Create: `test/smoke/voice.chrome.real.spec.ts`
- Modify: `package.json`

- [ ] **Step 1: Configure Playwright and install Chromium**

Create:

```ts
import { defineConfig, devices } from '@playwright/test';

const externalBaseURL = process.env.VOICE_BASE_URL;

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: externalBaseURL ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: externalBaseURL
    ? undefined
    : {
        command: 'npm run dev -- --host 127.0.0.1 --port 4173',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: !process.env.CI
      }
});
```

Run: `npx playwright install chromium`.

Create `playwright.chrome.config.ts` by extending the base config with `channel: 'chrome'`, `headless: false`, `workers: 1`, microphone permission, `testDir: './test/smoke'`, and no speech API mocks. This smoke suite checks constructor availability, visible listening/abort states, editor immutability on cancel, and a usable no-voice fallback. It does not require CI to hear audio or receive a live transcript.

- [ ] **Step 2: Inject browser speech fakes without production hooks**

Before navigation, `page.addInitScript` installs fake `SpeechRecognition`, `webkitSpeechRecognition`, `SpeechSynthesisUtterance`, and `speechSynthesis`. Expose only a test-world controller on `window.__speechTest` that can emit partial/final/error events and complete utterances. Production code remains unaware of this object.

Intercept the Wordflow generation endpoint and return a valid `PromptRunSuccessResponse` whose replacement text is deterministic. Do not bypass `VoiceCopilotController` or `EditorBridge`.

- [ ] **Step 3: Write the twelve approved real-application journeys**

Test:

1. Read whole document.
2. Read selection.
3. Previous paragraph.
4. Next paragraph.
5. Pause and resume.
6. Interrupt playback with a new command.
7. Semantic locate one result.
8. Clarify between multiple results.
9. Rewrite one paragraph and reject preview.
10. Locate → read → rewrite, compare diff, and apply.
11. Apply then show inverse preview and undo.
12. Text-command fallback with speech APIs absent.

Each mutation test captures editor JSON before preview, proves preview did not change it, applies, then compares exact expected document JSON.

- [ ] **Step 4: Add failure and viewport coverage**

Test permission denial, no speech, network failure, model timeout, cancel during generation, stale preview after manual typing, page refresh, 1024 px drawer, 390 px bottom sheet, 200% zoom reflow, keyboard-only apply/reject, and no uncaught page errors. Use `@axe-core/playwright` on idle, clarifying, preview, and error screens; fail on serious or critical violations.

Create at least 40 Mandarin fixed-command cases and 20 labeled long-form semantic-location cases, including mixed Chinese/English terms, names, brands, numbers, punctuation, self-correction, and noisy filler. `voice-quality-gates.test.ts` must compute and assert fixed-scope accuracy `>= 0.95` and semantic Top-3 recall `>= 0.90`.

With deterministic browser fakes, measure UI overhead and assert microphone state is visible within 150 ms of click, an emitted partial transcript is visible within one second, and a read command calls the synthesis boundary within 1.5 seconds. These tests measure Top Writer latency, not external provider network quality.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm run test:e2e
npm run verify
npm run test:smoke:chrome
```

Expected: all unit, build, and Chromium E2E checks pass with zero retries required.

Commit:

```bash
git add playwright.config.ts playwright.chrome.config.ts test/e2e test/eval test/smoke src/voice/voice-quality-gates.test.ts package.json package-lock.json
git commit -m "test: verify voice copilot end to end"
```

**Acceptance:** The real app completes all core journeys in Chromium; deterministic fakes replace only external speech/model boundaries; preview safety and exact undo are proven against actual Tiptap state; branded Chrome confirms production adapters can enter and cancel listening without mutating the document.

## Task 14: Quality gates, privacy documentation, and CI

**Boundary:** Hardens accessibility, documents support/privacy, and makes the complete verification suite mandatory on pull requests.

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `docs/voice-copilot.md`
- Modify: `README.md`
- Create: `public/privacy/index.html`
- Modify: voice component and E2E tests when a quality gap is found

- [ ] **Step 1: Add the PR workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run verify
```

- [ ] **Step 2: Document exact support and privacy boundaries**

`docs/voice-copilot.md` must state desktop Chrome support, Mandarin-first behavior, text fallback, browser-vendor audio processing, no Top Writer raw-audio persistence, minimum-text LLM policy, cancellation behavior, and deletion of voice preferences. Link it from README and the in-app privacy notice.

`public/privacy/index.html` must repeat the user-visible data flow in plain language and avoid claiming browser-vendor audio stays on device.

- [ ] **Step 3: Verify accessibility through behavior assertions**

Automated tests must prove every interactive control has a unique accessible name, phase/error announcements use the correct live-region priority, all functions are keyboard reachable, focus moves to clarification/preview headings, focus returns to the microphone after completion, and reduced-motion mode contains no infinite animation.

- [ ] **Step 4: Run the complete local release gate**

Run:

```bash
npm ci
npm run verify
git diff --check
```

Expected: clean install succeeds; unit, build, and all E2E tests pass; no whitespace errors.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml docs README.md public src test
git commit -m "docs: define voice copilot support and quality gates"
```

**Acceptance:** Pull requests cannot pass without unit/build/E2E verification, and users receive an accurate support/privacy disclosure before microphone use.

## Task 15: Final review, pull request, merge, deployment, and production acceptance

**Boundary:** No new feature work. Any failure returns to the owning task and is fixed with a regression test before this release sequence restarts.

**Files:**
- No planned source files; regression fixes are scoped to the failing module.

- [ ] **Step 1: Run final technical verification and focused code reviews**

Run:

```bash
npm ci
npm run verify
npm run build
git diff --check
git status --short --branch
```

Dispatch independent review agents for spec compliance, editor safety, speech lifecycle, controller concurrency/cancellation, UI accessibility, and E2E realism. Resolve every P0/P1 issue and every correctness issue; rerun the full gate after fixes.

- [ ] **Step 2: Rebase safely onto current main and reverify**

```bash
git fetch origin
git rebase origin/main
npm ci
npm run verify
```

If conflicts occur, resolve only feature-owned files, preserve unrelated main changes, and add regression coverage for behavioral conflicts.

- [ ] **Step 3: Push and create the pull request**

```bash
git push -u origin feature/voice-copilot
gh pr create \
  --base main \
  --head feature/voice-copilot \
  --title "feat: add safe voice copilot" \
  --body-file /tmp/top-writer-voice-copilot-pr.md
```

The PR body must include product scope, privacy boundary, test inventory, screenshots for desktop/mobile states, known browser boundary, and exact local verification output.

- [ ] **Step 4: Wait for required checks and merge only when green**

```bash
gh pr checks --watch --interval 10
gh pr view --json number,url,mergeStateStatus,statusCheckRollup,isDraft
gh pr merge --squash --delete-branch
```

Do not merge a draft, failing check, unresolved review, dirty merge state, or PR targeting anything except `main`. After merge:

```bash
git fetch origin
git rev-parse origin/main
```

Confirm the merge commit contains the PR.

- [ ] **Step 5: Deploy merged main and perform production E2E acceptance**

Create a clean release worktree at `origin/main`, build there, and deploy with the Vercel token read from `/Users/apulu/Documents/yy-home/top-writer/.env-deploy` without printing it:

```bash
VERCEL_TOKEN=$(awk -F= '/^Vercel-Digital-y-Token=/{sub(/^[^=]*=/, ""); print; exit}' /Users/apulu/Documents/yy-home/top-writer/.env-deploy)
test -n "$VERCEL_TOKEN"
npm ci
npm run verify
npx --yes vercel@latest link --yes --project top-writer --scope 1strikery-s-projects --token "$VERCEL_TOKEN"
npx --yes vercel@latest --prod --yes --token "$VERCEL_TOKEN"
```

Then verify:

```bash
curl --fail --silent --show-error --location --output /dev/null \
  --write-out 'HTTP %{http_code}\n' https://top-writer.vercel.app
```

Run the deterministic production journey against the deployed alias:

```bash
VOICE_BASE_URL=https://top-writer.vercel.app npx playwright test test/e2e/voice-copilot.spec.ts
```

Confirm HTTP 200, Top Writer branding, editor load, voice panel/player presence, text-command read, locate, rewrite preview, confirmed apply, and undo.

**Acceptance:** PR checks and reviews pass, the PR is merged into `main`, merged main is deployed, production returns HTTP 200, and production E2E proves the complete safe voice flow. Only then notify the user for manual acceptance.

## Final definition of done

- All 15 tasks are checked and represented by reviewed commits.
- `npm run verify` passes from a clean install and on GitHub Actions.
- Unsupported speech APIs retain a fully functional text-command path.
- The product can read whole/current/adjacent/selected ranges, pause/resume/stop, locate semantically, clarify candidates, rewrite with a non-mutating diff, apply once, and preview/confirm undo.
- There are zero paths that write text before explicit confirmation.
- Cancellation, stale results, network errors, permission denial, and refresh do not modify the document.
- The feature branch is merged to `main`, Vercel production is updated, and production E2E passes before human acceptance is requested.
