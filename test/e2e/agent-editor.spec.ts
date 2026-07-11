import { expect, test, type Page, type Route } from "@playwright/test";

type AgentContext = {
  kind: "selection" | "current-block";
  revision: number;
  from: number;
  to: number;
  text: string;
  originalTextHash: string;
};

const wordflowApi = /execute-api\.us-east-1\.amazonaws\.com\/prod\/records\?type=run/;

const agentContextFor = (route: Route): AgentContext => {
  const body = route.request().postDataJSON() as { text?: unknown };
  if (typeof body.text !== "string") throw new Error("Expected a text-generation request");
  const marker = "CONTEXT:\n";
  const index = body.text.indexOf(marker);
  if (index < 0) throw new Error("Expected the AgentSessionController protocol prompt");
  return JSON.parse(body.text.slice(index + marker.length)) as AgentContext;
};

const fulfill = (route: Route, result: string) =>
  route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ payload: { result, fullPrompt: "e2e" } }),
  });

const installAgentModel = async (page: Page) => {
  let responseNumber = 0;
  await page.route(wordflowApi, async (route) => {
    const context = agentContextFor(route);
    responseNumber += 1;
    await fulfill(route, JSON.stringify([{
      id: `e2e-agent-${responseNumber}`,
      type: "replaceRange",
      revision: context.revision,
      from: context.from,
      to: context.to,
      originalTextHash: context.originalTextHash,
      replacement: `Agent rewrite ${responseNumber}.`,
    }]));
  });
};

const freshPage = async (page: Page) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Ask AI" })).toBeEnabled();
};

const askForParagraph = async (page: Page, paragraph: number) => {
  const target = page.locator(".ProseMirror p").filter({ hasText: /\S/ }).nth(paragraph);
  await target.click();
  await page.getByRole("button", { name: "Ask AI" }).click();
};

test("runs the visible Ask AI flow through protocol validation and reviews each suggestion", async ({ page }) => {
  await installAgentModel(page);
  await freshPage(page);

  await askForParagraph(page, 0);
  await expect(page.getByText("Suggestion 1 of 1")).toBeVisible();
  await expect(page.locator(".agent-suggestion")).toHaveCount(2);

  await askForParagraph(page, 1);
  await expect(page.getByText("Suggestion 1 of 2")).toBeVisible();

  await page.getByRole("button", { name: "Next suggestion" }).click();
  await expect(page.getByText("Suggestion 2 of 2")).toBeVisible();
  await page.getByRole("button", { name: "Accept suggestion" }).click();
  await expect(page.getByText("Suggestion 1 of 1")).toBeVisible();
  await expect(page.locator(".ProseMirror")).toContainText("Agent rewrite 2.");

  await page.getByRole("button", { name: "Reject suggestion" }).click();
  await expect(page.getByText("Suggestion 0 of 0")).toBeVisible();
  await expect(page.locator(".ProseMirror")).not.toContainText("Agent rewrite 1.");

  await askForParagraph(page, 0);
  await askForParagraph(page, 1);
  await expect(page.getByText("Suggestion 1 of 2")).toBeVisible();
  await page.getByRole("button", { name: "Accept all suggestions" }).click();
  await expect(page.getByText("Suggestion 0 of 0")).toBeVisible();
  await expect(page.locator(".ProseMirror")).toContainText("Agent rewrite 3.");
  await expect(page.locator(".ProseMirror")).toContainText("Agent rewrite 4.");

  await askForParagraph(page, 0);
  await askForParagraph(page, 1);
  await expect(page.getByText("Suggestion 1 of 2")).toBeVisible();
  await page.getByRole("button", { name: "Reject all suggestions" }).click();
  await expect(page.getByText("Suggestion 0 of 0")).toBeVisible();
  await expect(page.locator(".ProseMirror")).not.toContainText("Agent rewrite 5.");
  await expect(page.locator(".ProseMirror")).not.toContainText("Agent rewrite 6.");
});

test("reviews suggestions by keyboard without taking over editor typing keys", async ({ page }) => {
  await installAgentModel(page);
  await freshPage(page);

  await askForParagraph(page, 0);
  await askForParagraph(page, 1);
  await expect(page.getByText("Suggestion 1 of 2")).toBeVisible();

  const editor = page.locator(".ProseMirror");
  await editor.focus();
  await editor.press("ArrowRight");
  await expect(page.getByText("Suggestion 1 of 2")).toBeVisible();

  const review = page.locator("top-writer-agent-review-bar").locator("section");
  await review.focus();
  await review.press("ArrowRight");
  await expect(page.getByText("Suggestion 2 of 2")).toBeVisible();
  await review.press("a");
  await expect(page.getByText("Suggestion 1 of 1")).toBeVisible();
  await expect(editor).toContainText("Agent rewrite 2.");

  const reject = page.getByRole("button", { name: "Reject suggestion" });
  await reject.focus();
  await reject.press("Enter");
  await expect(page.getByText("Suggestion 0 of 0")).toBeVisible();
  await expect(editor).not.toContainText("Agent rewrite 1.");
});

test("drops a delayed Ask AI response after the document revision changes", async ({ page }) => {
  let releaseModel: (() => void) | undefined;
  let requestStarted: (() => void) | undefined;
  const responseReleased = new Promise<void>((resolve) => { releaseModel = resolve; });
  const requestObserved = new Promise<void>((resolve) => { requestStarted = resolve; });
  await page.route(wordflowApi, async (route) => {
    const context = agentContextFor(route);
    requestStarted?.();
    await responseReleased;
    await fulfill(route, JSON.stringify([{
      id: "e2e-stale-agent",
      type: "replaceRange",
      revision: context.revision,
      from: context.from,
      to: context.to,
      originalTextHash: context.originalTextHash,
      replacement: "This stale response must never be shown.",
    }]));
  });
  await freshPage(page);

  const editor = page.locator(".ProseMirror");
  const before = await page.evaluate(() => {
    const wordflow = document.querySelector("wordflow-wordflow") as unknown as {
      voiceBridge?: { getRevision(): number; getSnapshot(): { paragraphs: Array<{ text: string }> } };
    };
    const bridge = wordflow.voiceBridge;
    if (!bridge) throw new Error("Expected the editor bridge to be ready");
    return {
      revision: bridge.getRevision(),
      text: bridge.getSnapshot().paragraphs.map((paragraph) => paragraph.text).join("\n"),
    };
  });
  await editor.click();
  await page.getByRole("button", { name: "Ask AI" }).click();
  await requestObserved;
  await editor.press("End");
  await editor.press(" ");
  await expect.poll(async () => page.evaluate(() => {
    const wordflow = document.querySelector("wordflow-wordflow") as unknown as {
      voiceBridge?: { getRevision(): number; getSnapshot(): { paragraphs: Array<{ text: string }> } };
    };
    const bridge = wordflow.voiceBridge;
    return bridge
      ? {
          revision: bridge.getRevision(),
          text: bridge.getSnapshot().paragraphs.map((paragraph) => paragraph.text).join("\n"),
        }
      : null;
  })).toEqual(expect.objectContaining({ revision: before.revision + 1 }));
  await expect.poll(async () => page.evaluate(() => {
    const wordflow = document.querySelector("wordflow-wordflow") as unknown as {
      voiceBridge?: { getSnapshot(): { paragraphs: Array<{ text: string }> } };
    };
    return wordflow.voiceBridge?.getSnapshot().paragraphs
      .map((paragraph) => paragraph.text)
      .join("\n") ?? null;
  })).not.toBe(before.text);
  releaseModel?.();

  await expect(page.getByText("Suggestion 1 of 1")).toHaveCount(0);
  await page.waitForTimeout(100);
  await expect(page.getByText("Suggestion 1 of 1")).toHaveCount(0);
  await expect(editor).not.toContainText("This stale response must never be shown.");
});

test("reviews a voice rewrite through the shared bar and safely undoes it", async ({ page }) => {
  await page.route(wordflowApi, async (route) => {
    const body = route.request().postDataJSON() as { text?: unknown };
    if (typeof body.text === "string" && body.text.includes("You are a document editing agent.")) {
      throw new Error("This test must exercise the voice rewrite boundary, not Ask AI");
    }
    await fulfill(route, "Voice review rewrite.");
  });
  await freshPage(page);

  const firstParagraph = page.locator(".ProseMirror p").filter({ hasText: /\S/ }).first();
  const originalText = await firstParagraph.textContent();
  await firstParagraph.click();
  await page.getByRole("button", { name: "语音副驾" }).click();
  await page.getByRole("textbox", { name: "文字指令" }).fill("改写当前段");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.getByText("Suggestion 1 of 1")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "语音副驾" })).toHaveCount(0);
  await page.getByRole("button", { name: "Accept suggestion" }).click();
  await expect(page.locator(".ProseMirror")).toContainText("Voice review rewrite.");
  await page.getByRole("button", { name: "语音副驾" }).click();
  await expect(page.getByRole("button", { name: "撤回刚才改动" })).toBeVisible();

  await page.getByRole("button", { name: "撤回刚才改动" }).click();
  await expect(page.getByRole("heading", { name: "撤回预览" })).toBeVisible();
  await page.getByRole("button", { name: "确认撤回" }).click();
  await expect(page.locator(".ProseMirror")).toContainText(originalText ?? "");
  await expect(page.locator(".ProseMirror")).not.toContainText("Voice review rewrite.");
});
