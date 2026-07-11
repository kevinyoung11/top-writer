import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

type VoiceViewport = {
  name: string;
  width: number;
  height: number;
};

const viewports: VoiceViewport[] = [
  { name: "desktop right drawer", width: 1280, height: 900 },
  { name: "tablet right overlay", width: 1024, height: 900 },
  { name: "mobile bottom drawer", width: 390, height: 844 },
  { name: "narrow reflow", width: 640, height: 844 },
];

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

async function expectWithinViewport(page: Page, selector: string) {
  const rect = await page.locator(selector).evaluate((element) => {
    const { bottom, left, right, top } = element.getBoundingClientRect();
    return { bottom, left, right, top };
  });

  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  expect(rect.bottom).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
}

async function expectNoSeriousAxeViolations(
  page: Page,
  scopes: string[][],
) {
  const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
  for (const scope of scopes) builder.include(scope);
  const results = await builder.analyze();
  const blocking = results.violations.filter(({ impact }) =>
    impact === "serious" || impact === "critical",
  );
  expect(blocking).toEqual([]);
}

for (const viewport of viewports) {
  test(`${viewport.name} keeps the voice drawer accessible and in view`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");

    const entry = page.getByRole("button", { name: "语音副驾" });
    const player = page.getByRole("region", { name: "朗读控制" });
    await expect(entry).toBeVisible();
    await expect(player).toBeVisible();
    await expect(page.getByRole("dialog", { name: "语音副驾" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousAxeViolations(page, [
      ["wordflow-wordflow", "[data-voice-entry]"],
      ["wordflow-wordflow", "top-writer-voice-player"],
    ]);

    await entry.focus();
    await page.keyboard.press("Enter");

    const drawer = page.getByRole("dialog", { name: "语音副驾" });
    await expect(drawer).toBeVisible();
    await expect(page.getByRole("textbox", { name: "文字指令" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "语音副驾" })).toBeFocused();
    await expect(player).toBeVisible();
    await expect(page.getByRole("button", { name: "朗读当前段落" })).toBeVisible();
    await expectWithinViewport(page, "#voice-copilot-drawer");
    await expectWithinViewport(page, ".editor-content");
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousAxeViolations(page, [
      ["wordflow-wordflow", "#voice-copilot-drawer"],
    ]);

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(entry).toBeFocused();

    await entry.click();
    await page.getByRole("button", { name: "关闭语音副驾" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(entry).toBeFocused();
  });
}

test("mobile bottom drawer closes from its backdrop while the player remains reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.getByRole("button", { name: "语音副驾" }).click();
  await expect(page.getByRole("dialog", { name: "语音副驾" })).toBeVisible();
  await expect(page.getByRole("region", { name: "朗读控制" })).toBeVisible();

  await page.locator(".voice-drawer-backdrop").click({ position: { x: 1, y: 1 } });
  await expect(page.getByRole("dialog", { name: "语音副驾" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "朗读控制" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("documents the full-page serious and critical Axe baseline", async ({ page }) => {
  await page.goto("/");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const baseline = results.violations
    .filter(({ impact }) => impact === "serious" || impact === "critical")
    .map(({ id }) => id)
    .sort();

  // This is an unscoped inventory of pre-existing page violations. Voice drawer
  // tests above use explicit shadow-DOM scope and must stay clear of this list.
  expect(baseline).toEqual([
    "aria-input-field-name",
    "aria-tooltip-name",
    "button-name",
    "color-contrast",
    "select-name",
  ]);
});
