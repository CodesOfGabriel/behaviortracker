import type { ArenaConfig, Point } from "../types";

export type Matrix3 = [number, number, number, number, number, number, number, number, number];

const EPSILON = 1e-9;

function cross(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point) {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return abC * abD < 0 && cdA * cdB < 0;
}

export function polygonArea(points: Point[]) {
  return Math.abs(
    points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2,
  );
}

export function validateArenaCorners(corners: Point[]) {
  if (corners.length !== 4) return "Marque exatamente quatro vértices.";
  if (corners.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return "Os vértices precisam ter coordenadas finitas.";
  if (segmentsIntersect(corners[0], corners[1], corners[2], corners[3])) {
    return "As arestas superior e inferior se cruzam.";
  }
  if (segmentsIntersect(corners[1], corners[2], corners[3], corners[0])) {
    return "O quadrilátero está cruzado. Reordene os vértices.";
  }
  if (polygonArea(corners) < 100) return "A área marcada é muito pequena.";
  const signs = corners.map((point, index) =>
    Math.sign(cross(point, corners[(index + 1) % 4], corners[(index + 2) % 4])),
  );
  if (signs.some((sign) => sign === 0) || !signs.every((sign) => sign === signs[0])) {
    return "A arena deve formar um quadrilátero convexo.";
  }
  return null;
}

export function validateArenaRegions(arena: ArenaConfig, width: number, height: number, requireRim = false) {
  if (requireRim && !arena.rimCornersPx) return "Marque e confirme a borda superior da caixa.";
  for (const [label, points] of [["Chão", arena.cornersPx], ["Borda", arena.rimCornersPx]] as const) {
    if (!points) continue;
    const error = validateArenaCorners(points);
    if (error) return `${label}: ${error}`;
    if (points.some(({ x, y }) => x < 0 || y < 0 || x > width || y > height)) return `${label}: mantenha os vértices dentro do vídeo.`;
  }
  if (!Number.isFinite(arena.widthCm) || !Number.isFinite(arena.heightCm) || arena.widthCm <= 0 || arena.heightCm <= 0) return "Informe dimensões físicas positivas para o chão.";
  // Em perspectiva, a projeção da borda superior não precisa conter a projeção do chão.
  return null;
}

function solveLinearSystem(matrix: number[][], values: number[]) {
  const n = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < EPSILON) throw new Error("Homografia degenerada");
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let valueIndex = column; valueIndex <= n; valueIndex += 1) {
      augmented[column][valueIndex] /= divisor;
    }
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let valueIndex = column; valueIndex <= n; valueIndex += 1) {
        augmented[row][valueIndex] -= factor * augmented[column][valueIndex];
      }
    }
  }
  return augmented.map((row) => row[n]);
}

export function calculateHomography(source: Point[], destination: Point[]): Matrix3 {
  if (source.length !== 4 || destination.length !== 4) throw new Error("São necessários quatro pontos");
  const matrix: number[][] = [];
  const values: number[] = [];
  source.forEach((point, index) => {
    const target = destination[index];
    matrix.push([point.x, point.y, 1, 0, 0, 0, -target.x * point.x, -target.x * point.y]);
    values.push(target.x);
    matrix.push([0, 0, 0, point.x, point.y, 1, -target.y * point.x, -target.y * point.y]);
    values.push(target.y);
  });
  const solution = solveLinearSystem(matrix, values);
  return [...solution, 1] as Matrix3;
}

export function transformPoint(point: Point, matrix: Matrix3): Point {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (Math.abs(denominator) < EPSILON) throw new Error("Ponto não projetável");
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

export function pixelToFloorMatrix(arena: ArenaConfig) {
  return calculateHomography(arena.cornersPx, [
    { x: 0, y: 0 },
    { x: arena.widthCm, y: 0 },
    { x: arena.widthCm, y: arena.heightCm },
    { x: 0, y: arena.heightCm },
  ]);
}

export function centerPolygonPx(arena: ArenaConfig) {
  const sideFraction = Math.sqrt(arena.centerAreaFraction);
  const xMargin = (arena.widthCm * (1 - sideFraction)) / 2;
  const yMargin = (arena.heightCm * (1 - sideFraction)) / 2;
  const floorToPixel = calculateHomography(
    [
      { x: 0, y: 0 },
      { x: arena.widthCm, y: 0 },
      { x: arena.widthCm, y: arena.heightCm },
      { x: 0, y: arena.heightCm },
    ],
    arena.cornersPx,
  );
  return [
    { x: xMargin, y: yMargin },
    { x: arena.widthCm - xMargin, y: yMargin },
    { x: arena.widthCm - xMargin, y: arena.heightCm - yMargin },
    { x: xMargin, y: arena.heightCm - yMargin },
  ].map((point) => transformPoint(point, floorToPixel));
}

export function isCenterPoint(pointCm: Point, arena: ArenaConfig) {
  const sideFraction = Math.sqrt(arena.centerAreaFraction);
  const xMargin = (arena.widthCm * (1 - sideFraction)) / 2;
  const yMargin = (arena.heightCm * (1 - sideFraction)) / 2;
  return (
    pointCm.x >= xMargin &&
    pointCm.x <= arena.widthCm - xMargin &&
    pointCm.y >= yMargin &&
    pointCm.y <= arena.heightCm - yMargin
  );
}

export function pointsToSvg(points: Point[]) {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

