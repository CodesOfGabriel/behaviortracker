# Campo Aberto: caixa corporal sobre as paredes

O chão calibrado define a projeção usada pelas métricas de locomoção. Ele deixou de limitar a imagem entregue ao detector e a extensão da caixa corporal. A correção vale para OpenCV local, Wistar local e Wistar no Colab.

## Causas corrigidas

- A recuperação do detector no Colab tinha uma tentativa com imagem mascarada apenas pelo chão. Essa tentativa podia retornar uma caixa da parte inferior do animal. As tentativas agora conservam toda a região visível, com recuperação em escalas de 960 e 1.280 pixels.
- O Wistar local desativava a política de precisão GPU, o que também acabava desativando as paredes na máscara padrão. A região de tracking agora tem uma política própria, separada da configuração de GPU e explicitamente desativada para RAM.
- O OpenCV usava apenas o chão quando faltava a borda superior. Agora o tracking usa a união convexa entre chão e borda, com margem visual de 5%. Sem borda marcada, conserva a imagem completa. O chão original e as regiões de oclusão permanecem preservados.
- O exportador dava preferência à caixa neural, mesmo quando a silhueta observada ultrapassava essa caixa. A caixa visual e a caixa exportada no CSV passam a abranger a união entre a detecção e a silhueta associada. A detecção original continua separada em `detectorBox` e no CSV de detecções; a referência de medida não é substituída por coordenadas previstas.

A associação da silhueta considera a área menor na interseção com a caixa neural, permitindo recuperar um corpo observado maior que uma detecção histórica cortada no chão. A continuidade, a aparência, a ambiguidade e os filtros de forma permanecem ativos. Depois de associar a identidade, estar sobre a parede não reprova o tracking por falta de sobreposição com o chão. Uma silhueta sobre a parede continua classificada como `boundary` ou `wall_projection`, fora dos pares automáticos de velocidade no piso.

O guarda de intervenção usa a mesma região visual e não considera a linha do chão como limite externo da caixa. O encerramento por intrusão continua latched; trata-se de um guarda visual conservador, sem classificação semântica de mãos.

## Versões e resultados existentes

OpenCV: `opencv-box-14`. Política de caixa: `observed_detector_silhouette_union_v1`. MP4 Wistar: `oft-layered-video-3`.

Novas análises usam a correção. Para MP4s antigos, **Vídeos → Atualizar MP4** reconstrói a geometria visual a partir do vídeo e das detecções salvas, quando necessário. O marcador de versão permite atualizar também os MP4s da versão anterior. A atualização do vídeo preserva o CSV original; atualizar os dados completos de uma análise antiga exige uma nova execução.

## Verificação

Os testes usam uma silhueta sintética que sobe acima do chão, uma caixa neural histórica contendo apenas a parte inferior e um vídeo real gerado por FFmpeg. Conferem a extensão da caixa, os nós do skeleton fora do chão, o CSV e o MP4, a ausência de borda superior, a união em perspectiva, as oclusões e a exclusão de pares de velocidade sobre a parede. Um teste do detector confere os pixels da parede em cada tentativa de inferência. As redes neurais desse teste são simuladas; ele não mede acurácia do checkpoint.

A suíte de 320 testes Python passou, com um teste exclusivo do Windows ignorado neste macOS. Os nove testes do renderizador foram conferidos após acrescentar a regressão dos pares de velocidade sobre a parede. Os testes Rust de empacotamento remoto/nativo e de versão dos MP4s também passaram.

O R2 completo foi processado em CPU nos dois caminhos. O adaptador Colab recebeu as detecções salvas, sem executar novamente o detector ou usar GPU. Os dois MP4s tiveram 4.438 quadros decodificados, 900 × 720 pixels e 16 fps. Em todos os quadros com contorno disponível, a caixa abrangeu esse contorno.

| Disponibilidade observada no R2 | Adaptador Colab | OpenCV local |
| --- | ---: | ---: |
| Quadros com parte do contorno fora do chão | 1.725 | 1.708 |
| Quadros em que a caixa ultrapassou a detecção neural em mais de 1 pixel | 190 | Não se aplica |
| Quadros com eixo utilizável | 4.346 | 4.353 |

São contagens de disponibilidade geométrica, não medidas de acurácia biológica ou confirmação de rearing. As cópias, MP4s, quadros e relatórios estão em `artifacts/colab-continuity-2026-11-26/wall-projection-cpu/`, ignorados pelo Git. O replay completo do guarda atual é registrado em `guard-replay.json` de cada caminho. Os hashes do vídeo de entrada e do CSV original foram conferidos antes e depois, sem alteração. Nenhum job Colab foi iniciado e os arquivos originais do aplicativo não foram substituídos.
