import { describe, expect, it } from "vitest";
import type { ArmId, RadialMazeGeometry, RamVisitPolicy } from "../../types";
import { crossesGate, newGeometryRevision, pointInAnalyzableCup, validateRadialArea, validateRadialCup, validateRadialCups, validateRadialGates, validateRadialGeometry, validateRadialRewards, spatialRegion, walkableMaskVersion } from "./geometry";
import { detectRamChoices, type RamFrame } from "./events";
import { calculateRamMetrics } from "./metrics";
import { migrateExperiment } from "../../store/AppStore";
import type { RadialMazeExperiment } from "../../types";

const square = (x: number, y: number, size: number) => [
  { x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size },
];
const geometry: RadialMazeGeometry = { revision: 1, referenceFrameSec: 0, walkableMaskVersion: "test",
  centerPolygonPx: square(400, 400, 100),
  arms: Array.from({ length: 8 }, (_, index) => {
    const id = (index + 1) as ArmId;
    const x = 40 + index * 110;
    return { id, polygonPx: square(x, 100, 80), cupPolygonPx: square(x + 25, 125, 20),
      entryGatePx: [{ x: x + 5, y: 165 }, { x: x + 75, y: 165 }] as [{ x: number; y: number }, { x: number; y: number }],
      distalGatePx: [{ x: x + 5, y: 150 }, { x: x + 75, y: 150 }] as [{ x: number; y: number }, { x: number; y: number }],
      baited: [1, 3, 5, 7].includes(id) };
  }) };
const policy: RamVisitPolicy = { minimumArmDwellSec: 0.1, minimumCenterDwellSec: 0.1,
  minimumDistalDwellSec: 0.1, unknownGapToleranceSec: 0, choiceCriterion: "arm_entry" };
const frame = (frameIndex: number, timestampSec: number, x: number | null, y = 450): RamFrame => ({ frameIndex, timestampSec,
  center: x === null ? null : { x, y }, identity: x === null ? "uncertain" : "confirmed", source: x === null ? "missing" : "manual" });

describe("RAM isolado por protocolo", () => {
  it("exige oito braços, potes internos, linhas válidas e quatro recompensas", () => {
    expect(validateRadialGeometry(geometry, 1000, 1000)).toBeNull();
    expect(validateRadialGeometry({ ...geometry, arms: geometry.arms.slice(1) }, 1000, 1000)).toMatch(/exatamente/);
    expect(validateRadialGeometry({ ...geometry, arms: geometry.arms.map(a => ({ ...a, baited: false })) }, 1000, 1000)).toMatch(/quatro/);
    expect(validateRadialGeometry({ ...geometry, arms: geometry.arms.map(a => a.id === 1 ? { ...a, cupPolygonPx: square(900, 900, 20) } : a) }, 1000, 1000)).toMatch(/P1/);
    expect(validateRadialGeometry({ ...geometry, arms: geometry.arms.map(a => a.id === 2 ? { ...geometry.arms[0], id: 2, baited: false } : a) }, 1000, 1000)).toMatch(/sobrepõem/);
    expect(spatialRegion({ x: 445, y: 445 }, geometry)).toBe("CENTER");
    expect(spatialRegion({ x: 70, y: 135 }, geometry)).toBe("DISTAL_1");
    expect(crossesGate({ x: 10, y: 10 }, { x: 30, y: 10 }, [{ x: 20, y: 0 }, { x: 20, y: 20 }])).toBe(true);
    expect(crossesGate({ x: 10, y: 30 }, { x: 30, y: 30 }, [{ x: 20, y: 0 }, { x: 20, y: 20 }])).toBe(false);
  });

  it("valida a área antes de exigir potes, recompensas e linhas", () => {
    const onlyArea = { ...geometry, arms: geometry.arms.map(arm => ({ ...arm, cupPolygonPx: [],
      entryGatePx: [{ x: 0, y: 0 }, { x: 0, y: 0 }] as [typeof arm.entryGatePx[0], typeof arm.entryGatePx[1]],
      distalGatePx: [{ x: 0, y: 0 }, { x: 0, y: 0 }] as [typeof arm.distalGatePx[0], typeof arm.distalGatePx[1]], baited: false })) };
    expect(validateRadialArea(onlyArea, 1000, 1000)).toBeNull();
    expect(validateRadialCups(onlyArea, 1000, 1000)).toMatch(/P1/);
    const withCups = { ...onlyArea, arms: onlyArea.arms.map((arm, index) => ({ ...arm, cupPolygonPx: geometry.arms[index].cupPolygonPx })) };
    expect(validateRadialCups(withCups, 1000, 1000)).toBeNull();
    expect(validateRadialRewards(withCups)).toMatch(/quatro/);
    expect(validateRadialGates({ ...withCups, arms: withCups.arms.map((arm, index) => ({ ...arm, baited: geometry.arms[index].baited })) })).toMatch(/B1/);
  });

  it("salva uma área única sem inferir braços ou eventos", async () => {
    const singleArea: RadialMazeGeometry = { ...geometry, walkablePolygonPx: square(20, 80, 900), centerPolygonPx: [],
      arms: geometry.arms.map(arm => ({ ...arm, polygonPx: [], entryGatePx: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
        distalGatePx: [{ x: 0, y: 0 }, { x: 0, y: 0 }] })) };
    expect(validateRadialGeometry(singleArea, 1000, 1000)).toBeNull();
    expect(spatialRegion({ x: 75, y: 135 }, singleArea)).toBe("UNKNOWN");
    expect(() => detectRamChoices([frame(0, 0, 450), frame(1, 0.2, 75, 135)], singleArea, policy)).toThrow(/exigem limites/);
    expect(await walkableMaskVersion(singleArea)).toMatch(/^ram-walkable-polygon-1:[0-9a-f]{64}$/);
    expect(validateRadialGeometry({ ...singleArea, arms: singleArea.arms.map(arm => arm.id === 1
      ? { ...arm, cupPolygonPx: square(950, 900, 20) } : arm) }, 1000, 1000)).toMatch(/P1/);
    expect(validateRadialCup(singleArea, 1, 1000, 1000)).toBeNull();
    const cupOutsideArea = { ...singleArea, arms: singleArea.arms.map(arm => arm.id === 8
      ? { ...arm, cupPolygonPx: square(950, 900, 20) } : arm) };
    expect(validateRadialCup(cupOutsideArea, 8, 1000, 1000)).toMatch(/P8/);
    const partlyOutsideArea = { ...singleArea, arms: singleArea.arms.map(arm => arm.id === 8
      ? { ...arm, cupPolygonPx: square(910, 900, 20) } : arm) };
    expect(validateRadialCup(partlyOutsideArea, 8, 1000, 1000)).toBeNull();
    expect(validateRadialGeometry(partlyOutsideArea, 1000, 1000)).toBeNull();
    expect(pointInAnalyzableCup({ x: 915, y: 910 }, partlyOutsideArea, 8)).toBe(true);
    expect(pointInAnalyzableCup({ x: 925, y: 910 }, partlyOutsideArea, 8)).toBe(false);
    const touchesBorderOnly = { ...singleArea, arms: singleArea.arms.map(arm => arm.id === 8
      ? { ...arm, cupPolygonPx: square(920, 900, 20) } : arm) };
    expect(validateRadialCup(touchesBorderOnly, 8, 1000, 1000)).toMatch(/P8/);
  });

  it("classifica escolhas conforme recompensa sem somar RWME duas vezes", () => {
    const armIds: ArmId[] = [1, 2, 1, 3, 2, 5, 7];
    const choices = armIds.map((armId, i) => ({ armId, frameIndex: i, timestampSec: i + 1, distalReached: true, status: "confirmed" as const }));
    const result = calculateRamMetrics(choices, [1, 3, 5, 7]);
    expect(result.choices.map(c => c.classification)).toEqual(["CORRECT", "RME", "WME", "CORRECT", "RWME", "CORRECT", "CORRECT"]);
    expect([result.correct, result.rme, result.wme, result.rwme]).toEqual([4, 1, 1, 1]);
    expect(result.definitive).toBe(true);
  });

  it("retém incerteza de uma entrada que atravessa lacuna de identidade", () => {
    const observations = [frame(0, 0, 450), frame(1, 0.2, 450), frame(2, 0.3, null),
      frame(3, 0.4, 75, 130), frame(4, 0.6, 75, 130)];
    const choices = detectRamChoices(observations, geometry, policy);
    expect(choices).toHaveLength(1);
    expect(choices[0].status).toBe("pending");
    const metrics = calculateRamMetrics(choices, [1, 3, 5, 7]);
    expect(metrics.definitive).toBe(false);
    expect(metrics.correct).toBe(0);
    expect(metrics.firstChoiceLatencySec).toBeNull();
  });

  it("confirma visita somente após centro, cruzamento da linha e permanência", () => {
    const nearby = { ...geometry, arms: geometry.arms.map(arm => arm.id === 1 ? { ...arm,
      polygonPx: square(500, 420, 100), cupPolygonPx: square(570, 445, 20),
      entryGatePx: [{ x: 520, y: 425 }, { x: 520, y: 515 }] as [{ x: number; y: number }, { x: number; y: number }],
      distalGatePx: [{ x: 560, y: 425 }, { x: 560, y: 515 }] as [{ x: number; y: number }, { x: number; y: number }],
    } : arm) };
    const frames = [frame(0, 0, 450), frame(1, 0.2, 450), frame(2, 0.3, 510), frame(3, 0.5, 540)];
    const choices = detectRamChoices(frames, nearby, policy);
    expect(choices).toHaveLength(1);
    expect(choices[0].status).toBe("confirmed");
    expect(choices[0].timestampSec).toBe(0.3);
  });

  it("mantém escolhas posteriores pendentes quando a lacuna pode esconder visitas", () => {
    const nearby = { ...geometry, arms: geometry.arms.map(arm => arm.id === 1 ? { ...arm,
      polygonPx: square(500, 420, 100), cupPolygonPx: square(570, 445, 20),
      entryGatePx: [{ x: 520, y: 425 }, { x: 520, y: 515 }] as [typeof arm.entryGatePx[0], typeof arm.entryGatePx[1]],
      distalGatePx: [{ x: 560, y: 425 }, { x: 560, y: 515 }] as [typeof arm.distalGatePx[0], typeof arm.distalGatePx[1]],
    } : arm) };
    const frames = [frame(0,0,450),frame(1,.1,null),frame(2,.2,450),frame(3,.4,450),frame(4,.5,510),frame(5,.7,540)];
    const result=detectRamChoices(frames,nearby,policy);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("pending");
    expect(calculateRamMetrics(result,[1,3,5,7]).correct).toBe(0);
  });

  it("não trata uma escolha posterior no mesmo braço incerto como revisita confirmada", () => {
    const choices = [
      { armId: 1 as ArmId, frameIndex: 10, timestampSec: 1, distalReached: false, status: "pending" as const },
      { armId: 1 as ArmId, frameIndex: 20, timestampSec: 2, distalReached: true, status: "confirmed" as const },
    ];
    const metrics = calculateRamMetrics(choices, [1, 3, 5, 7]);
    expect(metrics.choices.map(c => c.classification)).toEqual(["PENDING", "PENDING"]);
    expect(metrics.confirmedChoices).toBe(0);
  });

  it("carrega o contrato RAM sem migrá-lo como Campo Aberto", () => {
    const experiment: RadialMazeExperiment = { id: "ram", schemaVersion: "1.0", analysisMethodVersion: "ram-1.0",
      analysisEngine: "wistar_ram_hybrid_v1", modelBundleId: "wistar_df_v2", testType: "radial_arm_maze", status: "draft",
      title: "RAM", subjectId: "R1", createdAt: "now", updatedAt: "now", video: { filename: "sample.mov", sizeBytes: 1,
        width: 1000, height: 1000, durationSec: 10, fps: null, timingSource: "browser-estimate" },
      geometry, visitPolicy: policy, corrections: [] };
    const loaded = migrateExperiment(experiment);
    expect(loaded.testType).toBe("radial_arm_maze");
    if (loaded.testType === "radial_arm_maze") {
      expect(loaded.geometry).toEqual(geometry);
      expect(loaded.analysisMethodVersion).toBe("ram-1.0");
      expect("arena" in loaded).toBe(false);
      const revision = newGeometryRevision(loaded, { ...loaded.geometry, centerPolygonPx: square(410, 410, 90) });
      expect(revision.geometry.revision).toBe(2);
      expect(revision.geometryHistory).toEqual([loaded.geometry]);
      expect(revision.status).toBe("draft");
    }
  });
});
