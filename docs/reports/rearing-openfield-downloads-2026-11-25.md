# Teste de rearing em openfield01 e openfield02

Teste local em CPU, em 25/11/2026, com os MP4 completos de Downloads. Artefatos em `artifacts/oft-rearing-local/downloads-openfield-test/`, ignorados pelo Git. Os vídeos originais e os registros do aplicativo foram preservados.

| Vídeo | Resolução | Taxa | Duração de vídeo | Frames processados | Propostas de ápice |
| --- | --- | --- | --- | ---: | ---: |
| openfield01.mp4 | 586 × 480 | 25 fps | 304,400 s | 7.610 | 0 |
| openfield02.mp4 | 900 × 720 | 16 fps | 277,375 s | 4.438 | 1 |

O candidato de openfield02 está no **frame 357, em 22,3125 s**, com score **0,349890**. O modelo propôs `REARING_SUPPORTED`, mas isso permanece uma proposta pendente de revisão. O score não é uma probabilidade calibrada.

## Modelo e condições

Foi testado o modelo treinado de **ápices** `oft_rearing_apex_v1`, versão `local-1`, em `artifacts/oft-rearing-local/session-03/model/`. Ele usa geometria, movimento e textura do recorte. O limiar foi mantido em **0,275**, sem treinamento, ajuste de limiar ou seleção de parâmetros usando estes dois vídeos. A arquitetura temporal de `models/oft_rearing_v1/manifest.json` continua sem pesos treinados; não foi usada como se fosse um detector disponível.

O modelo de ápices foi treinado com 40 marcações em um único outro vídeo. Os SHA-256 dos dois MP4 diferem do arquivo de treinamento; isso não demonstra independência de animais. Não há medição de duração de episódios.

- openfield01: calibração previamente salva para o mesmo SHA-256 do vídeo.
- openfield02: chão e borda delimitados visualmente no frame original para este teste. Essa delimitação não foi aprovada para métricas científicas; nenhuma escala física foi assumida.
- Rastreamento: `classical_roi_v1`, `opencv-box-12`, execução isolada dos resultados salvos no aplicativo.
- Não houve interrupção pelo guard de intervenção externa em nenhum dos dois testes.

O rastreamento aceitou observações em 85,69% dos frames do openfield01 e 99,77% do openfield02. A fração com observação válida no piso foi 45,69% e 12,19%, respectivamente. **Essas porcentagens descrevem o rastreamento e a geometria; não são precisão de rearing.** Observações perto da parede não equivalem a rearing com apoio.

## Conferência visual e limites

Além do único candidato, foram inspecionadas oito janelas de dois segundos em cada vídeo, escolhidas por tempos fixos sem consultar as previsões. Essa é uma revisão amostral, não anotação exaustiva nem referência humana de validação.

No candidato de 22,3125 s, o animal muda de orientação na região inferior esquerda. A elevação e o contato das patas não são conclusivos nos recortes examinados. O candidato não foi confirmado automaticamente como rearing com apoio.

Os trechos 44–46 s do openfield01 e 9–11 s do openfield02 foram separados como possíveis mudanças de postura junto à parede para revisão do pesquisador. Sem anotações independentes, não são contabilizados como falsos negativos.

**O teste não demonstra detecção confiável de rearing nesses vídeos. Zero/uma proposta não significa zero/um episódio verdadeiro.** Precisão, sensibilidade, F1, contagem verdadeira e erro de duração permanecem sem estimativa.

## Evidências e arquivos

Cada pasta `openfield01/` e `openfield02/` contém:

- `candidates.csv` e `candidates.json`: propostas, timestamps de origem e scores; o CSV do openfield01 contém somente o cabeçalho.
- `<nome>-rearing-propostas.mp4`: vídeo completo com relógio de origem e destaque das propostas. O destaque de ±0,4 s facilita localizar o ápice; não representa duração do comportamento.
- `tracking/`: solicitações, amostras por frame, referência de fundo e estado terminal do motor.
- `coverage-review-01.png`, `coverage-review-02.png`: janelas escolhidas por tempos fixos.
- `visual-review-01.png`: contexto de ±1 s do candidato, quando existente.

Na raiz, `test-report.json` registra a auditoria dos 12.048 frames, dos hashes do modelo/código/entradas, dos CSVs e dos MP4. `qualitative-review.json` registra as observações visuais e a ausência de confirmação humana. `setup.py`, `infer.py`, `review.py`, `coverage_review.py` e `audit.py` registram a sequência executada para reprodução local.
