import type { ArmId, Point, RadialMazeExperiment, RadialMazeGeometry } from "../../types";

export const ARM_IDS: ArmId[] = [1, 2, 3, 4, 5, 6, 7, 8];

export async function walkableMaskVersion(geometry: RadialMazeGeometry): Promise<string> {
  const singleArea = geometry.walkablePolygonPx !== undefined;
  const encoded = new TextEncoder().encode(JSON.stringify(singleArea
    ? { walkablePolygonPx: geometry.walkablePolygonPx }
    : { centerPolygonPx: geometry.centerPolygonPx, arms: geometry.arms.map(arm => ({ id: arm.id, polygonPx: arm.polygonPx })) }));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return `${singleArea ? "ram-walkable-polygon-1" : "ram-polygon-mask-1"}:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function newGeometryRevision(current: RadialMazeExperiment, next: RadialMazeGeometry): Pick<RadialMazeExperiment, "geometry" | "geometryHistory" | "status" | "trackingSelection"> {
  return { geometry: { ...next, revision: current.geometry.revision + 1 },
    geometryHistory: [...(current.geometryHistory ?? []), current.geometry], status: "draft", trackingSelection: current.geometry.walkableMaskVersion === next.walkableMaskVersion ? current.trackingSelection : undefined };
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1e-7 && point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x)
      && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInAnalyzableCup(point: Point, geometry: RadialMazeGeometry, id: ArmId): boolean {
  const arm = geometry.arms.find(item => item.id === id);
  return !!arm && pointInPolygon(point, arm.cupPolygonPx)
    && pointInPolygon(point, geometry.walkablePolygonPx ?? arm.polygonPx);
}

function signedArea(polygon: Point[]): number {
  return polygon.reduce((sum, p, i) => {
    const next = polygon[(i + 1) % polygon.length];
    return sum + p.x * next.y - next.x * p.y;
  }, 0) / 2;
}

function properCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const turn = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0;
}

function overlaps(a: Point[], b: Point[]): boolean {
  const strictlyInside = (p: Point, polygon: Point[]) => pointInPolygon(p, polygon) && !polygon.some((q, i) => {
    const r = polygon[(i + 1) % polygon.length];
    return Math.abs((p.x - q.x) * (r.y - q.y) - (p.y - q.y) * (r.x - q.x)) < 1e-7
      && p.x >= Math.min(q.x, r.x) && p.x <= Math.max(q.x, r.x)
      && p.y >= Math.min(q.y, r.y) && p.y <= Math.max(q.y, r.y);
  });
  if (a.some(p => strictlyInside(p, b)) || b.some(p => strictlyInside(p, a))) return true;
  const center = (polygon: Point[]) => polygon.reduce((sum, p) => ({ x: sum.x + p.x / polygon.length, y: sum.y + p.y / polygon.length }), { x: 0, y: 0 });
  if (strictlyInside(center(a), b) || strictlyInside(center(b), a)) return true;
  return a.some((p, i) => b.some((q, j) => properCross(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length])));
}

function containedInPolygon(inner: Point[], outer: Point[]): boolean {
  return inner.every((point, index) => {
    const next = inner[(index + 1) % inner.length];
    const midpoint = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
    return pointInPolygon(point, outer) && pointInPolygon(midpoint, outer)
      && !outer.some((boundary, edge) => properCross(point, next, boundary, outer[(edge + 1) % outer.length]));
  });
}

function validPolygon(polygon: Point[], width: number, height: number): boolean {
  if (polygon.length < 3 || !polygon.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)
    && p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height) || Math.abs(signedArea(polygon)) < 10) return false;
  return !polygon.some((a, i) => polygon.some((b, j) =>
    Math.abs(i - j) > 1 && Math.abs(i - j) < polygon.length - 1
    && properCross(a, polygon[(i + 1) % polygon.length], b, polygon[(j + 1) % polygon.length])));
}

export function validateRadialArea(geometry: RadialMazeGeometry, width: number, height: number): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 80 || height < 80) return "Dimensões do vídeo inválidas.";
  if (!Number.isInteger(geometry.revision) || geometry.revision < 1 || !Number.isFinite(geometry.referenceFrameSec) || geometry.referenceFrameSec < 0) return "Revisão ou frame de referência inválido.";
  if (geometry.walkablePolygonPx !== undefined) {
    if (!validPolygon(geometry.walkablePolygonPx, width, height)) return "Contorne toda a área transitável do labirinto com um polígono válido.";
    return geometry.arms.length === 8 && ARM_IDS.every(id => geometry.arms.filter(arm => arm.id === id).length === 1)
      ? null : "Configure exatamente os potes P1 a P8.";
  }
  if (!validPolygon(geometry.centerPolygonPx, width, height)) return "Marque um polígono central válido dentro do vídeo.";
  if (geometry.arms.length !== 8 || ARM_IDS.some(id => geometry.arms.filter(arm => arm.id === id).length !== 1)) return "Configure exatamente os braços B1 a B8.";
  for (const arm of geometry.arms) {
    if (!validPolygon(arm.polygonPx, width, height)) return `B${arm.id}: polígono inválido.`;
    if (overlaps(geometry.centerPolygonPx, arm.polygonPx)) return `B${arm.id}: sobreposição com a plataforma central.`;
  }
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
    if (overlaps(geometry.arms[i].polygonPx, geometry.arms[j].polygonPx)) return `B${geometry.arms[i].id} e B${geometry.arms[j].id} se sobrepõem.`;
  }
  return null;
}

export function validateRadialCups(geometry: RadialMazeGeometry, width: number, height: number): string | null {
  const areaError = validateRadialArea(geometry, width, height);
  if (areaError) return areaError;
  for (const arm of geometry.arms) {
    const cupError = validateRadialCup(geometry, arm.id, width, height);
    if (cupError) return cupError;
  }
  return null;
}

export function validateRadialCup(geometry: RadialMazeGeometry, id: ArmId, width: number, height: number): string | null {
  const arm = geometry.arms.find(item => item.id === id);
  if (!arm || !validPolygon(arm.cupPolygonPx, width, height)
    || (geometry.walkablePolygonPx
      ? !overlaps(arm.cupPolygonPx, geometry.walkablePolygonPx)
      : !containedInPolygon(arm.cupPolygonPx, arm.polygonPx)))
    return `P${id}: o quadrado deve ter alguma área sobre o labirinto.`;
  return null;
}

export function validateRadialRewards(geometry: RadialMazeGeometry): string | null {
  return geometry.arms.filter(arm => arm.baited).length === 4 ? null : "Selecione exatamente quatro potes com recompensa.";
}

export function validateRadialGates(geometry: RadialMazeGeometry): string | null {
  for (const arm of geometry.arms) {
    if (arm.entryGatePx.length !== 2 || arm.distalGatePx.length !== 2) return `B${arm.id}: marque duas linhas com dois pontos cada.`;
    if (![...arm.entryGatePx, ...arm.distalGatePx].every(p => pointInPolygon(p, arm.polygonPx))
      || arm.entryGatePx[0].x === arm.entryGatePx[1].x && arm.entryGatePx[0].y === arm.entryGatePx[1].y
      || arm.distalGatePx[0].x === arm.distalGatePx[1].x && arm.distalGatePx[0].y === arm.distalGatePx[1].y) return `B${arm.id}: linhas de entrada e distal precisam ter dois pontos distintos no braço.`;
    const average = (points: Point[]) => points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length }), { x: 0, y: 0 });
    const center = average(geometry.centerPolygonPx), entry = average(arm.entryGatePx), distal = average(arm.distalGatePx), cup = average(arm.cupPolygonPx);
    const squaredDistance = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    const [a, b] = arm.distalGatePx;
    const side = (p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (squaredDistance(center, entry) >= squaredDistance(center, distal)
      || squaredDistance(cup, distal) >= squaredDistance(cup, entry)
      || side(entry) * side(cup) >= 0) return `B${arm.id}: a linha de entrada deve ser proximal e a distal deve separar o pote da entrada.`;
  }
  return null;
}

export function validateRadialGeometry(geometry: RadialMazeGeometry, width: number, height: number): string | null {
  return validateRadialCups(geometry, width, height) || validateRadialRewards(geometry)
    || (geometry.walkablePolygonPx === undefined ? validateRadialGates(geometry) : null);
}

export function spatialRegion(point: Point | null, geometry: RadialMazeGeometry): "CENTER" | `ARM_${ArmId}` | `DISTAL_${ArmId}` | "UNKNOWN" {
  if (!point) return "UNKNOWN";
  if (geometry.walkablePolygonPx && (!geometry.eventGeometryConfirmed || !pointInPolygon(point, geometry.walkablePolygonPx))) return "UNKNOWN";
  if (pointInPolygon(point, geometry.centerPolygonPx)) return "CENTER";
  const arm = geometry.arms.find(item => pointInPolygon(point, item.polygonPx));
  if (!arm) return "UNKNOWN";
  const [a, b] = arm.distalGatePx;
  const side = (p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const cup = arm.cupPolygonPx.reduce((sum, p) => ({ x: sum.x + p.x / arm.cupPolygonPx.length, y: sum.y + p.y / arm.cupPolygonPx.length }), { x: 0, y: 0 });
  return side(point) * side(cup) > 0 || pointInAnalyzableCup(point, geometry, arm.id) ? `DISTAL_${arm.id}` : `ARM_${arm.id}`;
}

export function crossesGate(from: Point, to: Point, gate: [Point, Point]): boolean {
  const [a, b] = gate;
  const dx = to.x - from.x, dy = to.y - from.y;
  const gx = b.x - a.x, gy = b.y - a.y;
  const determinant = dx * gy - dy * gx;
  if (Math.abs(determinant) < 1e-9) return false;
  const ax = a.x - from.x, ay = a.y - from.y;
  const alongMovement = (ax * gy - ay * gx) / determinant;
  const alongGate = (ax * dy - ay * dx) / determinant;
  return alongMovement >= 0 && alongMovement <= 1 && alongGate >= 0 && alongGate <= 1;
}

// The spatial mask and event references are separate contracts.
export function validateRamEventGeometry(geometry: RadialMazeGeometry, width: number, height: number, requireConfirmation = true): string | null {
  const events = { ...geometry, walkablePolygonPx: undefined };
  const error = validateRadialArea(events, width, height) || validateRadialCups(geometry, width, height)
    || validateRadialRewards(geometry) || validateRadialGates(events);
  if (error) return error;
  if (geometry.arms.some(a => !overlaps(a.cupPolygonPx, a.polygonPx))) return "Cada pote precisa se sobrepor ao braço correspondente.";
  if (geometry.walkablePolygonPx && [geometry.centerPolygonPx, ...geometry.arms.map(a => a.polygonPx)]
    .some(polygon => !containedInPolygon(polygon, geometry.walkablePolygonPx!))) return "As regiões precisam estar dentro da área transitável.";
  if (requireConfirmation && geometry.walkablePolygonPx && !geometry.eventGeometryConfirmed) return "Confirme as referências dos oito braços.";
  return null;
}
