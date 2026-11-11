#!/usr/bin/env python3
"""Cria o bundle wistar_df_v2 sem modificar o detector v1.

Recebe três arquivos locais explícitos e monta o bundle usado no instalador.
O ZIP é opcional.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import shutil
from pathlib import Path

ID = 'wistar_df_v2'
EXPECTED = {
    'best_detector.pth': '211891e0ec5f5b3f56d0f0be5b9255319ce9857284e72e558ccfc9f4ca93eef0',
    'snapshot-hrnet_w32-001.pt': 'd81c8f18ba0729263168b96eab3e09b6bc3d0ee194b131fb381d2526266ff215',
    'pytorch_config.yaml': '847076c1253f53816155fe247ca1448a13039498d902c2d75b24dac9d800f907',
}

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def main():
    p = argparse.ArgumentParser(description='Preparar bundle versionado do detector D+F v2')
    p.add_argument('--dest', type=Path, default=Path(__file__).resolve().parents[1] / 'models' / ID,
                   help='Pasta de saída do bundle usado no instalador')
    p.add_argument('--detector', required=True, type=Path, help='Checkpoint v2 local')
    p.add_argument('--hrnet', required=True, type=Path, help='Checkpoint local da HRNet 27 pontos')
    p.add_argument('--config', required=True, type=Path, help='Configuração YAML local da HRNet')
    p.add_argument('--zip', action='store_true', help='Também gerar um ZIP com o bundle (inclui pesos grandes)')
    args = p.parse_args()
    files = {
        'best_detector.pth': args.detector,
        'snapshot-hrnet_w32-001.pt': args.hrnet,
        'pytorch_config.yaml': args.config,
    }
    dest = args.dest.expanduser().resolve()
    # Validar TODAS as entradas antes de gravar ou modificar saída.
    metadata = {}
    for filename, candidate in files.items():
        if not Path(candidate).is_file():
            raise FileNotFoundError(f'{filename} não encontrado. Especifique --detector, --hrnet ou --config conforme o arquivo faltante.')
        source = Path(candidate).resolve()
        current = digest(source)
        if current != EXPECTED[filename]:
            raise ValueError(f'SHA-256 inválido para {filename}: {current}\nEsperado: {EXPECTED[filename]}')
        metadata[filename] = {'sizeBytes': source.stat().st_size, 'sha256': current}
        files[filename] = source
    dest.mkdir(parents=True, exist_ok=True)
    for filename, source in files.items():
        target = dest / filename
        if source != target:
            if not target.is_file() or digest(target) != EXPECTED[filename]:
                shutil.copy2(source, target)
        if digest(target) != EXPECTED[filename]:
            raise RuntimeError(f'Integridade da cópia não confere: {target}')
    manifest = {
        'bundleId': ID,
        'keypointCount': 27,
        'detectorArchitecture': 'fasterrcnn_resnet50_fpn_v2',
        'detectorClasses': ['background', 'wistar'],
        'validationStatus': 'experimental; train/validation only; independent test unavailable',
        'files': metadata,
    }
    manifest_path = dest.parent / f'{ID}.manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    (dest / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('Bundle criado:', dest)
    print('Manifesto:', manifest_path)
    for filename, info in metadata.items():
        print(f"  {filename}: {info['sizeBytes']} bytes / {info['sha256']}")
    if args.zip:
        zip_path = shutil.make_archive(str(dest), 'zip', root_dir=dest.parent, base_dir=dest.name)
        print('Arquivo ZIP:', zip_path)
    print('IMPORTANTE: arquivos .pth/.pt não devem ser forçados ao Git; versionar manifesto e código.')

if __name__ == '__main__':
    main()
