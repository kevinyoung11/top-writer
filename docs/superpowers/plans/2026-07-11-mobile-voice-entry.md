# Mobile Voice Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-reachable right-edge voice shortcut and responsive voice-copilot drawer without sacrificing the editor on tablet or mobile.

**Architecture:** `WordflowWordflow` owns shortcut visibility, drawer state, focus, player-height measurement, and breakpoints. It must not reuse `wordflow-sidebar-menu` (a diff popper) or `wordflow-floating-menu` (selection-dependent prompt tools). `VoiceCopilotPanel` remains the controller-backed content surface; the drawer shell is the only new layout/focus owner.

**Tech Stack:** Lit 3, TypeScript, ResizeObserver, CSS media queries, Vitest/jsdom, Playwright Chromium, axe-core/playwright.

---

### Task 1: Specify a stable drawer focus contract

**Files:**
- Modify: `src/components/voice-copilot/voice-copilot.ts`
- Modify: `src/components/voice-copilot/voice-copilot.test.ts`

- [ ] **Step 1: Write the failing public focus test**

```ts
it("focuses its heading through the public focusHeading API", async () => {
  const panel = document.createElement("top-writer-voice-copilot");
  document.body.append(panel);
  await panel.updateComplete;
  panel.focusHeading();
  expect(panel.shadowRoot?.activeElement?.textContent).toBe("语音副驾");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- --run src/components/voice-copilot/voice-copilot.test.ts`

Expected: FAIL because `focusHeading` does not exist.

- [ ] **Step 3: Add the minimal public API**

```ts
@query("h1") private heading?: HTMLHeadingElement;

focusHeading(): void {
  this.heading?.focus();
}
```

Set `tabindex="-1"` on the existing `h1`. Do not move viewport, drawer, or controller logic into this component.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm test -- --run src/components/voice-copilot/voice-copilot.test.ts`

Expected: PASS.

```bash
git add src/components/voice-copilot
git commit -m "feat: expose voice panel focus target"
```

### Task 2: Add root-owned voice-entry and drawer state

**Files:**
- Modify: `src/components/wordflow/wordflow.ts`
- Create: `src/components/wordflow/wordflow.voice-entry.test.ts`

- [ ] **Step 1: Write failing root-state tests**

```ts
it("opens and closes the named voice drawer while restoring trigger focus", async () => {
  const trigger = root.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label='语音副驾']")!;
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  trigger.click();
  await root.updateComplete;
  expect(root.shadowRoot?.querySelector("#voice-copilot-drawer")).not.toBeNull();
  root.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label='关闭语音副驾']")?.click();
  await root.updateComplete;
  expect(root.shadowRoot?.querySelector("#voice-copilot-drawer")).toBeNull();
  expect(root.shadowRoot?.activeElement).toBe(trigger);
});
```

Also test: default is closed; `aria-controls="voice-copilot-drawer"`; Escape closes; backdrop-only click closes; opening and closing do not call a controller operation or instantiate a second controller.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run src/components/wordflow/wordflow.voice-entry.test.ts`

Expected: FAIL because the entry and drawer do not exist.

- [ ] **Step 3: Implement the root boundary**

Add `@state() private voiceDrawerOpen = false`, a `@query("[data-voice-entry]")` trigger, and methods:

```ts
private openVoiceDrawer() { this.voiceDrawerOpen = true; }
private closeVoiceDrawer() {
  this.voiceDrawerOpen = false;
  void this.updateComplete.then(() => this.voiceEntry?.focus());
}
```

Render an independent rail button in `.right-panel` (not in either existing menu), then conditionally render:

```ts
<div class="voice-drawer-backdrop" @click=${this.onDrawerBackdropClick}></div>
<aside id="voice-copilot-drawer" role="dialog" aria-modal="true" aria-label="语音副驾">
  <button aria-label="关闭语音副驾" @click=${this.closeVoiceDrawer}>关闭</button>
  <top-writer-voice-copilot .controller=${this.voiceController}
    .preferences=${this.voicePreferences}></top-writer-voice-copilot>
</aside>
```

After open, await panel `updateComplete` then call `focusHeading()`. Scope Escape handling to the drawer. Closing while `phase === "listening"` calls public `controller.cancel()`; closing in every other phase only hides the drawer so preview/state is preserved.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm test -- --run src/components/wordflow/wordflow.voice-entry.test.ts`

Expected: PASS.

```bash
git add src/components/wordflow/wordflow.ts src/components/wordflow/wordflow.voice-entry.test.ts
git commit -m "feat: add root voice drawer entry"
```

### Task 3: Reserve measured player space and implement breakpoints

**Files:**
- Modify: `src/components/wordflow/wordflow.ts`
- Modify: `src/components/wordflow/wordflow.css`
- Modify: `src/components/text-editor/text-editor.css`
- Modify: `src/components/voice-player/voice-player.css`
- Modify: `src/components/wordflow/wordflow.voice-entry.test.ts`

- [ ] **Step 1: Write failing observer and CSS-contract tests**

```ts
it("publishes the measured player height as a root CSS variable", () => {
  observerCallback([{ contentRect: { height: 84 } }]);
  expect(centerPanel.style.getPropertyValue("--voice-player-height")).toBe("84px");
});

it("ships drawer breakpoints without retaining the desktop grid on mobile", async () => {
  const css = await readFile("src/components/wordflow/wordflow.css", "utf8");
  expect(css).toContain("@media (max-width: 699px)");
  expect(css).toContain("#voice-copilot-drawer");
  expect(css).toContain("100dvh");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- --run src/components/wordflow/wordflow.voice-entry.test.ts`

Expected: FAIL because no observer or responsive rules exist.

- [ ] **Step 3: Implement measurement and CSS**

Attach one `ResizeObserver` to `top-writer-voice-player` after it mounts, set `--voice-player-height` on `.center-panel`, and disconnect it in `disconnectedCallback`.

Use these exact ranges:

```css
@media (min-width: 1100px) { #voice-copilot-drawer { inset: 0 0 0 auto; width: clamp(320px, 26vw, 400px); } }
@media (min-width: 700px) and (max-width: 1099px) { #voice-copilot-drawer { inset: 0 0 0 auto; width: min(400px, 90vw); } }
@media (max-width: 699px) { .wordflow { grid-template-columns: 0 minmax(0, 1fr) 0; overflow-x: clip; } #voice-copilot-drawer { inset: auto 0 var(--voice-player-height, 72px) 0; max-height: min(78dvh, 680px); } }
```

For both drawer forms use `position: fixed`, `overflow-y: auto`, `min-height: 0`, `env(safe-area-inset-bottom)`, and a 44px entry/close target. At mobile width set editor horizontal padding to 16px and bottom padding to player height plus safe area. Keep the prompt floating menu untouched.

- [ ] **Step 4: Run GREEN, typecheck, and commit**

Run: `npm test -- --run src/components/wordflow/wordflow.voice-entry.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/components/wordflow src/components/text-editor/text-editor.css src/components/voice-player/voice-player.css
git commit -m "feat: adapt voice drawer for narrow screens"
```

### Task 4: Validate responsive browser behavior and accessibility

**Files:**
- Modify: `test/e2e/voice-ui.spec.ts`
- Create: `test/e2e/voice-entry-responsive.spec.ts`

- [ ] **Step 1: Write failing desktop/tablet/mobile browser journeys**

```ts
test("opens a mobile bottom drawer without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "语音副驾" }).click();
  await expect(page.getByRole("dialog", { name: "语音副驾" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "文字指令" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
```

Cover 1280px right drawer, 1024px right overlay, 390px bottom drawer, and 640px reflow. At each width assert drawer and editor bounding rectangles are within the viewport. Verify keyboard open/close, focus landing/return, close button and backdrop, player remains reachable, and Axe has no serious/critical violations in closed and open states.

- [ ] **Step 2: Run RED**

Run: `npm run test:e2e -- --grep "mobile bottom drawer"`

Expected: FAIL because mobile entry/drawer behavior is absent.

- [ ] **Step 3: Update old default-visibility assertion**

In `voice-ui.spec.ts`, assert the named entry is visible and the drawer is initially absent; then open it before checking text fallback and privacy disclosure.

- [ ] **Step 4: Run full verification and commit**

Run: `npm run verify`

Expected: typecheck, all unit tests, production build, and all responsive Chromium tests PASS.

```bash
git add test/e2e
git commit -m "test: cover responsive voice drawer"
```

### Task 5: Review, PR, merge, deployment, and production E2E

**Files:**
- No production files expected beyond review fixes.

- [ ] **Step 1: Audit boundaries**

Run:

```bash
rg -n "unsafeHTML|unsafe-html|innerHTML|outerHTML" src/components/voice-copilot
git diff origin/main...HEAD --check
```

Expected: no new unsafe rendering in the copilot; no whitespace errors.

- [ ] **Step 2: Run a clean release gate**

Run: `npm ci && npm run verify`

Expected: PASS.

- [ ] **Step 3: Publish only the feature branch**

```bash
git push -u origin feature/mobile-voice-entry
gh pr create --base main --head feature/mobile-voice-entry --title "feat: add responsive voice shortcut"
```

- [ ] **Step 4: Wait for checks and merge only if green**

Run:

```bash
gh pr checks --watch
gh pr merge --squash --delete-branch
```

Expected: every check green and a merge commit on `origin/main`.

- [ ] **Step 5: Deploy merged main and test production**

Run:

```bash
VERCEL_TOKEN=$(awk -F= '/^Vercel-Digital-y-Token=/{sub(/^[^=]*=/, ""); print; exit}' /Users/apulu/Documents/yy-home/top-writer/.env-deploy)
npx --yes vercel@latest --prod --yes --token "$VERCEL_TOKEN"
VOICE_BASE_URL=https://top-writer.vercel.app npm run test:e2e
```

Expected: deployment Ready, production HTTP 200, and desktop/mobile browser journeys PASS.
