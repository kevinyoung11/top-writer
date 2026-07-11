# Open Agent Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Top Writer to open-source Tiptap 3 and add an in-document AI Agent Editor with safe, navigable, reviewable suggestions.

**Architecture:** Keep Lit and existing voice infrastructure. Add a framework-agnostic agent protocol and ProseMirror Decoration extension; suggestions stay ephemeral until accepted. Agent UI calls the existing cancellable generation service through an isolated session controller.

**Tech Stack:** Tiptap 3, ProseMirror, Lit 3, TypeScript, Vitest, Playwright.

---

### Task 1: Upgrade the Tiptap foundation safely

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/components/text-editor/text-editor.ts`
- Test: existing editor/voice suites

- [ ] Write a failing compatibility test that creates the current editor and bridge with the installed Tiptap major version.
- [ ] Run it RED after dependency upgrade; record API/compiler errors.
- [ ] Upgrade all `@tiptap/*` packages to one Tiptap 3 release line, replace the direct `node_modules` style import with supported public CSS/style handling, and make minimal adapter fixes.
- [ ] Run `npm run typecheck`, editor bridge tests, voice suites, and `npm run build` GREEN.
- [ ] Commit `chore: upgrade editor to tiptap 3`.

**Acceptance:** Existing editor JSON, voice highlight, preview, undo, and mobile UI tests survive the major upgrade.

### Task 2: Define and validate an agent edit protocol

**Files:**
- Create: `src/agent/types.ts`, `src/agent/edit-protocol.ts`, `src/agent/edit-protocol.test.ts`

- [ ] RED tests for validation of `replaceRange`, `insertAfterRange`, and `deleteRange`: finite positions, revision equality, exact original-text hash, nonempty replacement rules, and unique IDs.
- [ ] Implement pure parser/validator that accepts only JSON arrays of typed operations and rejects prose/unknown fields/out-of-document ranges.
- [ ] GREEN focused tests and commit `feat: define safe agent edit protocol`.

**Acceptance:** Untrusted model text can never create a mutation-ready operation without validating against the current EditorSnapshot.

### Task 3: Build ephemeral suggestion decorations and review commands

**Files:**
- Create: `src/agent/agent-suggestion-extension.ts`, `src/agent/agent-suggestion-extension.test.ts`
- Modify: `src/components/text-editor/text-editor.ts`, `src/voice/editor/editor-bridge.ts`

- [ ] RED tests for add/list/current/next/previous/reject/accept/acceptAll/rejectAll.
- [ ] Implement a ProseMirror plugin state storing suggestions as decorations; acceptance applies one transaction and removes only the accepted item, rejection only removes the decoration.
- [ ] Verify suggestions do not change editor JSON before acceptance, stale revision refuses acceptance, and accepted transaction is undoable.
- [ ] Commit `feat: add reviewable agent suggestions`.

**Acceptance:** Inline red/green Diff is local and ephemeral, while accepted changes use normal document history.

### Task 4: Add the agent session controller and streaming boundary

**Files:**
- Create: `src/agent/agent-session-controller.ts`, `src/agent/agent-session-controller.test.ts`
- Modify: `src/llms/text-generation-service.ts` only if a missing cancellable streaming primitive is proven.

- [ ] RED tests for selection/current-block/document-outline context minimization, cancellation, stale revision discard, structured operation decode, and concurrent-session suppression.
- [ ] Implement EventTarget controller using `TextGenerationService`, a limited context reader, operation validator, and suggestion extension commands.
- [ ] Keep models behind existing provider configuration; no browser secret and no direct document mutation.
- [ ] Commit `feat: orchestrate safe document agent sessions`.

**Acceptance:** AI or voice entry can initiate a session, but revisions/cancellation/invalid output cannot mutate content.

### Task 5: Implement Agent Editor toolbar and review bar

**Files:**
- Create: `src/components/agent-editor/agent-toolbar.ts`, `.css`, `.test.ts`, `agent-review-bar.ts`, `.css`, `.test.ts`
- Modify: `src/components/wordflow/wordflow.ts`, `.css`

- [ ] RED component tests for toolbar commands, agent launch, review navigation/count, single/all accept/reject, disabled states, keyboard names, and mobile placement.
- [ ] Implement controls with native buttons; inject controller/editor commands, never call model APIs from view components.
- [ ] Render toolbar over editor and review bar above player; preserve the existing voice drawer/entry.
- [ ] Commit `feat: add agent editor controls`.

**Acceptance:** The screenshot’s primary Agent Editor behavior is available without Tiptap paid packages and remains accessible at mobile widths.

### Task 6: Integrate voice and agent review flows

**Files:**
- Modify: `src/voice/voice-copilot-controller.ts`, `src/voice/voice-copilot-controller.test.ts`, `src/components/voice-copilot/voice-copilot.ts`

- [ ] RED tests proving a voice rewrite can be represented as a shared suggestion, opened in the review bar, accepted/rejected and undone.
- [ ] Adapt the controller to route rewrite previews through the shared suggestion facade while preserving its existing safety messages and fallback.
- [ ] Run complete voice tests GREEN and commit `refactor: share voice and agent review flow`.

**Acceptance:** There is a single user-visible review model, not two competing Diff systems.

### Task 7: End-to-end release validation

**Files:**
- Modify: `test/e2e/voice-ui.spec.ts`
- Create: `test/e2e/agent-editor.spec.ts`

- [ ] RED browser journeys for toolbar format, model stub → inline suggestions, keyboard navigation, item/all actions, undo, voice rewrite review, desktop/mobile review bar, and cancellation.
- [ ] Add fixtures that intercept model output but retain real Tiptap, transactions, decorations and Lit controls.
- [ ] Run `npm ci && npm run verify`, inspect mobile/desktop screenshots and Axe scans, then commit `test: verify open agent editor journeys`.
- [ ] Push feature branch, open PR, wait for Checks, merge main, confirm Vercel auto deployment, and run production E2E.

**Acceptance:** All existing and new unit/E2E tests pass, main has the merge commit, and production demonstrates agent review on desktop and mobile.
