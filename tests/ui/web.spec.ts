import { expect, test } from "@playwright/test";
import { publishedDesktopRelease } from "../fixtures/desktop-release";

const releaseApi = "https://api.github.com/repos/CodesOfGabriel/behaviortracker/releases/latest";
test.beforeEach(async ({ page }) => {
  await page.route(releaseApi, route => route.fulfill({ json: publishedDesktopRelease() }));
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`website downloads and institutional images work at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Software para pesquisa" })).toBeVisible();
    await expect(page.locator(".download-release")).toContainText("Instaladores: 9.8.7");
    const citation = page.getByRole("region", { name: "Publicação científica" });
    await expect(citation).toContainText("Versão científica arquivada: 0.1.7");
    await expect(citation).toContainText("Santos, Gabriel Silva; Vargas, Thiago Alves. (2026).");
    await expect(citation.getByRole("link", { name: "https://doi.org/10.5281/zenodo.24612625" })).toHaveAttribute("href", "https://doi.org/10.5281/zenodo.24612625");
    await expect(citation.locator("time")).toHaveAttribute("datetime", "2026-11-27");
    await expect(page.getByRole("link", { name: "Notas da versão" })).toHaveAttribute("href", "https://github.com/CodesOfGabriel/behaviortracker/releases/tag/v9.8.7");

    const checkInstaller = async (name: string, suffix: string) => {
      const link = page.getByRole("link", { name, exact: true });
      await expect(link).toBeVisible();
      const url = new URL((await link.getAttribute("href"))!);
      expect(url.origin).toBe("https://github.com");
      const match = url.pathname.match(/^\/CodesOfGabriel\/behaviortracker\/releases\/download\/(v\d+\.\d+\.\d+)\/BehaviorTracker-(v\d+\.\d+\.\d+)-(.+)$/);
      expect(match).not.toBeNull();
      expect(match![1]).toBe(match![2]);
      expect(match![1]).toBe("v9.8.7");
      expect(match![3]).toBe(suffix);
    };
    await checkInstaller("Baixar para macOS Apple Silicon", "macOS-Apple-Silicon.dmg");
    await page.getByRole("tab", { name: "Intel", exact: true }).click();
    await checkInstaller("Baixar para macOS Intel", "macOS-Intel.dmg");
    await page.getByRole("tab", { name: "Apple Silicon", exact: true }).click();
    await checkInstaller("Baixar para macOS Apple Silicon", "macOS-Apple-Silicon.dmg");
    await checkInstaller("Baixar para Windows x64", "Windows-x64.exe");
    await checkInstaller("Baixar para Linux x64 AppImage", "Linux-x64.AppImage");
    await checkInstaller("Baixar .deb", "Linux-x64.deb");

    const images = page.getByRole("group", { name: "Instituições" }).getByRole("img");
    await expect(images).toHaveCount(3);
    await expect.poll(() => images.evaluateAll(elements => elements.every(element => {
      const image = element as HTMLImageElement;
      return image.complete && image.naturalWidth > 0;
    }))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("browser login supports direct navigation, reload and returning to downloads", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL(/\/#\/login$/);
  await expect(page.getByRole("heading", { name: "Entre na sua conta" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Entrar com Google", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("O login Google está disponível no aplicativo desktop.");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Entre na sua conta" })).toBeVisible();
  await page.getByRole("link", { name: "Downloads", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Software para pesquisa" })).toBeVisible();
});

test("returning to the page refreshes the published version without rebuilding the website", async ({ page }) => {
  let version = "9.8.7";
  await page.unroute(releaseApi);
  await page.route(releaseApi, route => route.fulfill({ json: publishedDesktopRelease(version) }));
  await page.goto("/");
  await expect(page.locator(".download-release")).toContainText("Instaladores: 9.8.7");
  version = "9.8.8";
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".download-release")).toContainText("Instaladores: 9.8.8");
  await expect(page.getByRole("link", { name: "Notas da versão" })).toHaveAttribute("href", /\/tag\/v9\.8\.8$/);
  await expect(page.getByRole("link", { name: "Baixar para Windows x64" })).toHaveAttribute("href", /\/v9\.8\.8\/BehaviorTracker-v9\.8\.8-Windows-x64\.exe$/);
});

for (const scenario of ["unavailable", "incomplete"] as const) {
  test(`GitHub ${scenario} keeps verified downloads without claiming they are the latest`, async ({ page }) => {
    await page.unroute(releaseApi);
    await page.route(releaseApi, route => route.fulfill(scenario === "unavailable"
      ? { status: 403, json: { message: "API rate limit exceeded" } }
      : { json: { ...publishedDesktopRelease("0.1.7"), assets: [] } }));
    await page.goto("/");
    await expect(page.locator(".download-release")).toContainText("Últimos instaladores verificados: 0.1.6");
    await expect(page.getByRole("region", { name: "Publicação científica" })).toContainText("Versão científica arquivada: 0.1.7");
    await expect(page.getByRole("link", { name: "Baixar para Windows x64" })).toHaveAttribute("href", /\/v0\.1\.6\/BehaviorTracker-v0\.1\.6-Windows-x64\.exe$/);
    await page.getByRole("link", { name: "Entrar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Entre na sua conta" })).toBeVisible();
  });
}

test("website legal links serve the privacy and terms pages", async ({ page }) => {
  for (const [link, title, route] of [
    ["Privacidade", "Política de Privacidade", "/privacy/"],
    ["Termos de serviço", "Termos de Serviço", "/terms/"],
  ]) {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Documentos legais" }).getByRole("link", { name: link, exact: true }).click();
    expect(new URL(page.url()).pathname).toBe(route);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute("href", "/legal.css");
    const stylesheet = await page.request.get("/legal.css");
    expect(stylesheet.ok()).toBe(true);
    expect(stylesheet.headers()["content-type"]).toContain("text/css");
  }
});
