# Piloto de validação local

## Referência humana

O [manifesto do piloto](validation-pilot-2026-11-18.json) seleciona 300 frames e 20 clipes de quatro segundos entre cinco arquivos de vídeo disponíveis. O vídeo `oft_02` é o holdout de gravação inteira. O arquivo RAM disponível é um trecho curto, e a seleção não equivale a três sessões completas por protocolo. As categorias de locomoção, imobilidade, rearing, mudança de direção e oclusão precisam ser conferidas e atribuídas por pessoas; o plano atual usa apenas estratos temporais.

Na página de resultados do experimento, abra **Referência humana**. Selecione o manifesto JSON e o vídeo original do experimento. O editor verifica SHA-256, protocolo e dimensões; depois oferece os frames isolados e os frames completos de cada clipe. Clique no ponto anatômico, escolha visibilidade e salve como rascunho ou envie à revisão. Outro identificador de revisor aprova ou rejeita. Dois identificadores de anotador podem registrar o mesmo ponto independentemente. A identidade é declarada no formulário, sem autenticação pessoal; a auditoria científica deve conferir quem usou cada identificador.

Peça aos anotadores que trabalhem sem consultar as predições do rastreador; o editor esconde a sobreposição automática, mas não controla o que foi visto fora dele. Defina antes da coleta quais keypoints e regras de oclusão cada protocolo usa, e registre divergências entre observadores antes da adjudicação.

As referências são salvas em tabelas SQLite próprias, com histórico de versões e bloqueio de revisão desatualizada. A exportação CSV/JSON inclui o estado atual de cada anotação; **Exportar histórico** gera as revisões anteriores em outro JSON. Nenhuma predição ou correção automática é mostrada sobre o vídeo do editor de referência. O arquivo de vídeo é lido inteiro em memória para calcular o hash no navegador; arquivos grandes podem exigir memória adicional nessa etapa.

## Comparação de filtros

```bash
python3 scripts/compare-pose-filters.py \
  --pose POSE_CANONICA.csv \
  --reference REFERENCIA_HUMANA.csv \
  --video-sha256 SHA256_DO_VIDEO_ORIGINAL \
  --annotator OBSERVADOR_1 \
  --output comparacao.json
```

O comparador preserva os CSVs de entrada e escreve JSON, CSV resumido, CSV por frame pareado e Markdown. MAE, RMSE e PCK@5/10 px usam somente referências humanas visíveis, aprovadas por outro identificador e presentes nas três variantes no mesmo frame. Quando houver dois observadores aprovados no mesmo ponto, `--annotator` é obrigatório. Confira separadamente que a pose pertence ao vídeo indicado: o CSV canônico de pose atual não contém SHA-256 do original. PTS divergentes interrompem a comparação. Sem referência aprovada, essas métricas ficam indisponíveis. Jitter, saltos e lacunas são indicadores descritivos, não prova de erro anatômico.

Os 20 clipes permitem anotar sequências contínuas. Erro temporal de eventos continua indisponível até existirem rótulos humanos aprovados de início/fim de rearing, entradas, natação ou outros eventos e um comparador correspondente. O One Euro permanece experimental e fora das métricas científicas do aplicativo.

## Benchmark do motor OpenCV

```bash
python3 scripts/benchmark-opencl.py \
  --case ID:VIDEO_ORIGINAL.mp4:CONFIGURACAO.json \
  --case OUTRO_ID:OUTRO_VIDEO.mp4:OUTRA_CONFIGURACAO.json \
  --python PYTHON_COM_OPENCV \
  --warmups 1 --repeats 2 --versions both \
  --output benchmark.json
```

Cada braço executa o vídeo completo em sequência: motor em `HEAD` e atual, OpenCL solicitado ou desligado, um aquecimento e duas medições. Perfis adicionais da versão atual coletam P95 por frame e tempo por etapa. O JSON registra versões/hash do código, vídeos e configurações, ambiente, saídas pareadas, cobertura e recursos; os CSV de execuções e de comparações pareadas, junto ao Markdown, facilitam inspeção. A comparação de tempo inclui todas as diferenças entre `HEAD` e a árvore atual. `OpenCL solicitado` só significa GPU usada quando `computeBackend` confirmar suporte efetivo. O benchmark não usa Colab nem mede precisão anatômica.

Os parâmetros do caso `oft_03` vêm de uma execução OpenCV local existente. Para `oft_01` e `oft_02`, a geometria veio dos registros de experimento e o limiar de segmentação foi escolhido por inspeção visual; esses casos comparam o motor sob uma configuração fixa, sem alegar reproduzir execuções locais anteriores.

No aplicativo, a análise local usa CPU por padrão. A opção manual de OpenCL é experimental e só aparece habilitada quando o ambiente detecta uma GPU OpenCL utilizável. A habilitação automática depende de benefício consistente medido em mais máquinas.

### Resultados desta máquina

O [benchmark completo](validation-engine-opencl-2026-11-18.json) executou três vídeos reais inteiros, com uma passagem de aquecimento e duas medidas por braço. A GPU OpenCL ativa fora do sandbox era Intel Iris Pro. Os tempos abaixo são medianas da execução completa, com perfis adicionais fora da comparação de tempo.

| Vídeo | Frames | `HEAD` CPU | Atual CPU | Mudança CPU | Atual OpenCL | OpenCL versus CPU atual | Observação válida no atual |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `oft_01` | 7.610 | 24,54 s | 18,45 s | −24,8% | 34,93 s | +89,3% | 50,37% |
| `oft_02` | 4.438 | 25,25 s | 21,60 s | −14,4% | 32,69 s | +51,4% | 0% |
| `oft_03` | 7.356 | 58,69 s | 46,90 s | −20,1% | 67,35 s | +43,6% | 90,95% |

No vídeo `oft_02`, a configuração original selecionou a parede brilhante em vez do animal. Todos os frames ficaram de baixa confiança; o tempo ainda é uma medição técnica, mas a cobertura de 0% impede usá-lo para julgar qualidade do rastreamento. Uma tentativa exploratória com caixa inicial e região de chão produziu alguns frames válidos, porém a maioria seguiu incerta; não houve ajuste adicional sem referência humana.

Nos vídeos `oft_01` e `oft_02`, as coordenadas pareadas da versão atual foram idênticas entre CPU e OpenCL. Em `oft_03`, 62 de 7.046 coordenadas pareadas mudaram nas duas repetições: 49 entre observações válidas, com diferença máxima de 3,5 px; a maior diferença geral, 52,5 px, ocorreu em previsão de baixa confiança. Os estados por frame permaneceram iguais. Nenhuma dessas diferenças demonstra acerto ou erro anatômico sem referência humana. A evidência desta máquina não sustenta ativação automática de OpenCL.

## Próxima coleta

Anotar e revisar um subconjunto por dois observadores; conferir concordância antes de congelar os rótulos; reservar o holdout até encerrar escolhas de parâmetros. As 300 imagens e 20 clipes são um piloto de fluxo, não uma amostra cuja suficiência estatística esteja demonstrada. Para medir erro temporal, acrescentar rótulos independentes e aprovados de eventos nos clipes.
