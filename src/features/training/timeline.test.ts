import { describe, expect, it } from "vitest";
import { editRange, frameStep, snapTime, tickSpacing, timeAtClientX, timelineTime } from "./timeline";

describe("seleção direta de trechos na timeline", () => {
  it("mapeia o ponteiro dentro do conteúdo, inclusive com zoom e scroll", () => {
    expect(timeAtClientX(300, -100, 1000, 10)).toBe(4);
    expect(timeAtClientX(-200, -100, 1000, 10)).toBe(0);
    expect(timeAtClientX(1200, -100, 1000, 10)).toBe(10);
    expect(timeAtClientX(1, 0, 0, 10)).toBe(0);
  });
  it("permite desenhar de trás para frente sem inverter os limites", () => {
    expect(editRange({ startSec: 0, endSec: 0 }, "create", 6, 2, 10, 24)).toEqual({ startSec: 2, endSec: 6 });
  });
  it("cria no mínimo um frame e respeita o fim real do vídeo", () => {
    expect(editRange({ startSec: 0, endSec: 0 }, "create", 10, 10, 10, 24)).toEqual({ startSec: 10 - 1 / 24, endSec: 10 });
    expect(editRange({ startSec: 0, endSec: 0 }, "create", 0, 0, .01, 24)).toEqual({ startSec: 0, endSec: .01 });
  });
  it("move o trecho preservando a duração e sem sair do vídeo", () => {
    const range = { startSec: 2, endSec: 5 };
    expect(editRange(range, "move", 3, -10, 10, 24)).toEqual({ startSec: 0, endSec: 3 });
    expect(editRange(range, "move", 3, 20, 10, 24)).toEqual({ startSec: 7, endSec: 10 });
  });
  it("não deixa as alças se cruzarem ou criarem intervalos vazios", () => {
    const range = { startSec: 2, endSec: 5 };
    expect(editRange(range, "start", 2, 9, 10, 24)).toEqual({ startSec: 5 - 1 / 24, endSec: 5 });
    expect(editRange(range, "end", 5, -1, 10, 24)).toEqual({ startSec: 2, endSec: 2 + 1 / 24 });
  });
  it("alinha o ajuste ao fps, inclusive fracionário, com fallback seguro", () => {
    expect(snapTime(.51, 10, 24)).toBe(.5);
    expect(frameStep(Number.NaN)).toBe(1 / 30);
    expect(snapTime(20, 1.01, 29.97)).toBe(1.01);
  });
  it("mantém uma escala legível ao ampliar", () => {
    expect(tickSpacing(300)).toBe(50);
    expect(tickSpacing(1)).toBe(.2);
    expect(tickSpacing(.1)).toBe(.02);
  });
  it("mostra tempos sem campos numéricos e arredonda a virada do minuto", () => {
    expect(timelineTime(59.9999)).toBe("01:00.000");
    expect(timelineTime(90.125)).toBe("01:30.125");
  });
});
