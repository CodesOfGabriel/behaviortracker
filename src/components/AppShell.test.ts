import { expect, it } from "vitest";
import { experimentsSidebarRoute } from "./AppShell";

it("retoma a preparação do vídeo ao abrir Experimentos pela sidebar", () => {
  expect(experimentsSidebarRoute(true, [])).toEqual({ name: "new-experiment", resumePreparation: true });
  expect(experimentsSidebarRoute(true, ["analysis-1"])).toEqual({ name: "results", experimentId: "analysis-1" });
});

it("abre uma análise ativa quando não há vídeo em preparação", () => {
  expect(experimentsSidebarRoute(false, ["analysis-1"])).toEqual({ name: "results", experimentId: "analysis-1" });
});

it("abre a lista de experimentos quando não há processo ativo", () => {
  expect(experimentsSidebarRoute(false, [])).toEqual({ name: "dashboard" });
});
