// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { About } from "./About";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../colab/connection", () => ({ isTauriRuntime: () => true }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("keeps the archived citation independent of the running app and available installers", async () => {
  vi.mocked(invoke).mockResolvedValue({ app_version: "9.9.0" });
  render(<About />);
  expect(await screen.findByText("9.9.0")).toBeTruthy();
  const citation = screen.getByRole("region", { name: "Publicação científica" });
  expect(citation.textContent).toContain("Versão científica arquivada: 0.1.7");
  expect(citation.textContent).toContain("Santos, Gabriel Silva; Vargas, Thiago Alves. (2026).");
  expect(citation.querySelector("time")?.dateTime).toBe("2026-11-27");
  expect(within(citation).getByRole("link", { name: "https://doi.org/10.5281/zenodo.24612625" }).getAttribute("href"))
    .toBe("https://doi.org/10.5281/zenodo.24612625");
  expect(screen.getByRole("link", { name: "0.1.6" }).getAttribute("href"))
    .toBe("https://github.com/CodesOfGabriel/behaviortracker/releases/tag/v0.1.6");
});
