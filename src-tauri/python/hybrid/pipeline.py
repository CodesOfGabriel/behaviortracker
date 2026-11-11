"""Contrato de orquestração do pipeline D+F sem dependência de CUDA."""

from datetime import datetime, timezone
import json
from pathlib import Path

from .model_registry import validate_bundle


ENGINE_ID = "wistar_superanimal_hybrid_v1"
PIPELINE_VERSION = "hybrid-df-contract-1"


def validate_frame_contract(frame_map, detections, pose_rows):
    sizes = {"frameMap": len(frame_map), "detections": len(detections), "poses": len(pose_rows)}
    if not sizes["frameMap"] or len(set(sizes.values())) != 1:
        raise ValueError(f"Contagens de frames incompatíveis: {sizes}")
    normalized = [row["normalizedFrameIndex"] for row in frame_map]
    if normalized != list(range(len(frame_map))):
        raise ValueError("Mapa temporal não possui índices normalizados consecutivos")
    if any(row.get("frameIndex") != index for index, row in enumerate(detections)):
        raise ValueError("Detecções fora de ordem")
    return sizes


def prepare_manifest(bundle_directory, source_sha256, video, frame_map, detections, pose_rows, bundle_id="wistar_df_v1", bundle_manifest=None):
    bundle = validate_bundle(bundle_directory, bundle_manifest, bundle_id)
    counts = validate_frame_contract(frame_map, detections, pose_rows)
    if not isinstance(source_sha256, str) or len(source_sha256) != 64:
        raise ValueError("SHA-256 do vídeo original inválido")
    if not isinstance(video, dict) or video.get("width", 0) <= 0 or video.get("height", 0) <= 0:
        raise ValueError("Metadados de vídeo inválidos")
    return {
        "schemaVersion": 1,
        "pipelineVersion": PIPELINE_VERSION,
        "engineId": ENGINE_ID,
        "modelBundle": bundle,
        "sourceSha256": source_sha256,
        "video": video,
        "frameCounts": counts,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "artifacts": {
            "frameMap": "frame_map.csv",
            "detections": "detections.csv",
            "poseRaw": "pose_raw.csv",
            "quality": "qc_by_frame.csv",
        },
    }


def write_manifest(path, manifest):
    destination = Path(path)
    destination.write_text(json.dumps(manifest, sort_keys=True, indent=2), encoding="utf-8")
