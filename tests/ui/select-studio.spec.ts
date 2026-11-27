import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, openExperiment } from "./desktop";

test("playback selector works inside the annotation dialog without firing annotation shortcuts", async ({ page }, testInfo) => {
  await openExperiment(page);
  await page.getByRole("tab", { name: "Rearing", exact: true }).click();
  await page.getByRole("button", { name: "Abrir estúdio de anotação" }).click();
  const studio = page.getByRole("dialog", { name: "Estúdio de rearing", exact: true });
  // The studio opens on proposals. Exercise the manual form explicitly so
  // this test still proves that selector keystrokes cannot change its label.
  await studio.getByRole("tab", { name: "Anotação", exact: true }).click();
  const speed = studio.getByRole("combobox", { name: "Velocidade de reprodução" });
  await speed.click();
  const menu = page.getByRole("listbox");
  await expect(menu).toBeVisible();
  const directory = resolve("artifacts/ui-selects-gpu-fallback-2026-11-26");
  mkdirSync(directory, { recursive: true });
  await expect(page.getByRole("option", { name: "0,25×", exact: true })).toBeInViewport();
  await page.screenshot({ path: resolve(directory, `menu-${testInfo.project.name}.png`) });
  await page.getByRole("option", { name: "0,25×", exact: true }).click();
  await expect(speed).toHaveText("0,25×");
  expect(await studio.locator("video").evaluate(video => (video as HTMLVideoElement).playbackRate)).toBe(.25);
  await speed.press("2");
  await expect(studio.getByRole("radio", { checked: true })).toHaveValue("REARING_UNSPECIFIED");
  await speed.press("r");
  await expect(studio.getByRole("button", { name: /^Ápice em/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(studio).not.toBeVisible();
});
