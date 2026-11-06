import type { PoseSample, PoseSource, PoseStatus } from "../types";

const validStatuses = new Set<PoseStatus>([
  "valid",
  "low_confidence",
  "jump",
  "missing",
  "out_of_arena",
]);

export function parseCanonicalPoseCsv(text: string): PoseSample[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("O CSV não contém observações.");
  const headers = lines[0].split(",").map((header) => header.trim());
  const required = ["frame_index", "timestamp_sec", "keypoint", "x_px", "y_px", "likelihood", "status"];
  required.forEach((column) => {
    if (!headers.includes(column)) throw new Error(`Coluna obrigatória ausente: ${column}`);
  });
  const indexOf = (column: string) => headers.indexOf(column);
  const samples = lines.slice(1).map((line, rowIndex) => {
    const values = line.split(",").map((value) => value.trim());
    const number = (column: string) => Number(values[indexOf(column)]);
    const nullableNumber = (column: string) => {
      const raw = values[indexOf(column)];
      return raw === "" ? null : Number(raw);
    };
    const statusRaw = values[indexOf("status")] as PoseStatus;
    const sample: PoseSample = {
      frameIndex: number("frame_index"),
      timestampSec: number("timestamp_sec"),
      keypoint: values[indexOf("keypoint")],
      xPx: nullableNumber("x_px"),
      yPx: nullableNumber("y_px"),
      likelihood: number("likelihood"),
      status: statusRaw,
    };
    if (
      !validStatuses.has(statusRaw) || !sample.keypoint || sample.frameIndex < 0 || sample.timestampSec < 0 ||
      !Number.isInteger(sample.frameIndex) ||
      !Number.isFinite(sample.timestampSec) ||
      !Number.isFinite(sample.likelihood) ||
      (sample.xPx != null && !Number.isFinite(sample.xPx)) ||
      (sample.yPx != null && !Number.isFinite(sample.yPx))
    ) {
      throw new Error(`Valor inválido na linha ${rowIndex + 2}.`);
    }
    // Arquivos antigos podem conter (-1, -1, -1): sentinelas do modelo, não coordenadas.
    if (sample.likelihood < 0 || sample.likelihood > 1 || sample.xPx == null || sample.yPx == null || sample.xPx < 0 || sample.yPx < 0 || sample.status === "missing") {
      sample.xPx = null;
      sample.yPx = null;
      sample.status = "missing";
      if (sample.likelihood < 0 || sample.likelihood > 1) sample.likelihood = 0;
    }
    const region = values[indexOf("spatial_region")];
    if (["floor", "wall_projection", "outside", "unknown"].includes(region)) sample.spatialRegion = region as PoseSample["spatialRegion"];
    for (const [column, field] of [["support_count", "supportCount"], ["support_total", "supportTotal"]] as const) {
      if (indexOf(column) < 0 || values[indexOf(column)] === "") continue;
      const value = number(column);
      if (!Number.isInteger(value) || value < 0) throw new Error(`Suporte anatômico inválido na linha ${rowIndex + 2}.`);
      sample[field] = value;
    }
    if (sample.supportCount != null && sample.supportTotal != null && sample.supportCount > sample.supportTotal) throw new Error(`Suporte anatômico inconsistente na linha ${rowIndex + 2}.`);
    const source = values[indexOf("source")];
    if (source) {
      if (!["detected", "recovered", "predicted", "manual"].includes(source)) throw new Error(`Origem inválida na linha ${rowIndex + 2}.`);
      sample.source = source as PoseSource;
    }
    if (indexOf("raw_status") >= 0 && values[indexOf("raw_status")]) {
      const rawStatus = values[indexOf("raw_status")] as PoseStatus;
      const x = nullableNumber("raw_x_px"), y = nullableNumber("raw_y_px"), score = number("raw_likelihood");
      if (!validStatuses.has(rawStatus) || !Number.isFinite(score) || score < 0 || score > 1
        || (x != null && (!Number.isFinite(x) || x < 0)) || (y != null && (!Number.isFinite(y) || y < 0))
        || (rawStatus !== "missing" && (x == null || y == null))) throw new Error(`Observação original inválida na linha ${rowIndex + 2}.`);
      sample.original = { xPx: rawStatus === "missing" ? null : x, yPx: rawStatus === "missing" ? null : y,
        likelihood: score, status: rawStatus, spatialRegion: values[indexOf("raw_spatial_region")] as PoseSample["spatialRegion"] };
      for (const [column, field] of [["raw_support_count", "supportCount"], ["raw_support_total", "supportTotal"]] as const) {
        if (indexOf(column) < 0 || !values[indexOf(column)]) continue;
        const value = number(column);
        if (!Number.isInteger(value) || value < 0) throw new Error(`Suporte original inválido na linha ${rowIndex + 2}.`);
        sample.original[field] = value;
      }
    }
    const recoveryState = values[indexOf("recovery_state")];
    if (recoveryState && ["ready", "unavailable", "not_needed"].includes(recoveryState)) sample.recoveryState = recoveryState as PoseSample["recoveryState"];
    if (sample.source === "recovered" && !sample.original) throw new Error(`Recuperação sem observação original na linha ${rowIndex + 2}.`);
    return sample;
  });
  if (!samples.length) throw new Error("O CSV não contém observações válidas.");
  return samples;
}

function csvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function poseToCsv(samples: PoseSample[]) {
  const header = "frame_index,timestamp_sec,animal_id,keypoint,x_px,y_px,likelihood,status,spatial_region,support_count,support_total,source,raw_x_px,raw_y_px,raw_likelihood,raw_status,raw_spatial_region,raw_support_count,raw_support_total,recovery_state";
  const rows = samples.map((sample) =>
    [
      sample.frameIndex,
      sample.timestampSec.toFixed(6),
      "animal_1",
      sample.keypoint,
      sample.xPx?.toFixed(3) ?? "",
      sample.yPx?.toFixed(3) ?? "",
      sample.likelihood.toFixed(4),
      sample.status,
      sample.spatialRegion ?? "unknown",
      sample.supportCount ?? "",
      sample.supportTotal ?? "",
      sample.source ?? "detected",
      (sample.original ?? sample).xPx ?? "",
      (sample.original ?? sample).yPx ?? "",
      (sample.original ?? sample).likelihood,
      (sample.original ?? sample).status,
      (sample.original ?? sample).spatialRegion ?? "unknown",
      (sample.original ?? sample).supportCount ?? "",
      (sample.original ?? sample).supportTotal ?? "",
      sample.recoveryState ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [header, ...rows].join("\n");
}

export function downloadText(filename: string, contents: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

