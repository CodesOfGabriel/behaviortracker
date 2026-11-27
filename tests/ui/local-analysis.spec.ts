import { test, expect, openExperiment } from "./desktop";

test("confirmation is visible and clickable with execution history collapsed", async ({ page }) => {
  await openExperiment(page);
  const history = page.locator(".analysis-settings");
  await expect(history).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Analisar", exact: true }).click();
  const modal = page.locator("dialog.local-analysis-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAccessibleName("Analisar na máquina local");
  // Closing the backdrop must work even with all configuration controls gone.
  await page.mouse.click(10, 10);
  await expect(modal).not.toBeVisible();
  await page.getByRole("tab", { name: "Resumo", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Resumo", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("Escape restores focus and repeated opening never leaves the page inert", async ({ page }) => {
  await openExperiment(page);
  const analyze = page.getByRole("button", { name: "Analisar", exact: true });
  const modal = page.getByRole("dialog", { name: "Analisar na máquina local" });
  for (let i = 0; i < 3; i++) {
    await analyze.click();
    await expect(modal).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible();
    await expect(analyze).toBeFocused();
  }
  await page.getByRole("tab", { name: "Vídeo", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Vídeo", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => window.__desktopTest.calls.filter(c => c.command === "start_local_tracking"))).toHaveLength(0);
});

for (const viewport of [{ width: 980, height: 620 }, { width: 1440, height: 900 }]) {
  test(`simple analysis action remains reachable at ${viewport.width} × ${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openExperiment(page);
    await page.getByRole("button", { name: "Analisar", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Analisar na máquina local" });
    await expect(modal.getByRole("button")).toHaveCount(1);
    await expect(modal.getByRole("button", { name: "Analisar", exact: true })).toBeInViewport();
    await expect(modal.getByRole("combobox")).toHaveCount(0);
    await expect(modal.getByRole("checkbox")).toHaveCount(0);
    await expect(modal.locator("p, details, input")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Resumo", exact: true }).click();
  });
}

for (const scenario of ["model-slow", "model-error"] as const) {
  test(`optional behavior model ${scenario} cannot block opening or cancellation`, async ({ page }) => {
    await openExperiment(page, scenario);
    await page.getByRole("button", { name: "Analisar", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Analisar na máquina local" });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("button", { name: "Analisar", exact: true })).toBeEnabled();
    await expect(modal.getByRole("checkbox")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Resumo", exact: true }).click();
  });
}

for (const scenario of ["stage-error", "start-error"] as const) {
  test(`${scenario} is visible and allows correcting configuration and retrying`, async ({ page }) => {
    await openExperiment(page, scenario);
    await page.getByRole("button", { name: "Analisar", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Analisar na máquina local" });
    await modal.getByRole("button", { name: "Analisar", exact: true }).click();
    await expect(modal).not.toBeVisible();
    await expect(page.locator(".workflow-current-error")).toContainText("Falha de teste");
    await expect(page.getByRole("button", { name: "Analisar", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Analisar", exact: true }).click();
    await page.keyboard.press("Escape");
    const starts = await page.evaluate(() => window.__desktopTest.calls.filter(c => c.command === "start_local_tracking"));
    expect(starts).toHaveLength(scenario === "stage-error" ? 0 : 1);
  });
}

test("one confirmation starts one job with the default original-video configuration", async ({ page }) => {
  await openExperiment(page);
  await page.getByRole("button", { name: "Analisar", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Analisar na máquina local" });
  await modal.getByRole("button", { name: "Analisar", exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Analisar", exact: true })).toBeDisabled();
  await expect(page.getByRole("switch")).toBeDisabled();
  const starts = await page.evaluate(() => window.__desktopTest.calls.filter(c => c.command === "start_local_tracking"));
  expect(starts).toHaveLength(1);
  expect(starts[0].args).toMatchObject({ experimentId: "ui-open-field", uploadId: "original-01", optimizeVideo: false,
    expectedVideoSha256: "a".repeat(64), config: { protocol: "open_field", strategy: "classical_roi_v1", maxWidth: 640, useOpenCL: false, referenceApproved: false } });
});

test("active jobs disable starting and changing the processing engine", async ({ page }) => {
  await openExperiment(page, "running");
  await expect(page.getByRole("button", { name: "Analisar", exact: true })).toBeDisabled();
  await expect(page.getByRole("switch")).toBeDisabled();
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  await page.getByRole("tab", { name: "Resumo", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Resumo", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("cancelling an active job restores the ability to configure a new analysis", async ({ page }) => {
  await openExperiment(page, "running");
  await page.getByText("Configuração e histórico de execuções", { exact: true }).click();
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Analisar", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Analisar", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Analisar na máquina local" });
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => window.__desktopTest.calls.filter(c => c.command === "cancel_local_tracking"))).toHaveLength(1);
});

test("a cancellation failure is visible and cannot falsely unlock a still-running job", async ({ page }) => {
  await openExperiment(page, "cancel-error");
  await page.getByText("Configuração e histórico de execuções", { exact: true }).click();
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Falha de teste ao cancelar");
  await expect(page.getByRole("button", { name: "Analisar", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "Resumo", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Resumo", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("Colab remains independently selectable after closing the local modal", async ({ page }) => {
  await openExperiment(page);
  await page.getByRole("button", { name: "Analisar", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.locator(".analysis-engine-switch").click();
  await expect(page.getByRole("switch")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Analisar", exact: true })).toBeEnabled();
  await page.getByRole("switch").press("Space");
  await page.getByRole("button", { name: "Analisar", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Analisar na máquina local" })).toBeVisible();
});
