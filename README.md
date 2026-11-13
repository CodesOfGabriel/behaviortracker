<p align="center">
  <img src="public/behavior-tracker-banner.png" alt="Behavior Tracker — análise do comportamento de roedores" height="220">
</p>

# Behavior Tracker

Aplicativo desktop para análise de vídeos de **Campo Aberto** e **Nado Forçado** em roedores. A inferência é executada em um runtime Google Colab com GPU conectado à conta do pesquisador. Experimentos e resultados são mantidos no dispositivo.

Desenvolvido por **Gabriel Santos** e **Thiago Vargas**, em parceria entre o **Laboratório Neurocell** e o **NeuroLab da Universidade Federal de Pelotas (UFPel)**.

## Instalação e requisitos

- Use o instalador do aplicativo correspondente ao sistema: Windows x64 (`.exe`), macOS Intel ou Apple Silicon (`.dmg`), Linux x64 (`.deb` ou `.AppImage`). Quando publicada, a versão do aplicativo estará em [Releases](https://github.com/CodesOfGabriel/behaviortracker/releases). A release do bundle Wistar contém modelos, não um instalador.
- É necessária uma conta Google autorizada no projeto OAuth do aplicativo, com acesso ao Colab e a um runtime com GPU CUDA. A disponibilidade da GPU e as cotas dependem da conta.
- `ffmpeg` e `ffprobe` permitem o preparo e a verificação local dos vídeos. Se não estiverem disponíveis, o aplicativo pode enviar o arquivo original.
- Guarde o vídeo original e uma cópia dos arquivos exportados. O aplicativo não sincroniza experimentos entre computadores.

## Procedimento

1. Em **Novo experimento**, escolha o protocolo, identifique os sujeitos e selecione um vídeo que o aplicativo consiga reproduzir.
2. Para **Campo Aberto**, marque os quatro cantos da borda superior e os quatro cantos do piso; informe as dimensões reais do piso em centímetros e a área central. Para **Nado Forçado**, delimite uma região fixa que cubra cada cilindro da abertura ao fundo.
3. Em **Processamento**, salve os dados do pesquisador e conecte a conta Google. Abra **Análise Completa** do experimento e selecione **Analisar no Colab**.
4. Após a execução, confira o vídeo, os indicadores e os intervalos com dados insuficientes. Se houver várias execuções, selecione a que será interpretada. Exporte os arquivos da execução analisada.

## Protocolos e resultados

| Protocolo | Inferência | Resultados principais |
| --- | --- | --- |
| **Campo Aberto** | Bundle `wistar_df_v2`: detector Wistar D+F e DeepLabCut/HRNet com 27 pontos; método `oft-0.2`. | Trajetória, distância válida, velocidade, ocupação do centro e da periferia, cobertura temporal e MP4 de inspeção quando disponível. |
| **Nado Forçado** | DeepLabCut SuperAnimal Quadruped/HRNet com 39 pontos, para um ou dois animais em regiões fixas; método `fst-0.1`. | Presença, cobertura anatômica, movimento relativo, alteração de silhueta, intervalos com dados insuficientes e MP4 de inspeção quando disponível. |

No Campo Aberto, as medidas em centímetros usam a geometria do **piso**, enquanto a borda orienta o recorte visual enviado ao modelo. As exportações incluem `experiment.json`, `poses_raw.csv`, `poses_reviewed.csv`, `metrics.csv` e `corrections.jsonl`; `metrics_raw.csv` e o MP4 aparecem quando disponíveis. Coordenadas brutas e revisadas permanecem separadas.

No Nado Forçado, a presença visual e a confiança dos pontos anatômicos são registradas separadamente. O aplicativo **não classifica automaticamente** imobilidade, natação ou escalada: o campo de comportamento permanece `NOT_CLASSIFIED`. Os rótulos de comportamento são anotações humanas por intervalo e sujeito. As exportações da execução incluem poses, presença, atividade, caixas, manifesto e relatório; consulte o [contrato técnico do FST](docs/FST_CONTRACT.md) para os campos e arquivos.

## Interpretação e controle de qualidade

- Cobertura de pontos ou tempo válido indica disponibilidade de dados; **não mede acurácia anatômica**. Inspecione o MP4 e os frames relevantes antes de comparar grupos.
- No Campo Aberto, frames sem referência anatômica válida não são preenchidos para calcular distância ou velocidade. Métricas com baixa cobertura são parciais.
- Tempo no centro e imobilidade operacional são indicadores quantitativos; sua interpretação depende do protocolo e da revisão do vídeo.
- No Nado Forçado, presença incerta não equivale a ausência nem a imobilidade. Movimento e silhueta são indicadores observados para revisão, não rótulos comportamentais.
- Os indicadores ainda exigem validação com vídeos de referência e revisão manual de frames em execuções reais no Colab antes de fundamentar conclusões científicas.
