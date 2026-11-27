# Procedimentos de validação com dados próprios

Este guia preserva os procedimentos reutilizáveis do piloto de desenvolvimento,
sem distribuir seus vídeos, seleção de frames, anotações ou resultados privados.
Use somente dados cuja utilização esteja autorizada e mantenha entradas e saídas
de pesquisa em `private/`, `datasets/` ou `training-runs/`. As condições de acesso
estão no [DATASET_CARD.md](../DATASET_CARD.md).

## Referência humana

Defina os pontos anatômicos, visibilidade, oclusão, categorias e critérios de
exclusão antes da anotação. Preserve SHA-256 do vídeo, protocolo, dimensões,
timestamps, identificação de animal/sessão e a separação de treino/validação/teste.
Reserve gravações independentes antes de ajustar parâmetros; não trate frames
adjacentes do mesmo vídeo como amostras independentes.

O editor de referência humana implementa importação de manifesto e conferência
de vídeo, rascunho, envio à revisão e aprovação/rejeição por outro identificador.
A identidade é declarada no formulário: a auditoria deve verificar quem utilizou
cada identificador. Os observadores devem trabalhar independentemente, sem
consultar as predições. Registre discordâncias antes da adjudicação e preserve
as exportações CSV/JSON e o histórico. O fluxo e os controles disponíveis dependem
da interface do protocolo; veja [o estado da implementação](IMPLEMENTATION_STATUS.md).

## Comparação de filtros de pose

```sh
python3 scripts/compare-pose-filters.py \
  --pose private/validation/pose.csv \
  --reference private/validation/human-reference.csv \
  --video-sha256 SHA256_DO_VIDEO_ORIGINAL \
  --annotator OBSERVADOR_1 \
  --output private/validation/filter-comparison.json
```

Crie o diretório de saída e forneça as exportações da sua própria sessão. O
comparador preserva as entradas e escreve JSON, CSV e Markdown. MAE, RMSE e
PCK@5/10 px exigem pontos humanos visíveis, aprovados por outro identificador e
pareados no mesmo relógio nas variantes comparadas. Se houver dois observadores
aprovados no mesmo ponto, selecione um com `--annotator`. Confira a associação
entre pose e vídeo: o CSV canônico de pose não contém o SHA-256 do original.
PTS divergentes interrompem a comparação; sem referência aprovada, as métricas
espaciais ficam indisponíveis. Jitter, saltos, lacunas e cobertura são descritores,
não evidência de precisão anatômica. O filtro One Euro permanece experimental.

## Benchmark do motor OpenCV

```sh
python3 scripts/benchmark-opencl.py \
  --case sessao:private/validation/video.mp4:private/validation/config.json \
  --python PYTHON_COM_OPENCV \
  --warmups 1 --repeats 2 --versions current \
  --output private/validation/benchmark.json
```

Use geometria/configuração própria, registre o ambiente, carga da máquina,
versões e hashes. O script registra CPU/OpenCL, cobertura, recursos, tempos e
comparações pareadas. `OpenCL solicitado` só indica uso efetivo da GPU quando
`computeBackend` o confirmar. Comparações com `--versions both` incluem todas
as diferenças entre `HEAD` e a árvore de trabalho. Tempo de processamento não
mede precisão anatômica. Consulte também o
[processamento clássico](local-classical-processing.md) para preparar filas de
revisão e comparar execuções preservando os dados originais.

## Limites e preservação

Testes sintéticos verificam contratos e regressões; não substituem anotação
independente, concordância entre observadores nem validação em novos animais e
sessões. Erros de início/fim de eventos exigem rótulos humanos temporais aprovados
e um comparador correspondente. Nenhum resultado ou tamanho de amostra é
estabelecido por este guia. Preserve os dados e ambientes em armazenamento privado
apropriado, conforme [REPRODUCIBILITY.md](REPRODUCIBILITY.md).
