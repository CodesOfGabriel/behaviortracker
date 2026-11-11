import { afterEach, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppStoreProvider } from "../../store/AppStore";
import { NewExperiment } from "./NewExperiment";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("abre a escolha do protocolo sem calcular os hashes dos checkpoints", () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  const html = renderToString(createElement(AppStoreProvider, null, createElement(NewExperiment)));
  expect(html).toContain("Selecione o protocolo");
  expect(html).toContain("Campo Aberto");
  expect(html).toContain("Nado Forçado");
  expect(html).toContain("disabled");
  expect(invoke).not.toHaveBeenCalled();
});
