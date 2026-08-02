import { test, expect } from "@playwright/test";

test("voice-check autorun renders the health shell", async ({ page }) => {
  await page.goto("/voice-check?autorun=1");
  await expect(page.getByRole("heading", { name: /voice health/i })).toBeVisible();
  // Autorun waits for a tap on iOS; on desktop Chromium the page still paints the step rail.
  await expect(page.getByText(/microphone|mic|environment|api/i).first()).toBeVisible();
});
