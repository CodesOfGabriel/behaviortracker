# Eixo corporal local: revisão de máscaras e outliers

Data: 25/11/2026. Execução local em CPU, vídeo de Campo Aberto com 7.356 frames, 24 fps e 1280 × 720. Artefatos de pesquisa ficam em `artifacts/oft-rearing-local/axis-review/`, ignorados pelo Git.

## Problema e correção

A orientação anterior usava uma direção horizontal ou a direção do frame anterior quando a máscara era arredondada. A subtração de fundo também incluía regiões vazias ao lado do animal em algumas silhuetas. Isso permitia desenhar um eixo perpendicular ao corpo.

- O motor `opencv-box-12` mantém as caixas, as silhuetas originais e as features comportamentais. Para o eixo, produz uma máscara adicional apoiada na aparência corporal congelada e nos pixels da imagem atual (`bodyAxisContour`, `bodyAxisEvidence`). Uma máscara sem apoio não volta silenciosamente ao contorno contaminado.
- `body-axis-2` estima a direção no núcleo espesso da máscara, reduzindo a influência de cauda e pontes finas. Máscaras arredondadas, fragmentadas, muito côncavas ou sem caminho interno contínuo ficam sem eixo.
- O filtro causal compara orientação, área e posição com o histórico recente. Um salto isolado é ocultado; uma mudança persistente precisa de observações coerentes por pelo menos 80 ms. Lacunas, perdas e observações comprometidas reiniciam o contexto.
- A suavização tem atraso angular limitado a 8° e só é usada quando o caminho permanece dentro da máscara atual. Nenhuma coordenada antiga é congelada sobre o animal.
- Interface e MP4 usam os mesmos critérios. O navegador recompõe o contexto dos frames de origem ao buscar um instante, inclusive ao voltar no vídeo. Implementações Python e TypeScript usam rasterização, projeções e desempates equivalentes.
- Vídeos salvos com a sobreposição anterior recebem aviso para **Atualizar MP4**. Uma nova análise é necessária para obter a máscara apoiada nos pixels; atualizar um MP4 antigo aplica apenas os filtros possíveis sobre os contornos já salvos.

## Verificação no vídeo disponível

Reprocessamento separado dos dados originais, em 141,39 s (52,03 frames/s):

| Resultado do eixo | Frames |
| --- | ---: |
| Exibido | 3.263 |
| Máscara muito côncava | 2.455 |
| Imagem atual sem apoio suficiente | 17 |
| Corpo fragmentado | 12 |
| Orientação ambígua | 4 |
| Outlier de área | 1 |
| Observação comprometida ou ausente | 1.604 |
| Total | 7.356 |

A cobertura visual é 44,36%. Os demais frames ficam sem eixo; não são interpolados nem preenchidos com uma orientação anterior. A revisão visual dos casos selecionados confirmou a remoção de eixos atravessando áreas vazias, inclusive em 197,167 s, 204,000 s, 277,500 s e 286,833 s.

A comparação das 7.356 amostras com o reprocessamento anterior encontrou **zero diferenças nos campos originais de tracking**, excluindo os três campos novos do eixo. O guard de intervenção continua suspendendo o tracking em 304,291667 s, confirmado em 304,375 s: os 53 frames seguintes ficam sem caixa e sem eixo.

A comparação Python/TypeScript em todos os frames obteve os mesmos estados, motivos e quantidade de pontos. A diferença máxima entre pontos foi 2,28 × 10⁻¹³ px; buscas com contexto recomposto diferiram em no máximo 3,70 × 10⁻¹² rad. Isso verifica consistência de implementação, não acurácia anatômica.

Artefatos locais:

- `skeleton-filtrado.mp4`: vídeo completo para revisão.
- `comparacao-final.png`: amarelo = eixo anterior; ciano = eixo novo; verde = máscara apoiada na imagem. Ausência de ciano significa eixo ocultado.
- `tracking/samples.jsonl`, `tracking/status.json`: execução isolada.
- `validation.json`, `parity.json`, `render-report.json`, `video-validation.json`: evidências das verificações.

## Verificação automatizada

- Build de produção e TypeScript da aplicação e dos testes de interface aprovados.
- 200 testes Vitest aprovados, incluindo recomposição do filtro em vídeos de baixa frequência.
- 230 testes Python executados: um skip específico de Windows; demais aprovados. Após os últimos ajustes numéricos, as 17 regressões do eixo e da renderização foram repetidas.
- 96 testes Rust aprovados, incluindo o empacotamento do módulo.
- 42 testes de interface aprovados em Chromium e WebKit, incluindo reprodução, busca pausada e rejeição de um eixo perpendicular isolado. As quatro verificações de sincronização foram repetidas na build final.
- 12 testes da barreira de qualidade aprovados; `git diff --check` limpo.

## Limites

O resultado é um **eixo geométrico estimado**, sem identificação de cabeça, patas ou cauda. As 40 marcações de ápices de rearing não são anotações de pontos anatômicos e não permitem medir erro de pose. Não há estimativa de PCK, erro angular contra referência humana, precisão anatômica nem validação independente de generalização. A cobertura conservadora deixa trechos sem desenho mesmo quando um pesquisador consegue distinguir o corpo.

Os checks de navegador simulam a fronteira IPC; não substituem a conferência do aplicativo Tauri instalado. Nenhum instalador foi gerado ou publicado nesta revisão, e nenhum resultado original no banco do aplicativo foi substituído.
