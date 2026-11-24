# RAM Color v2 — diagnóstico de integração

Execução local em 23/11/2026, sobre os 14.514 frames do vídeo original, após verificar SHA-256 `8f1fbed025c972c5ad7e194502a0f1ac1b0dffe8a52bf1a8d577e3ff20ae69b3`. A comparação usa as 23 caixas aprovadas do pacote recebido. É a mesma sessão utilizada para desenvolver a estratégia: não é holdout nem comprovação de revisor independente.

| Medida | V1 congelada no pacote | V2 local |
|---|---:|---:|
| Frames processados | 14.514 | 14.514 |
| Cobertura de observações aceitas | 97,97% | 97,88% |
| IoU ≥ 0,50 / 23 referências | 16 | 15 |
| IoU médio das caixas candidatas | 0,6276 | 0,5989 |
| Erro mediano entre centros de caixas | aproximadamente 10 px | 10,0344 px |
| Relógio | nominal, frame/fps | PTS do ffprobe |
| Frames incertos | 294 | 308 |
| Frames sem candidato | não separados no relatório V1 | 0 |
| Tempo de execução | 452,82 s, ambiente Colab anterior | 467,51 s, CPU local |

Os tempos foram medidos em ambientes diferentes e não permitem concluir ganho ou perda de desempenho. A V2 alcançou 31,05 frames/s nesta execução, enquanto outros builds/testes também rodavam no computador.

A integração **não demonstra melhora de acurácia**. As caixas dos outros 22 frames coincidem numericamente com as da V1. A diferença está no frame 6660: a associação temporal escolheu um candidato distante e o reteve como `uncertain`, com IoU 0 e erro entre centros de aproximadamente 277,33 px. Esse candidato é excluído de métricas. Nos 23 frames, 22 foram aceitos como observados e um ficou incerto; 15 dos aceitos passaram IoU50. Não se deve ajustar parâmetros nesses frames e depois anunciar validação independente.

Os sete frames prioritários 4066, 4100, 4131, 4204, 4310, 6120 e 12240 continuam abaixo de IoU50. A referência de caixa completa inclui cauda em alguns exemplos; a segmentação mede caixa corporal. Esse conflito de definição não deve ser corrigido inflando caixas. É necessária referência humana coerente de corpo/centro para avaliar a medida que alimentará a trajetória.

Configuração: CPU, largura de processamento 960 px (escala 0,5), máscara exata sem dilatação externa; HSV V mínimo 80 e S mínimo 25, Lab b mínimo 135, área corporal entre 280 e 72.000 px² originais, densidade mínima 0,12, velocidade máxima de 0,21 diagonal/s, readquisição após 0,5 s e margem de ambiguidade 0,4. São valores exploratórios específicos da gravação. A configuração detalhada está no manifesto de execução.

As contagens desta tabela são recalculadas a partir de `observationState` em cada linha de `samples.jsonl`. O primeiro relatório da execução ainda usava o contador legado que incluía candidatos incertos em cobertura; o contador para novas execuções V2 foi corrigido. O relatório bruto original foi preservado, sem reescrita.

## Artefatos locais e reprodução

Os resultados volumosos estão em `artifacts/ram-color-v2-diagnostic/`, ignorado pelo Git: manifesto, solicitação, PTS/observações por frame, máscara transitável, máscaras por frame e CSV/JSON comparativo. Vídeo e anotações humanas originais permanecem fora do código-fonte. O pacote recebido tem SHA-256 `5cee5bfd5afff8530080853dcaa4b6ba8ade9036f162473847b7d28fa083a6da`; o CSV de referências tem SHA-256 `8cdf16e88babd0145e7dfe153ab5bb4b227fa275bcbee94a00121665b0f4ec2d`.

Para comparar uma execução concluída, sem copiar anotações para o código:

```sh
python3 scripts/compare-ram-color.py --package CAMINHO_DO_PACOTE.zip --run DIRETORIO_DO_JOB --output DIRETORIO_DE_COMPARACAO
```

O script recusa hashes de vídeo divergentes, referências não aprovadas, jobs incompletos, índices ausentes/duplicados e relógio não crescente. Não utiliza os 14.514 candidatos V1 como ground truth. As métricas de eventos/recompensa não foram validadas com esses 23 frames esparsos.

## Verificações e limites de entrega

- Verificação final: 114 testes TypeScript, 123 Python e 87 Rust passaram; build React e bundle macOS de debug concluídos. Os testes incluem regressões de OFT/FST, referências antigas, lacunas, ausência de observação, máscara, parâmetros por sessão, migração e auditoria de correções, hashes, cancelamento e cache offline.
- Navegação da tela RAM e revisão de 14.514 frames conferidas no Chrome, com chamadas Tauri simuladas; 24 referências dos braços disponíveis. Splash removido e root interativo. Isso não valida interação no Tauri instalado.
- O bundle local macOS de debug foi gerado e inspecionado sem `.pth`/`.pt`/`.onnx`, preservando YAML, manifesto, FFmpeg e ffprobe. Não é um instalador de distribuição assinado.
- Registry e recursos pequenos verificados sem exigir checkpoints locais. Metadados públicos da release confirmaram tamanhos e SHA-256 dos dois pesos.
- A geometria completa e os eventos foram testados com fixtures; este vídeo só possui máscara e potes, sem referências humanas de braços/gates. Não foram inventadas referências nem calculados erros de memória para esta gravação.
- Falta checkpoint e contrato de inferência MobileNetV3 V7 no pacote e nos arquivos locais encontrados. O módulo de evidências é independente; inferência e revisão específica de recompensa não foram entregues.
- Faltam validação independente em outra gravação, execução real do fluxo neural no Colab após a mudança e instalação/interação nos quatro sistemas de destino. Não há declaração de validação científica.
