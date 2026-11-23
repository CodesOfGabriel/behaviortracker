"""Verified model cache. Only complete, pinned files are published atomically."""
import hashlib
import os
from pathlib import Path
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class DownloadCancelled(Exception):
    pass


def verified(path, size, digest):
    path = Path(path)
    if not path.is_file() or path.stat().st_size != size:
        return False
    sha = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            sha.update(block)
    return sha.hexdigest() == digest


def fetch_model(url, destination, expected_size, expected_sha256, *, progress=None, cancelled=None):
    if not url.startswith('https://') or '/releases/latest' in url:
        raise ValueError('Use uma URL HTTPS versionada')
    if expected_size <= 0 or len(expected_sha256) != 64 or any(c not in '0123456789abcdef' for c in expected_sha256):
        raise ValueError('Tamanho ou SHA-256 esperado inválido')
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    def check_cancel():
        if cancelled and cancelled():
            raise DownloadCancelled('Download cancelado')
    check_cancel()
    if verified(target, expected_size, expected_sha256):
        if progress: progress(expected_size, expected_size)
        print('BEHAVETRACKER_MODEL_CACHED=' + target.name, flush=True)
        return target
    last_error = None
    for attempt in range(3):
        partial = None
        try:
            check_cancel()
            digest, received = hashlib.sha256(), 0
            request = Request(url, headers={'User-Agent': 'BehaviorTracker-model-delivery/2'})
            with urlopen(request, timeout=90) as response, tempfile.NamedTemporaryFile(
                    dir=target.parent, prefix=target.name+'.', suffix='.download', delete=False) as output:
                partial = Path(output.name)
                while True:
                    check_cancel()
                    block = response.read(1024 * 1024)
                    if not block: break
                    received += len(block)
                    if received > expected_size:
                        raise ValueError('Arquivo remoto maior que o checkpoint esperado')
                    output.write(block)
                    digest.update(block)
                    if progress: progress(received, expected_size)
                    else: print(f'BEHAVETRACKER_MODEL_PROGRESS={target.name}:{received}/{expected_size}', flush=True)
                output.flush()
                os.fsync(output.fileno())
            if received != expected_size or digest.hexdigest() != expected_sha256:
                raise ValueError('Tamanho ou SHA-256 do checkpoint remoto não confere')
            check_cancel()
            os.replace(partial, target)
            print('BEHAVETRACKER_MODEL_READY=' + target.name, flush=True)
            return target
        except DownloadCancelled:
            raise
        except Exception as error:
            last_error = error
            if isinstance(error, HTTPError) and error.code in (401, 403, 404): break
            if attempt < 2: time.sleep(2 ** attempt)
        finally:
            if partial: partial.unlink(missing_ok=True)
    raise RuntimeError(f'Download remoto não validado: {last_error}') from last_error


def install_bundle(registry, app_data_dir, runtime_id, *, progress=None, cancelled=None, bundled_config_dir=None):
    """Future local neural inference shares the downloader and app data cache.

    Called only on explicit demand by a neural runtime, never during app startup.
    Cache eviction is manual; verified bundles survive application updates.
    """
    bundle_id = registry.get('bundleId', '')
    if not bundle_id or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789_-' for c in bundle_id):
        raise ValueError('ID do bundle inválido')
    if registry.get('registryVersion') != 'model-delivery-2' or registry.get('compatibility', {}).get('runtime') != runtime_id:
        raise ValueError('Runtime incompatível com o bundle')
    tag = registry.get('releaseTag', '')
    if not tag or tag == 'latest': raise ValueError('Tag versionada obrigatória')
    root = Path(app_data_dir) / 'models' / bundle_id
    for filename, spec in registry['files'].items():
        if Path(filename).name != filename or filename in ('.', '..') or '/' in filename or '\\' in filename:
            raise ValueError('Nome de arquivo inválido')
        if spec.get('source') == 'bundled-small-config':
            if bundled_config_dir is None: raise ValueError('Configuração pequena empacotada ausente')
            if cancelled and cancelled(): raise DownloadCancelled('Download cancelado')
            install_small_config((Path(bundled_config_dir)/filename).read_bytes(), root/filename, spec['sizeBytes'], spec['sha256'])
            continue
        if f'/releases/download/{tag}/' not in spec['url']:
            raise ValueError('URL incompatível com a tag do bundle')
        fetch_model(spec['url'], root / filename, spec['sizeBytes'], spec['sha256'],
                    progress=progress, cancelled=cancelled)
    return root


def install_small_config(content, destination, expected_size, expected_sha256):
    """Transport bundled configuration as data, with the same publication rules."""
    data = content.encode('utf-8') if isinstance(content, str) else content
    if len(data) != expected_size or hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError('Integridade da configuração empacotada inválida')
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    if verified(target, expected_size, expected_sha256): return target
    partial = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name+'.', suffix='.download', delete=False) as output:
            partial = Path(output.name)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(partial, target)
        return target
    finally:
        if partial: partial.unlink(missing_ok=True)
