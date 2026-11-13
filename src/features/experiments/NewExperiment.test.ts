import { afterEach, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppStoreProvider } from "../../store/AppStore";
import { NewExperiment } from "./NewExperiment";
import { ForcedSwimExperimentWizard } from "./ForcedSwimExperimentWizard";
import { OpenFieldExperimentWizard } from "./OpenFieldExperimentWizard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("mantém wizards de geometria independentes", () => {
  const fst = renderToString(createElement(AppStoreProvider, null, createElement(ForcedSwimExperimentWizard, { onBack: () => {} })));
  const oft = renderToString(createElement(AppStoreProvider, null, createElement(OpenFieldExperimentWizard, { onBack: () => {} })));
  expect(fst).toContain("Cilindros");
  expect(fst).not.toContain("Sujeitos no mesmo vídeo");
  expect(fst).not.toContain("Calibração espacial");
  expect(oft).toContain("Arena");
  expect(oft).toContain("Calibração espacial");
});

it("oferece ambos os protocolos sem carregar modelos na seleção", () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  const html = renderToString(createElement(AppStoreProvider, null, createElement(NewExperiment)));
  expect(html).toContain("Selecione o protocolo");
  expect(html).toContain("Campo Aberto");
  expect(html).toContain("Nado Forçado");
  expect(html).toContain("protocol-option-forced-swim");
  expect(html).not.toContain("protocol-option-disabled");
  expect(invoke).not.toHaveBeenCalled();
});
