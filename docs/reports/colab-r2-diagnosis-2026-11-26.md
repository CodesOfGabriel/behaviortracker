# Diagnóstico do tracking Colab — Teste R2

## Resultado

O usuário confirmou que o Teste R2 corresponde a `openfield02.mp4`. A execução examinada é `86a0ac49-483b-4f99-8554-94b169cb9e5c`, concluída no Colab com `wistar_df_v2` e CUDA. Foram auditados os artefatos salvos, sem executar nova inferência ou treinamento e sem modificar o experimento.

O principal problema encontrado é a baixa cobertura de pontos anatômicos com confiança suficiente. A presença de caixas é muito superior à disponibilidade da referência anatômica; terminar o processamento não demonstra qualidade da pose.

| Indicador da execução Colab | Resultado |
|---|---:|
| Quadros / resolução / taxa | 4.438 / 900 × 720 / 16 FPS |
| Quadros com caixa selecionada pelo detector | 4.382 / 4.438 — 98,74% |
| Quadros sem caixa | 56 — 1,26% |
| Quadros com `mouse_center` marcado `valid`, confiança ≥ 0,60 | 289 / 4.438 — 6,51% |
| Pares consecutivos com centro marcado `valid`, antes de verificar piso/calibração | 223 |
| Pontos anatômicos individuais marcados `valid` | 12.018 / 119.826 — 10,03% |
| Pontos individuais com baixa confiança | 106.296 — 88,71% |
| Pontos individuais ausentes | 1.512 — 1,26% |

Esses percentuais descrevem a saída e os critérios do algoritmo. Não medem acurácia, pois não houve comparação com pontos anatômicos de referência independentes.

## Comparação com a execução local

A execução local `b3ec2ab6-0ec6-48f5-bbba-0f505bdf97e8`, `opencv-box-12`, usa o mesmo vídeo e contém 4.428 quadros aceitos como observados entre 4.438 (99,77%). Ela representa o animal pela silhueta/centro da caixa. A HRNet tenta estimar 27 pontos nomeados. Portanto, o eixo geométrico local e a pose anatômica têm critérios e significados distintos.

Foi comparada a geometria das caixas dos dois motores, sem tratar o resultado local como ground truth. A diferença mediana entre centros foi 26,50 px; a razão mediana entre áreas das caixas Colab, já com margem, e das caixas locais foi 3,73. O detector neural e a segmentação corporal não delimitam necessariamente a mesma região. Esses valores, isoladamente, não permitem escolher qual caixa é correta.

## Inspeção visual e integração

Foram inspecionados os quadros 0, 100, 500, 1.000, 1.500, 2.500, 3.500 e 4.300 com as caixas e os pontos salvos sobre o vídeo original. Nesses exemplos, as caixas acompanham o animal, mas muitos pontos têm baixa confiança e várias posições pouco informativas se acumulam nas bordas/corpo. A inspeção de oito quadros não valida toda a sessão.

O código envia caixas no formato `(x, y, largura, altura)`, compatível com o contexto de caixas da [API DeepLabCut 3.0.2](https://github.com/DeepLabCut/DeepLabCut/blob/v3.0.2/deeplabcut/pose_estimation_pytorch/apis/videos.py). O leitor oficial retorna RGB. Não foi encontrada uma incompatibilidade desses formatos que explique o resultado observado. A correspondência das contagens e os exemplos examinados também não demonstraram um deslocamento temporal sistemático; não constituem auditoria exaustiva do relógio.

O histórico contém outra execução `wistar_df_v2` do mesmo SHA-256 de vídeo com o mesmo checkpoint de pose, e também com cobertura muito baixa de centro. O manifesto atual identifica CUDA e confirma o uso dos pesos esperados. O problema não foi resolvido pela escolha da GPU.

## O que falta para corrigir a pose

A hipótese de dificuldade do modelo com a aparência, iluminação e escala desta gravação é compatível com os resultados, mas sua causa específica ainda precisa ser isolada. Não foi demonstrado que aumentar contraste, trocar GPU ou suavizar coordenadas resolveria a pose. Não foram alterados limiares nem promovidos pontos incertos a medidas válidas.

O próximo trabalho necessário é avaliar a HRNet em um trecho curto com referência anatômica revisada e comparar pré-processamento e checkpoints. Se o desempenho continuar insuficiente, é necessário adaptar/retreinar a pose usando pontos anatômicos anotados e verificar a generalização em sessões separadas. As marcações temporais de rearing têm outro alvo e não fornecem posições de nariz, orelhas, centro e base da cauda.

Ainda não foi corrigida nem revalidada a acurácia do modelo nesta sessão. Esta auditoria identifica a falha observada e preserva os resultados para revisão.

## Evidência local

- [Contagens por ponto e comparação histórica em JSON](../../artifacts/colab-r2-diagnosis-2026-11-26/audit.json).
- [Oito quadros do vídeo com caixas e pontos salvos](../../artifacts/colab-r2-diagnosis-2026-11-26/saved-colab-overlay.png). Verde: caixa Colab; amarelo: ponto abaixo de 0,60; vermelho: ponto com confiança ≥ 0,60. A cor indica score, não confirmação humana da posição.

As contagens de detecções, QC e pose foram confrontadas com o manifesto: 4.438 quadros e 27 pontos por quadro. Foram usados somente consultas de leitura ao armazenamento do aplicativo e arquivos locais. Não houve acesso a credenciais, uso de GPU remota, alteração de pesos, commit ou publicação.
