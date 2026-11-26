import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, openExperiment } from "./desktop";

test("application forms use the shared select instead of platform menus", async () => {
  function audit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) audit(path);
      else if (path.endsWith(".tsx") && !path.endsWith(".test.tsx")) {
        expect(readFileSync(path, "utf8"), path).not.toMatch(/<(select|datalist)\b/);
      }
    }
  }
  audit(resolve("src"));
});

for (const viewport of [{ width: 980, height: 620 }, { width: 1440, height: 900 }]) {
  test(`empty cards keep text and actions inset at ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openExperiment(page, "empty", []);
    await page.getByRole("tab", { name: "Detalhes", exact: true }).click();
    const card = page.locator(".results-empty-state");
    await expect(card).toBeVisible();
    const spacing = await card.evaluate(element => {
      const outer = element.getBoundingClientRect();
      const text = element.querySelector("p")!.getBoundingClientRect();
      const button = element.querySelector("button")!.getBoundingClientRect();
      return { left: text.left - outer.left, top: text.top - outer.top,
        bottom: outer.bottom - button.bottom, gap: button.top - text.bottom,
        right: outer.right - button.right };
    });
    expect(spacing.left).toBeGreaterThanOrEqual(16);
    expect(spacing.top).toBeGreaterThanOrEqual(16);
    expect(spacing.bottom).toBeGreaterThanOrEqual(16);
    expect(spacing.right).toBeGreaterThanOrEqual(16);
    expect(spacing.gap).toBeGreaterThanOrEqual(12);
    const directory = resolve("artifacts/ui-selects-gpu-fallback-2026-11-26");
    mkdirSync(directory, { recursive: true });
    await card.screenshot({ path: resolve(directory, `empty-${testInfo.project.name}-${viewport.width}.png`) });
    await card.getByRole("button", { name: "Abrir análise" }).click();
    await expect(page.getByRole("tab", { name: "Análise", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Rearing", exact: true }).click();
    const tracking = page.getByRole("combobox", { name: "Tracking usado na análise comportamental" });
    await expect(tracking).toBeDisabled();
    await expect(tracking).toContainText("Selecione um tracking OpenCV concluído");
    await page.getByRole("region", { name: "Rearing no campo aberto" }).screenshot({ path: resolve(directory, `rearing-${testInfo.project.name}-${viewport.width}.png`) });
  });
}

test("select in a native modal supports keyboard, Escape and focus restoration", async ({ page }) => {
  await openExperiment(page);
  await page.getByRole("button", { name: "Analisar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Analisar na máquina local" });
  const width = dialog.getByRole("combobox", { name: "Largura de processamento", exact: true });
  await width.focus();
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(width).toBeFocused();
  await width.click();
  await dialog.getByRole("option", { name: "480 px", exact: true }).click();
  await expect(width).toHaveText("480 px");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Analisar", exact: true })).toBeFocused();
});
