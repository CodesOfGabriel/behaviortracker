# BehaveTracker

Aplicativo desktop para analisar um rato por vídeo no teste de campo aberto. O vídeo é enviado ao Google Colab para inferência com DeepLabCut; a revisão dos pontos, a calibração da arena, as métricas e os resultados ficam no dispositivo.

## Fluxo atual

1. Crie um experimento, selecione o vídeo e marque separadamente a borda superior e o chão da arena.
2. Conecte sua Conta Google na tela **Processamento**. A conta precisa oferecer um runtime A100 ou H100 para a adaptação usada aqui.
3. Clique em **Analisar no Colab**. O app prepara uma cópia sem perda quando ela é menor e verifica a equivalência dos frames antes do envio. O arquivo original não é alterado.
4. Acompanhe os checkpoints em **Execuções**. Ao terminar, abra **Revisar vídeo** para inspecionar pontos, corrigir frames e conferir as métricas. O vídeo rotulado mostra caixas do detector e pontos com `likelihood ≥ 0,50`.
5. Exporte `experiment.json`, `poses_reviewed.csv`, `corrections.jsonl` e `metrics.csv` em **Resultados**.

A inferência usa o SuperAnimal TopViewMouse (`hrnet_w32` e `fasterrcnn_resnet50_fpn_v2`) com `video_adapt=True`, `batch_size=4`, `detector_batch_size=2`, `pseudo_threshold=0.1`, `bbox_threshold=0.9` e uma época para detector e pose. Esses são os parâmetros do Teste B do notebook `Diagnostico_DeepLabCut_Wistar_A100_COMPLETO.ipynb`. O app importa explicitamente o HDF5 gerado **após** a adaptação e recusa a análise quando a contagem de frames não coincide com a do vídeo.

O trajeto da **versão C** parte das coordenadas do Teste B. O centro corporal usa até três pontos estáveis do tronco e da base da cauda, quando disponíveis no modelo. Pontos com `likelihood < 0,60` não entram nesse centro; são necessários pelo menos dois pontos confiáveis para que ele seja válido nas métricas. Um filtro de mediana e desvio absoluto mediano (MAD), em janela de até sete frames válidos e pelo menos cinco, sinaliza picos isolados; um filtro temporal ponderado de três frames reduz oscilações nos trechos válidos. O filtro não preenche lacunas, não usa detecções recuperadas como evidência e preserva as coordenadas brutas do modelo adaptado. No editor e nos resultados, **Versão C · revisável** mostra o trajeto filtrado e eventuais correções humanas; **Teste B · bruto** mostra a referência anterior ao pós-processamento. As métricas e o gráfico acompanham a seleção.

## Limites e validação

O Teste B anexado gerou 7.356 frames e 82,2% tinham ao menos um dos 27 pontos com `likelihood ≥ 0,50`; no Teste A foram 7.349 frames e 36,2%. Essa medida é cobertura de pontos, **não** acurácia anatômica. Os limiares e o filtro da versão C são regras iniciais de qualidade, não validação científica. Pontos ocultos e postura de rearing exigem revisão humana; o app não classifica comportamentos.

Build TypeScript, testes locais e contrato da inferência com modelo simulado verificam o fluxo de código. Uma execução completa do app nesta versão com uma conta Colab A100/H100 e um vídeo real ainda precisa ser confirmada. A disponibilidade da GPU e as cotas dependem da conta Google.

## Desenvolvimento

```sh
npm install
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

O app usa Tauri 2, React, TypeScript e Vite. FFmpeg/ffprobe são necessários para preparar e verificar o vídeo. Os comandos de análise local, teste híbrido, teste curto de rastreamento e treino personalizado não estão disponíveis. Dados de execuções anteriores são mantidos para leitura e revisão.
