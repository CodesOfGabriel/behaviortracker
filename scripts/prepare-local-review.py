"""Select frames for human review without creating human annotations."""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path


def evenly(values, count):
    if not values or count <= 0:
        return []
    count = min(count, len(values))
    return [values[round(i*(len(values)-1)/max(1, count-1))] for i in range(count)]


def select(samples, limit=120):
    if not 100 <= limit <= 200:
        raise ValueError("Selecione entre 100 e 200 frames para revisão")
    groups = defaultdict(list)
    ordered = sorted(samples, key=lambda value: value["frameIndex"])
    for sample in ordered:
        groups[sample.get("reason", "unknown")].append(sample)
    selected = {sample["frameIndex"]: sample for sample in evenly(ordered, limit//2)}
    # Round-robin preserves rare alert types instead of filling with one reason.
    candidates = {key: evenly(values, limit) for key, values in sorted(groups.items())}
    for rank in range(limit):
        for values in candidates.values():
            if rank < len(values) and len(selected) < limit:
                sample = values[rank]
                selected[sample["frameIndex"]] = sample
    return [{"frameIndex": sample["frameIndex"], "timestampSec": sample["timestampSec"],
             "selectionReason": sample.get("reason"), "suggestedBox": sample.get("bbox"),
             "algorithmQuality": sample.get("localQuality"),
             "humanBox": None, "visibility": None, "annotatorId": None,
             "reviewerId": None, "approved": False}
            for _, sample in sorted(selected.items())]


def prepare(run, output, limit=120):
    status = json.loads((run/"status.json").read_text())
    manifest = json.loads((run/"run_manifest.json").read_text())
    request = json.loads((run/"request.json").read_text())
    if status["state"] != "succeeded" or manifest.get("timing") != "ffprobe_pts":
        raise ValueError("Use uma execução concluída com timestamps originais")
    digest = hashlib.sha256()
    with Path(request["video"]).open("rb") as source:
        for chunk in iter(lambda: source.read(4*1024*1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != manifest["config"].get("videoSha256"):
        raise ValueError("O SHA-256 do vídeo não corresponde ao manifesto")
    samples = [json.loads(line) for line in (run/"samples.jsonl").read_text().splitlines()]
    if any(sample["frameIndex"] != index for index, sample in enumerate(samples)) or any(
            b["timestampSec"] <= a["timestampSec"] for a, b in zip(samples, samples[1:])):
        raise ValueError("Contagem ou relógio dos frames inválido")
    result = {"schemaVersion": "local-human-review-queue-1", "status": "PENDING_HUMAN_REVIEW",
        "source": "automated_selection_not_human_reference", "independentHoldout": False,
        "videoSha256": digest.hexdigest(), "algorithmVersion": manifest["algorithmVersion"],
        "frameCount": len(samples), "selectedFrames": select(samples, limit),
        "limits": "Suggested boxes are algorithm outputs, never ground truth. Human annotation and independent review are pending. Additional recordings are required for independent validation."}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)+"\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--frames", type=int, default=120)
    args = parser.parse_args()
    prepare(args.run, args.output, args.frames)
