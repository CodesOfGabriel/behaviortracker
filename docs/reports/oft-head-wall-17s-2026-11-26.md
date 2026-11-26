# Cabeça sobre a parede e visualização sem textos

## Reprodução aos 17 segundos

O quadro 272 do R2 (`openfield02.mp4`, 16 fps) reproduziu o corte relatado. A área de tracking já continha a parede, mas a máscara do corpo começava em aproximadamente `(232, 165)`. O baixo contraste da cabeça com a parede e a referência congelada separavam a cabeça do componente forte do tronco. Abrir a região da arena, sozinho, não resolvia esse caso.

A segmentação OpenCV compartilhada passou a reconstruir a extensão conectada em uma região pequena ao redor do corpo atual. Uma máscara com limiar mais baixo, limitado pelo ruído da referência, recupera os pixels de baixo contraste. Uma faixa estreita é conservada nos dois lados da linha do chão para não cortar o pescoço nessa linha. A recuperação exige conexão espacial, tamanho e espessura compatíveis, aparência e limites da imagem. Ela não inicializa identidade por uma mancha isolada na parede. As restrições de RAM e FST permanecem separadas.

A inspeção dos quadros seguintes encontrou uma segunda restrição aos 17,5 s: o tamanho do fragmento forte sobre o chão não comportava a cabeça de baixo contraste. A região e os limites da recuperação agora usam também a mediana da área corporal observada anteriormente. Um fragmento atual apoiado no chão pode recuperar a silhueta mesmo após uma lacuna de identidade, sem dispensar o consenso de reaquisição. No quadro 280, a caixa local passou de `(230,63; 164,53; 35,16; 19,69)` para `(202,50; 136,41; 68,91; 50,63)`. A orientação local desse quadro continua ambígua por concavidade: a recuperação da caixa não obriga a desenhar um skeleton ou uma cabeça sem direção confiável.

No quadro indicado, a nova caixa do corpo é `(217,97; 149,06; 78,75; 42,19)` em pixels `(x; y; largura; altura)`. Ela abrange a cabeça visível acima e à esquerda do chão. As detecções neurais originais continuam separadas: o fluxo Colab usa a mesma recuperação da silhueta, sem cortar a máscara à caixa neural histórica.

Após determinar o sentido do corpo pela evidência da cauda e pela continuidade limitada, o marcador da cabeça usa a parte distal da silhueta completa, em vez da extremidade do eixo robusto do tronco. A posição da parede, sozinha, não atribui uma direção anatômica. A orientação permanece uma estimativa para revisão, com `metricEligible: false`.

`orientation.headRegion` registra `floor`, `wall_projection` ou `unknown`. Aos 17 segundos, os dois caminhos registram a cabeça em `(229, 163)` e `headRegion: wall_projection`. Essa região descreve a projeção 2D; não mede altura nem confirma rearing automaticamente.

## Marcadores

Na interface e nos exportadores de Campo Aberto, a cabeça aparece como triângulo vazado discreto e a base da cauda como círculo pequeno. O eixo corporal continua visível. Foram retirados os nomes dos pontos, os avisos escritos, os cabeçalhos e os gráficos sobre a imagem. A origem, a incerteza e as propostas comportamentais permanecem nos dados; os marcadores conservam descrição acessível sem texto pintado no vídeo. As explicações ficam fora do player.

O Canvas deixa de desenhar os pontos canônicos uma segunda vez sobre o skeleton das camadas. Os rótulos de caixa e de ponto selecionado também ficam ocultos na imagem de Campo Aberto. Os outros protocolos conservam seus rótulos específicos.

Versões: `opencv-box-15`, política `connected_wall_foreground_v2`, vídeo local `local-audit-7` e MP4 Wistar `oft-layered-video-4`. Os marcadores de versão permitem atualizar vídeos salvos. O Wistar local também materializa os módulos atuais ao atualizar seu MP4. As análises OpenCV antigas conservam suas observações; uma nova análise é necessária para recalcular a máscara e as posições.

## Verificação

A regressão sintética inclui cabeça e pescoço com baixo contraste sobre uma parede, uma mancha desconectada, cauda fina e recuperação após lacuna com fragmento pequeno no chão. Confere a recuperação da caixa, a posição da cabeça fora do chão, a manutenção da inelegibilidade para métricas e a ausência de textos. A direção anatômica é fornecida explicitamente no teste isolado de recuperação da cabeça; os testes independentes de orientação exercitam a evidência real de cauda em duas polaridades e oito ângulos.

Foram executadas as análises completas de R2 em CPU e a geração dos MP4s nos dois caminhos. O adaptador Colab usa as detecções salvas, sem nova inferência neural ou sessão GPU. Os artefatos e verificações estão em `artifacts/colab-continuity-2026-11-26/head-wall-17s/final/`, ignorados pelo Git, com quadros 264, 272, 280 e 288 para inspeção. A verificação exige 4.438 quadros decodificados, caixa incluindo a cabeça aos 17 s, marcador triangular, ausência de texto e preservação dos hashes do vídeo e do CSV originais.

A suíte Python passou com 324 casos, incluindo um teste exclusivo do Windows ignorado no macOS. Passaram 224 testes de frontend, build e checagem de tipos dos testes, além de seis regressões de tracking em Chromium e WebKit. O frontend foi conferido com um worker para não disputar os recursos dos dois processamentos de vídeo completos. Foram conferidos também o empacotamento Python remoto/nativo e os marcadores de versão em testes Rust. Os testes não estabelecem acurácia anatômica independente; não existem posições manuais de cabeça/cauda para calcular esse erro no R2.
