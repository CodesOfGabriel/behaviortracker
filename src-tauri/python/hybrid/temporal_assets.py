"""Pinned CoTracker assets, downloaded outside installers and checked before use.

CoTracker by Meta Platforms, Inc. and affiliates, CC BY-NC 4.0.
https://github.com/facebookresearch/co-tracker/blob/82e02e8029753ad4ef13cf06be7f4fc5facdda4d/LICENSE.md
The verified source is imported directly from its ZIP; nothing is extracted or
installed with pip, and torch.hub never executes an unpinned remote revision.
"""
import hashlib
import importlib
from pathlib import Path
import sys
import tempfile
import urllib.request

COMMIT = "82e02e8029753ad4ef13cf06be7f4fc5facdda4d"
ASSETS = {
    "code.zip": {"url": f"https://codeload.github.com/facebookresearch/co-tracker/zip/{COMMIT}",
                 "sizeBytes": 33561861,
                 "sha256": "2706dfa5e6b800d56aee87b952f93c9855da0fa59c3cd06ef8ac9c03b3b083f9"},
    "scaled_online.pth": {
        "url": "https://huggingface.co/facebook/cotracker3/resolve/bf55ea50d4390e1820a267f131cd6587240fb2c5/scaled_online.pth",
        "sizeBytes": 101695610,
        "sha256": "205d34789f19699d64b22cf93f9b697f15f28d4025240e31532e504109837218"},
}


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024*1024), b""):
            result.update(block)
    return result.hexdigest()


def checked(path, specification):
    path = Path(path)
    return (path.is_file() and path.stat().st_size == specification["sizeBytes"]
            and digest(path) == specification["sha256"])


def fetch_checked(path, specification, opener=None):
    path = Path(path)
    if checked(path, specification):
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=path.name+"-", suffix=".partial", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            with (opener or urllib.request.urlopen)(specification["url"], timeout=120) as response:
                size = 0
                for block in iter(lambda: response.read(1024*1024), b""):
                    size += len(block)
                    if size > specification["sizeBytes"]:
                        raise ValueError("Arquivo temporal excede o tamanho esperado")
                    handle.write(block)
        if not checked(temporary, specification):
            raise ValueError("Tamanho ou SHA-256 do modelo temporal não confere")
        temporary.replace(path)
        return path
    except Exception as error:
        raise RuntimeError(f"Não foi possível preparar {path.name} para recuperação temporal ({type(error).__name__})") from None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def prepare_assets(models, opener=None):
    root = Path(models)/"cotracker3-online-v1"
    files = {name: fetch_checked(root/name, spec, opener) for name, spec in ASSETS.items()}
    return files, {"model": "cotracker3_online", "codeCommit": COMMIT,
                   "license": "CC-BY-NC-4.0",
                   "licenseUrl": f"https://github.com/facebookresearch/co-tracker/blob/{COMMIT}/LICENSE.md",
                   "files": ASSETS}


def create_tracker(models, device="cuda"):
    import torch

    files, metadata = prepare_assets(models)
    source = str(files["code.zip"].resolve())+f"/co-tracker-{COMMIT}"
    existing = sys.modules.get("cotracker")
    if existing is not None and not str(getattr(existing, "__file__", "")).startswith(source+"/"):
        raise RuntimeError("Outra versão do CoTracker já está carregada; reinicie este worker")
    if source not in sys.path:
        sys.path.insert(0, source)
    with torch.random.fork_rng(devices=[]):
        module = importlib.import_module("cotracker.predictor")
        if not str(module.__file__).startswith(source+"/"):
            raise RuntimeError("O CoTracker não veio do código verificado")
        tracker = module.CoTrackerOnlinePredictor(checkpoint=None)
    state = torch.load(files["scaled_online.pth"], map_location="cpu", weights_only=True)
    tracker.model.load_state_dict(state.get("model", state), strict=True)
    return tracker.to(device).eval(), metadata
