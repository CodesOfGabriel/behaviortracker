"""Validação local do bundle de modelos D+F; não baixa nem executa pesos."""

import hashlib
from pathlib import Path


REQUIRED_FILES = (
    "best_detector.pth",
    "snapshot-hrnet_w32-001.pt",
    "pytorch_config.yaml",
)
REQUIRED_BUNDLE_ID = "wistar_df_v1"
ALLOWED_BUNDLE_IDS = ("wistar_df_v1", "wistar_df_v2")


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_bundle(directory, manifest=None, bundle_id=None):
    bundle_id = bundle_id or (manifest.get("bundleId") if manifest else REQUIRED_BUNDLE_ID)
    if bundle_id not in ALLOWED_BUNDLE_IDS:
        raise ValueError("Bundle D+F incompatível")
    root = Path(directory)
    files = {}
    for filename in REQUIRED_FILES:
        path = root / filename
        if not path.is_file() or path.stat().st_size <= 0:
            raise ValueError(f"Arquivo obrigatório ausente ou vazio: {filename}")
        files[filename] = {"path": str(path), "sizeBytes": path.stat().st_size, "sha256": sha256(path)}
    try:
        config_text = (root / "pytorch_config.yaml").read_text(encoding="utf-8")
    except Exception as error:
        raise ValueError(f"Configuração PyTorch inválida: {error}") from error
    bodyparts = []
    in_bodyparts = False
    bodyparts_indent = None
    for line in config_text.splitlines():
        stripped = line.strip()
        if stripped in ("bodyparts:", "bodyparts: []"):
            in_bodyparts = stripped == "bodyparts:"
            bodyparts_indent = len(line) - len(line.lstrip()) + 2
            continue
        if in_bodyparts and len(line) - len(line.lstrip()) == bodyparts_indent and stripped.startswith("- "):
            bodyparts.append(stripped[2:].strip())
            continue
        if in_bodyparts and line.strip() and len(line) - len(line.lstrip()) < bodyparts_indent:
            in_bodyparts = False
    if "metadata:" in config_text and not bodyparts and "bodyparts:" not in config_text:
        bodyparts = []
    if bodyparts is not None and len(bodyparts) != 27:
        raise ValueError("A configuração HRNet precisa declarar 27 keypoints")
    if manifest is not None:
        if manifest.get("bundleId") != bundle_id or manifest.get("keypointCount") != 27:
            raise ValueError("Bundle D+F incompatível")
        if manifest.get("detectorClasses", ["background", "wistar"]) != ["background", "wistar"]:
            raise ValueError("Classes do detector incompatíveis")
        for filename, entry in files.items():
            expected = manifest.get("files", {}).get(filename, {})
            if expected.get("sha256") != entry["sha256"] or expected.get("sizeBytes") != entry["sizeBytes"]:
                raise ValueError(f"Hash ou tamanho do bundle não confere: {filename}")
    return {"bundleId": bundle_id, "files": files, "keypointCount": len(bodyparts) if bodyparts else None}
