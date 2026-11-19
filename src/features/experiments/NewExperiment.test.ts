import { afterEach, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppStoreProvider } from "../../store/AppStore";
import { NewExperiment } from "./NewExperiment";
import { ForcedSwimExperimentWizard } from "./ForcedSwimExperimentWizard";
import { OpenFieldExperimentWizard } from "./OpenFieldExperimentWizard";
import { RadialArmMazeExperimentWizard } from "./RadialArmMazeExperimentWizard";
import type { RadialMazeExperiment } from "../../types";

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
  const ram = renderToString(createElement(AppStoreProvider, null, createElement(RadialArmMazeExperimentWizard, { onBack: () => {} })));
  expect(ram).toContain("Labirinto Radial");
  expect(ram).not.toContain("Cilindros e animais");
});

it("oferece os protocolos sem carregar modelos na seleção", () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  const html = renderToString(createElement(AppStoreProvider, null, createElement(NewExperiment)));
  expect(html).toContain("Selecione o protocolo");
  expect(html).toContain("Campo Aberto");
  expect(html).toContain("Nado Forçado");
  expect(html).toContain("Labirinto Radial");
  expect(html).toContain("protocol-option-forced-swim");
  expect(html).not.toContain("protocol-option-disabled");
  expect(invoke).not.toHaveBeenCalled();
});

it("edita a preparação RAM com um único contorno antes dos potes", () => {
  const existing: RadialMazeExperiment = {
    id: "ram", schemaVersion: "1.0", analysisMethodVersion: "ram-1.0", analysisEngine: "wistar_ram_hybrid_v1",
    modelBundleId: "wistar_df_v2", testType: "radial_arm_maze", status: "draft", title: "Sessão",
    subjectId: "R1", createdAt: "now", updatedAt: "now", corrections: [],
    video: { filename: "video.mov", sizeBytes: 100, width: 1000, height: 1000, durationSec: 10, fps: null, timingSource: "browser-estimate" },
    geometry: { revision: 1, centerPolygonPx: [], arms: Array.from({ length: 8 }, (_, index) => ({
      id: (index + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, polygonPx: [], cupPolygonPx: [],
      entryGatePx: [{ x: 0, y: 0 }, { x: 0, y: 0 }], distalGatePx: [{ x: 0, y: 0 }, { x: 0, y: 0 }], baited: false,
    })), walkableMaskVersion: "ram-polygon-mask-1", referenceFrameSec: 0 },
    visitPolicy: { minimumArmDwellSec: 0.25, minimumCenterDwellSec: 0.25, minimumDistalDwellSec: 0.25,
      unknownGapToleranceSec: 0, choiceCriterion: "arm_entry" },
  };
  const html = renderToString(createElement(AppStoreProvider, null, createElement(RadialArmMazeExperimentWizard, { existing, onBack: () => {} })));
  expect(html).toContain("Toda a área do labirinto");
  expect(html).toContain("fase <!-- -->1<!-- --> de 3");
  expect(html).not.toContain("Braço B1");
  expect(html).not.toContain("Linha de entrada B1");
});
