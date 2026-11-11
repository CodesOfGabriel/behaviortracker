"""Baixa um checkpoint versionado para o runtime e publica somente após validar SHA-256."""

import hashlib
import os
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def fetch_model(url, destination, expected_size, expected_sha256):
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".download")
    last_error = None
    for attempt in range(3):
        try:
            digest = hashlib.sha256()
            received = 0
            request = Request(url, headers={"User-Agent": "BehaviorTracker-model-delivery/1"})
            with urlopen(request, timeout=90) as response, partial.open("wb") as output:
                while block := response.read(1024 * 1024):
                    received += len(block)
                    if received > expected_size:
                        raise ValueError("Arquivo remoto maior que o checkpoint esperado")
                    output.write(block)
                    digest.update(block)
            if received != expected_size or digest.hexdigest() != expected_sha256:
                raise ValueError("Tamanho ou SHA-256 do checkpoint remoto não confere")
            os.replace(partial, target)
            print("BEHAVETRACKER_MODEL_READY=" + target.name, flush=True)
            return
        except Exception as error:
            last_error = error
            partial.unlink(missing_ok=True)
            if isinstance(error, HTTPError) and error.code in (401, 403, 404):
                break
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"Download remoto não validado: {last_error}") from last_error
