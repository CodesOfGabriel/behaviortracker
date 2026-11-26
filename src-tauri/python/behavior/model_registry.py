"""Pinned behavior bundles reuse the application's verified model delivery."""
import hashlib
import json
from pathlib import Path
from model_delivery import fetch_model, verified, install_small_config


def load_manifest(path, require_weights=True):
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if value.get("schemaVersion") != 1 or value.get("modelId") != "oft_rearing_v1" or value.get("protocol") != "open_field" or value.get("cameraView") != "top_down":
        raise ValueError("Incompatible behavior model")
    if value.get("runtimeVersion") != "1.20.1" or value.get("featureSchema") != "oft-behavior-features-1":
        raise ValueError("Incompatible runtime or features")
    if value.get("architecture") not in {"random_forest", "visual", "visual_tcn", "hybrid_tcn"}:
        raise ValueError("Unsupported architecture")
    if value.get("sampleRateHz") not in {10, 15, 30} or value.get("temporalWindow") != 31 or value.get("inputSize") != [128, 128]:
        raise ValueError("Unsupported temporal or crop configuration")
    files = value.get("files", {})
    required = {"feature_schema.json", "normalization.json", "decoder_config.json", "temporal_classifier.onnx"}
    if value["architecture"] != "random_forest":
        required.add("visual_encoder.onnx")
    if require_weights and (value.get("availability") != "trained" or set(files) != required):
        raise ValueError("Modelo de rearing ainda não treinado: anote vídeos e exporte um bundle verificado")
    for name, spec in files.items():
        if name not in required or Path(name).name != name or "/" in name or "\\" in name:
            raise ValueError("Invalid model filename")
        digest = spec.get("sha256", "")
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest) or not isinstance(spec.get("sizeBytes"), int) or spec["sizeBytes"] <= 0:
            raise ValueError("Model size and SHA-256 are required")
        url = spec.get("url")
        if url and (not url.startswith("https://") or not value.get("releaseTag") or value["releaseTag"] == "latest" or f'/releases/download/{value["releaseTag"]}/' not in url):
            raise ValueError("Use version-pinned release assets")
    return value


def status(manifest_path, model_dir):
    manifest = load_manifest(manifest_path, require_weights=False)
    installed = False
    if manifest.get("availability") == "trained":
        manifest = load_manifest(manifest_path)
        installed = all(verified(Path(model_dir)/name, spec["sizeBytes"], spec["sha256"]) for name, spec in manifest["files"].items())
    return dict(installed=installed, remoteAvailable=bool(manifest.get("files")) and all(s.get("url") for s in manifest["files"].values()),
                manifest=manifest, message=None if installed else "Modelo supervisionado de rearing ainda não instalado")


def install(manifest_path, destination, cancelled=lambda: False, local_source=None):
    manifest = load_manifest(manifest_path)
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for name, spec in manifest["files"].items():
        if cancelled():
            raise InterruptedError("Model installation cancelled")
        if local_source:
            data = (Path(local_source)/name).read_bytes()
            install_small_config(data, destination/name, spec["sizeBytes"], spec["sha256"])
        else:
            fetch_model(spec.get("url", ""), destination/name, spec["sizeBytes"], spec["sha256"], cancelled=cancelled)
    data = Path(manifest_path).read_bytes()
    install_small_config(data, destination/"manifest.json", len(data), hashlib.sha256(data).hexdigest())
    return status(destination/"manifest.json", destination)
