import { expect, test, type Page } from "@playwright/test";

async function addVisibleSuggestion(page: Page) {
  await page.waitForFunction(() => {
    const wordflow = document.querySelector("wordflow-wordflow") as unknown as {
      voiceBridge?: unknown;
    };
    return Boolean(wordflow?.voiceBridge);
  });

  await page.evaluate(async () => {
    const wordflow = document.querySelector("wordflow-wordflow") as unknown as {
      voiceBridge: {
        getSnapshot(): { revision: number; paragraphs: Array<{ from: number; to: number; text: string }> };
        addAgentSuggestions(operations: unknown[]): Promise<unknown>;
      };
      agentReviewVisible: boolean;
      agentReviewRefresh: number;
    };
    const bridge = wordflow.voiceBridge;
    const snapshot = bridge.getSnapshot();
    const targets = snapshot.paragraphs.filter((paragraph) => paragraph.text.length > 0).slice(0, 2);
    const operations = await Promise.all(targets.map(async (paragraph, index) => {
      const hashBuffer = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(paragraph.text),
      );
      const originalTextHash = [...new Uint8Array(hashBuffer)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return {
        id: `e2e-visible-review-${index}`,
        type: "replaceRange",
        revision: snapshot.revision,
        from: paragraph.from,
        to: paragraph.to,
        originalTextHash,
        replacement: `${paragraph.text} improved`,
      };
    }));

    await bridge.addAgentSuggestions(operations);
    wordflow.agentReviewVisible = true;
    wordflow.agentReviewRefresh += 1;
  });
}

test("desktop toolbar clears the sticky logo and applies Bold through a real click", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  const logo = page.locator("wordflow-wordflow").locator(".logo-container");
  const toolbar = page.locator("top-writer-agent-toolbar");
  const bold = page.getByRole("button", { name: "Bold" });

  await expect(toolbar).toBeVisible();
  const [logoBox, toolbarBox] = await Promise.all([logo.boundingBox(), toolbar.boundingBox()]);
  expect(logoBox).not.toBeNull();
  expect(toolbarBox).not.toBeNull();
  if (!logoBox || !toolbarBox) throw new Error("Expected logo and toolbar layout boxes");
  expect(toolbarBox.y).toBeGreaterThanOrEqual(logoBox.y + logoBox.height);

  await bold.click();
  await expect(bold).toHaveAttribute("aria-pressed", "true");
});

test("mobile review decisions remain unobscured by the fixed voice entry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await addVisibleSuggestion(page);

  const review = page.locator("top-writer-agent-review-bar");
  const rail = page.getByRole("button", { name: "语音副驾" });
  const accept = page.getByRole("button", { name: "Accept suggestion" });
  const reject = page.getByRole("button", { name: "Reject all suggestions" });
  await expect(review).toBeVisible();
  await expect(accept).toBeVisible();
  await expect(reject).toBeVisible();

  const [railBox, acceptBox, rejectBox] = await Promise.all([
    rail.boundingBox(),
    accept.boundingBox(),
    reject.boundingBox(),
  ]);
  expect(railBox).not.toBeNull();
  expect(acceptBox).not.toBeNull();
  expect(rejectBox).not.toBeNull();
  for (const actionBox of [acceptBox, rejectBox]) {
    const overlaps = Boolean(
      railBox && actionBox &&
        railBox.x < actionBox.x + actionBox.width &&
        railBox.x + railBox.width > actionBox.x &&
        railBox.y < actionBox.y + actionBox.height &&
        railBox.y + railBox.height > actionBox.y,
    );
    expect(overlaps).toBe(false);
  }

  await accept.click();
  await expect(page.getByText("Suggestion 1 of 1")).toBeVisible();
  await reject.click();
  await expect(page.getByText("Suggestion 0 of 0")).toBeVisible();
});
