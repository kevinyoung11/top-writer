import { expect, test } from "@playwright/test";

test("mounts accessible voice controls and preserves text-command fallback", async ({ page }) => {
  await page.goto("/");
  const voiceEntry = page.getByRole("button", { name: "语音副驾" });
  await expect(voiceEntry).toBeVisible();
  await expect(page.getByRole("dialog", { name: "语音副驾" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "朗读上一段" })).toBeVisible();
  await expect(page.getByRole("button", { name: "朗读下一段" })).toBeVisible();

  await voiceEntry.click();
  await expect(page.getByRole("dialog", { name: "语音副驾" })).toBeVisible();
  await expect(page.getByRole("region", { name: "语音副驾" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "文字指令" })).toBeVisible();

  await page.getByRole("button", { name: "开始语音指令" }).click();
  await expect(page.getByRole("dialog", { name: "语音隐私说明" })).toBeVisible();
  await expect(page.getByText("Top Writer 不保存原始音频")).toBeVisible();
});
