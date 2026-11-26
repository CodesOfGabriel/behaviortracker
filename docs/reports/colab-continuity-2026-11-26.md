# Continuidade do R2: execução 02eca074

O resultado `02eca074-2c5f-4e4d-b7e2-de40b18a3b33` não entrega continuidade anatômica suficiente. As mudanças desta revisão corrigem problemas reproduzidos do detector e acrescentam recuperação visual de lacunas curtas. **Não foi comprovado rastreamento contínuo e preciso no vídeo inteiro.**

Vídeo: `openfield02.mp4`, 900 × 720, 16 fps, 4.438 quadros. SHA-256: `e8cd0c3a5624a4342346fcf56a328e8a86419cf058d27cccf1bea1a6141e51c4`. O usuário confirmou que revisou todos os rearings, mas não tem posições anatômicas marcadas. As marcações temporais não foram convertidas em rótulos de posição nem usadas para validar a anatomia.

As imagens, recortes de vídeo e evidências referenciadas em `artifacts/colab-continuity-2026-11-26/` são locais e ficam excluídos do Git, conforme a convenção do projeto para diagnósticos de pesquisa.

## Diagnóstico reproduzido

| Medida no resultado salvo | Valor |
| --- | ---: |
| Quadros sem caixa observada | 170 |
| Quadros sem nenhum ponto aceito | 1.028 |
| Quadros com `mouse_center` aceito | 289 (6,51%) |
| Maior lacuna do centro | 1.100 quadros / 68,75 s |
| Quadros com todos os 27 pontos aceitos | 0 |

A mudança anterior de resolução interna para 1280 não resolveu o problema. Comparada à execução anterior, perdeu caixas em 118 quadros que antes tinham detecção e recuperou apenas quatro no sentido inverso. Além disso, a máscara fornecida ao detector preservava somente o piso, embora o animal apareça também nas paredes.

## Mudanças aplicadas ao código

- A política de Campo Aberto Colab passa a `hybrid-df-precision-4` (a revisão 3 introduziu as correções do detector; a 4 acrescenta vistas de contexto). O detector volta à escala de treinamento, 640/1280. Preserva piso e paredes visíveis, mantendo polígonos de exclusão. Quando falha, reprocessa os pixels do mesmo quadro com a máscara do piso e, depois, com escala 1280/2048. Cada tentativa fica no CSV de detecções. Não reutiliza uma caixa antiga como nova observação. Retomada após falta de memória mantém a correspondência entre quadros e previsões.
- O refinamento por vistas mantém os controles de desacordo, coordenadas inválidas e saltos. Lacunas curtas podem receber fluxo óptico calculado nas duas direções entre duas âncoras neurais. Cada direção admite no máximo 0,75 s desde sua âncora; trajetórias precisam concordar em até 2 px, com erro de ida e volta de até 1 px, apoio de caixa observada e textura suficiente. Imagens uniformes, ausência de âncora futura, caixas ausentes e trajetórias conflitantes não geram pontos.
- Recuperações são exportadas como `source=recovered`, `status=low_confidence`, motivo `visual_recovery_pending_review`, com a previsão anterior preservada. O vídeo usa círculos vazados e indica revisão. O frontend mostra “Revisar”; métricas não aceitam esses pontos. O renderer também rejeita origens `recovered`/`predicted` nas velocidades, mesmo se um CSV externo as declarar `valid`.
- O manifesto registra cobertura neural e visual separadamente, lacunas por ponto e limites inclusivo/exclusivo dos intervalos. Uma exportação com lacunas não é registrada como cobertura visual completa. Cobertura não representa acurácia.
- O empacotador Colab inclui o módulo de continuidade; o teste executa o empacotador e confere a presença e a sintaxe dos módulos. Resultados existentes e seus arquivos originais permanecem preservados. A nova recuperação não é ativada no processamento local, RAM ou FST.

## Inferência real executada localmente

Foi criado um ambiente temporário isolado com Python 3.9, Torch 2.2.2 e torchvision 0.17.2 para inferência CPU neste Mac Intel. Não houve execução de job Colab/CUDA nem envio de vídeo. Os checkpoints foram conferidos por tamanho e SHA-256.

O arquivo de detector encontrado em Downloads não correspondia ao bundle v2. A comparação com esse arquivo foi descartada. As medidas abaixo usam o detector v2 do manifesto, SHA-256 `211891e0ec5f5b3f56d0f0be5b9255319ce9857284e72e558ccfc9f4ca93eef0`.

| Comparação em 12 quadros difíceis fixos | Caixas selecionadas |
| --- | ---: |
| 640, máscara de piso | 12/12 |
| 640, piso e paredes | 11/12 |
| 1280, máscara de piso | 7/12 |
| 1280, piso e paredes | 10/12 |
| Cascata: 640 com paredes → 640 piso → 1280 com paredes | 12/12 |

Esses testes usam a caixa bruta anterior já salva para manter a condição de associação comparável; não constituem uma execução sequencial nova do vídeo completo. Contagem de caixas não mede falsos positivos nem precisão anatômica. [Saídas de cada inferência](../../artifacts/colab-continuity-2026-11-26/cpu-detector-comparison.json).

Os 12 quadros também foram examinados visualmente com as caixas da cascata. No quadro 215, a recuperação pelo piso produz uma caixa estreita junto à parede: encontrar uma caixa não comprova que o recorte contém toda a anatomia. [Imagens das caixas examinadas](../../artifacts/colab-continuity-2026-11-26/detector-cascade-contact.png).

Na HRNet, foram comparados o checkpoint adaptado e o oficial em nove quadros, com entrada 256, 384 e CLAHE. O modelo oficial não recuperou a cobertura baixa: na configuração original de 256, teve 9/243 pontos acima de 0,60, contra 30/243 do adaptado. Doze rotações adicionais em seis quadros também não resolveram a ausência do centro. Essas contagens não permitem escolher o modelo de melhor acurácia sem referência anatômica. Nenhuma dessas alternativas foi adotada automaticamente. [Comparação HRNet](../../artifacts/colab-continuity-2026-11-26/cpu-model-comparison.json), [rotações](../../artifacts/colab-continuity-2026-11-26/cpu-rotation-comparison.json).

A reprodução da arquitetura usa carregamento estrito dos pesos e o recorte oficial da versão 3.0.2 do DeepLabCut. A comparação inicial com a saída bruta salva diferiu em até 0,000734 de score e 2,90625 px de posição; não é reprodução binariamente idêntica do runtime CUDA.

## Vistas com mais contexto: revisão 4

A continuação comparou seis escalas de recorte (0,65; 0,85; 1; 1,2; 1,5; 2), com e sem CLAHE, em 13 quadros fixos e com o mesmo checkpoint verificado. Recortes maiores deram mais pontos acima do limiar em vários exemplos; isso motivou testar contexto adicional no refinador real. [Sensibilidade ao recorte](../../artifacts/colab-continuity-2026-11-26/cpu-crop-comparison.json).

Na política atual, quando o consenso inicial deixa pontos ausentes, uma segunda chamada infere quatro vistas: contexto 1,5 e 2, cada um original e com CLAHE. Coordenadas voltam à imagem original com a origem específica de cada recorte; nenhum score é elevado. O limiar de 0,60, os dois votos mínimos, a tolerância espacial e a rejeição de hipóteses conflitantes permanecem. Cada chamada continua limitada a quatro vistas; quadros já completos dispensam a chamada adicional. A versão de refinamento passa a `pose-consensus-flow-3`. O custo computacional aumenta nos quadros incompletos.

Foi executado o código dos refinadores anterior e atual, com os pesos reais da HRNet e o mesmo conjunto de imagens/caixas. Apenas a leitura do vídeo foi adaptada para apresentar uma imagem real por execução, evitando tratar quadros distantes como vizinhos temporais.

| Cobertura nos mesmos 13 quadros | Refinador anterior | Refinador com contexto |
| --- | ---: | ---: |
| Pontos aceitos | 67 | 149 |
| Quadros com centro aceito | 4 | 5 |
| Quadros sem nenhum ponto aceito | 3 | 2 |

Houve 82 pontos acrescentados e nenhuma perda dos 67 anteriores nessa amostra. Continuaram oito quadros sem centro; o aumento de cobertura não demonstra acurácia anatômica nem rastreamento contínuo do vídeo completo. O experimento usa caixas salvas, sem uma nova inferência sequencial do detector. [Comparação do código antes/depois](../../artifacts/colab-continuity-2026-11-26/cpu-refiner-context-comparison.json), [imagens comparadas](../../artifacts/colab-continuity-2026-11-26/context-before-after.png).

A avaliação adicional de 64 quadros contíguos (827–890) terminou com caixas congeladas da execução antiga em escala 640. Havia 42 caixas observadas; o centro foi aceito em 38/64 quadros, com uma lacuna final de 25 quadros (1,5625 s). Em 22 quadros não houve nenhum ponto visual. Isso confirma que corrigir somente a pose não resolve a perda do detector. [Sequência com caixas antigas](../../artifacts/colab-continuity-2026-11-26/cpu-context-sequence.json).

A segunda execução local desse mesmo trecho usou também o detector atual, seus pesos reais e o fluxo de seleção/tentativas do código de produção. Encontrou caixas em **64/64 quadros**, todas na primeira tentativa em escala 640 com paredes visíveis. A inspeção de 16 imagens distribuídas pelo intervalo mostra as caixas acompanhando o animal, inclusive na parede. A pose produziu centro em 39/64 quadros; permaneceu uma lacuna final de 25 quadros. Houve um quadro sem nenhum ponto visual, contra 22 na avaliação com caixas antigas. [Saída com detector atual](../../artifacts/colab-continuity-2026-11-26/cpu-context-sequence-new-detector.json), [caixas examinadas](../../artifacts/colab-continuity-2026-11-26/new-detector-sequence-contact.png).

O recorte de entrada foi conferido contra os pixels decodificados do vídeo original: 64 quadros idênticos, em 900 × 720 e 16 fps. Os escritores CSV e o renderer atuais geraram uma [amostra MP4 de quatro segundos](../../artifacts/colab-continuity-2026-11-26/cpu-new-detector-sequence/dlc_labeled.mp4), com manifesto, SHA-256 e contagem de quadros verificados. A amostra usa tempo relativo ao recorte; o quadro inicial corresponde ao 827 (51,6875 s) do vídeo original. Não substitui a análise salva no aplicativo.

Essa avaliação é CPU e usa um adaptador para os quadros decodificados e a arquitetura HRNet verificada; não inicia Colab nem executa o runtime completo DeepLabCut. A presença das caixas nos 64 quadros não comprova acurácia anatômica nem desempenho no vídeo completo.

## Recuperação curta no vídeo inteiro

O módulo de continuidade executou sobre os 4.438 quadros reais e as previsões já salvas. Não houve nova inferência de detector/HRNet nesta etapa.

| Medida | Antes | Após recuperação visual |
| --- | ---: | ---: |
| Pontos aceitos para desenho | 15.265 | 16.312 |
| Quadros com centro desenhável | 289 | 310 |
| Quadros sem nenhum ponto desenhável | 1.028 | 908 |
| Maior lacuna do centro | 68,75 s | 68,75 s |

Os 1.047 pontos acrescentados exigem revisão. A maior lacuna não diminuiu; esta recuperação é insuficiente para atender ao pedido de continuidade total. [Auditoria e integridade do CSV original](../../artifacts/colab-continuity-2026-11-26/saved-r2-continuity.json).

## Rastreador temporal neural em avaliação

Foi executado o CoTracker3 online oficial em CPU, com código e pesos fixados por revisão/hash, sem integrá-lo ao pipeline de produção. As consultas iniciais são quatro pontos da HRNet no quadro 827; não são referências humanas. A inferência de 64 quadros manteve os quatro visíveis em sua própria estimativa. Os 36 quadros com caixa observada tinham os quatro pontos dentro dela; nos outros 28, o detector salvo não forneceu caixa. A inspeção de seis imagens mostra acompanhamento do animal nesse trecho, sem comprovar os nomes anatômicos.

[Auditoria de quatro segundos](../../artifacts/colab-continuity-2026-11-26/cpu-cotracker-comparison.json), [imagens examinadas](../../artifacts/colab-continuity-2026-11-26/cotracker-temporal-overlay.png).

A avaliação ampliada abrangeu os quadros 827–1082, 256 quadros / 16 s. Na estimativa do CoTracker, o centro ficou visível em 256/256 quadros, a base da cauda em 145/256, o quadril esquerdo em 169/256 e o direito em 215/256. Os 201 quadros com caixa observada apoiaram o centro; nos demais 55 a saída salva do detector não tinha caixa. A inspeção ampliada mostra pontos perdidos e deslocados em relação ao animal, apesar do acompanhamento do centro. **Esse rastreador não foi adotado como solução anatômica padrão.** [Resultados completos](../../artifacts/colab-continuity-2026-11-26/cpu-cotracker-256-comparison.json), [imagens da avaliação ampliada](../../artifacts/colab-continuity-2026-11-26/cotracker-256-overlay.png).

CoTracker acompanha os pontos consultados; não fornece por si só os 27 rótulos anatômicos. Visibilidade estimada pelo rastreador, associação à caixa e continuidade temporal não substituem posições revisadas nem comprovam que a inicialização anatômica estava correta.

### Preferência confirmada para posições ocultas

O usuário autorizou mostrar **estimativas identificadas**, para revisão e fora das métricas automáticas. Com as novas caixas presentes nos 64 quadros, os quatro trajetos do teste CoTracker curto (centro, base da cauda e quadris) passam no apoio espacial da caixa em 64/64 quadros. [Conferência dos trajetos contra as caixas atuais](../../artifacts/colab-continuity-2026-11-26/cotracker-current-box-support.json).

Foi acrescentado e empacotado `hybrid/temporal_estimates.py`, que confere visibilidade do rastreador, âncora, caixa observada, limites da imagem e deslocamentos. Um trajeto que salta ou perde apoio não volta a gerar pontos até concordar com uma nova observação neural. Quando a trajetória válida e a pose neural divergem mais de 12% da diagonal da caixa, o desenho pode usar a trajetória como estimativa para revisão; a alternativa neural permanece preservada. Ela não é apresentada como medição confiável.

A fusão inicial expôs uma transição de cerca de 69 px na base da cauda, causada pelo desacordo entre a pose e o trajeto. Após tratar esses desacordos, os quatro pontos ficaram desenháveis nos 64 quadros da amostra. Foram sinalizadas dez previsões neurais conflitantes, sem alterar seus valores originais. O maior deslocamento entre quadros da base da cauda passou de 63,4% para 5,5% da diagonal da caixa nesse experimento. Essas verificações medem continuidade e limites de movimento, não erro anatômico contra referência humana.

| Ponto na amostra experimental | Quadros desenháveis | Destes, estimados |
| --- | ---: | ---: |
| Centro | 64/64 | 25 |
| Base da cauda | 64/64 | 25 |
| Quadril esquerdo | 64/64 | 30 |
| Quadril direito | 64/64 | 34 |

A [amostra com estimativas identificadas](../../artifacts/colab-continuity-2026-11-26/cpu-temporal-estimates-sequence/dlc_labeled.mp4) usa círculos vazados e legenda de estimativas. Seu CSV mantém `source=recovered`, `status=low_confidence` e a previsão anterior; esses pontos não entram nas métricas. A likelihood guardada é da âncora, conforme o manifesto, e não uma probabilidade calibrada da estimativa atual. [Verificação do exportador](../../artifacts/colab-continuity-2026-11-26/cpu-temporal-estimates-sequence/export-verification.json), [transições conferidas](../../artifacts/colab-continuity-2026-11-26/cpu-temporal-estimates-sequence/transition-audit.json).

O experimento acima antecedeu a integração automática e usa quatro consultas temporais já calculadas, com âncoras da HRNet da execução original. A integração posterior está descrita abaixo. Essa primeira amostra não cobre os 27 pontos nem os 4.438 quadros; a ausência de referência anatômica continua limitando a avaliação de precisão.

Antes de integrar e distribuir essa dependência, foi consultada a [licença oficial do código fixado](https://github.com/facebookresearch/co-tracker/blob/82e02e8029753ad4ef13cf06be7f4fc5facdda4d/LICENSE.md), CC BY-NC 4.0. O worker verifica o código e os pesos em seu cache de modelos; os instaladores não incluem esses arquivos grandes. A licença e as revisões fixadas constam dos metadados da recuperação temporal.

O arquivo de código do commit foi baixado e conferido: 33.561.861 bytes, SHA-256 `2706dfa5e6b800d56aee87b952f93c9855da0fa59c3cd06ef8ac9c03b3b083f9`. Os 31 arquivos Python selecionados coincidem com o código usado nas inferências; a licença foi preservada junto deles. [Metadados e hashes para o próximo passo de integração](../../artifacts/colab-continuity-2026-11-26/cotracker-runtime-source.json).

## Validação local

| Verificação | Resultado |
| --- | --- |
| `.venv-test/bin/python scripts/quality/python-tests.py` | 303 testes após correção de alinhamento do SDK; OK, com 1 ignorado por bloqueio de arquivo específico do Windows |
| Backend `colab::tests` | 50 aprovados; servidores HTTP de teste locais, sem Colab |
| Regressão Python de integração/renderização após os últimos ajustes | 22 aprovados |
| Empacotamento nativo após os últimos ajustes | 1 aprovado; módulos gerados presentes e sintaticamente válidos |
| `npm run test:unit -- --reporter=dot` | 211 aprovados, em 34 arquivos |
| `npm run build` | TypeScript e Vite aprovados; aviso de tamanho de bundle permanece |
| `git diff --check` | Aprovado |

Na revisão com contexto, os 19 testes de refinamento e os testes de integração do pipeline passaram. O módulo temporal acrescentou seis testes sobre âncoras, limites, invisibilidade, saltos, retomada, desacordos e preservação dos dados. O teste nativo de empacotamento foi repetido após as alterações e passou. A suíte completa de 50 testes do backend é da etapa anterior desta revisão; os 211 testes de frontend e o build foram repetidos após a identificação visual das estimativas; esses componentes mantêm as interfaces e os formatos. Os módulos Python alterados foram novamente empacotados e conferidos pelo teste nativo.

Os nove testes de backend que abrem sockets inicialmente falharam pela restrição do sandbox (`Operation not permitted`). A suíte foi repetida fora do sandbox e os 50 passaram. Os testes de integração simulam somente as redes quando o framework não está disponível; não demonstram inferência CUDA ou acurácia científica. As comparações CPU descritas acima são execuções separadas com pesos reais. A suíte de navegador não foi repetida nesta revisão.

O renderer identifica essa apresentação como `scientific-video-3`. A recuperação visual, o consenso entre vistas e os testes automatizados não constituem treinamento de novos pesos. A correção completa exige avaliar uma nova inferência sequencial e revisar posições anatômicas em quadros representativos para adaptar e medir o modelo. Não há evidência para prometer zero perda ou precisão anatômica no vídeo inteiro.

## Referências preparadas para revisão humana

Foram extraídas 22 imagens originais em 900 × 720, cobrindo falhas, fronteiras de lacunas e variação de postura. A [galeria local](../../artifacts/colab-continuity-2026-11-26/anatomical-review/index.html) informa o tempo e o índice para localizar cada imagem no editor de tracking do aplicativo. O [rascunho de revisão](../../artifacts/colab-continuity-2026-11-26/anatomical-review/review-template.json) registra os 27 nomes anatômicos e hashes das imagens, com todas as coordenadas vazias e `reviewed=false`. Não é importado automaticamente pelo aplicativo e não constitui dataset treinável antes de revisão e conversão. Nenhuma posição foi apresentada como confirmação humana; a seleção deste mesmo vídeo não é um teste independente.

Referências de implementação: [recorte oficial DeepLabCut 3.0.2](https://github.com/DeepLabCut/DeepLabCut/blob/v3.0.2/deeplabcut/pose_estimation_pytorch/data/image.py), [HRNet oficial](https://github.com/DeepLabCut/DeepLabCut/blob/v3.0.2/deeplabcut/pose_estimation_pytorch/models/backbones/hrnet.py), [CoTracker no commit examinado](https://github.com/facebookresearch/co-tracker/tree/82e02e8029753ad4ef13cf06be7f4fc5facdda4d).

Não foram feitos commit, push, publicação nem alterações na VPS.


## Integração automática das estimativas identificadas

O usuário autorizou mostrar estimativas identificadas durante perdas/ocultações, fora das métricas automáticas. O worker de Campo Aberto v2 agora executa o acompanhamento temporal após o consenso HRNet e o fluxo óptico. A identificação da versão é `hybrid-df-precision-5`, com política `pose-consensus-temporal-4`. Os caminhos RAM, FST e análise local mantêm suas políticas separadas.

`hybrid/temporal_assets.py` fixa o commit e o checkpoint do CoTracker3 online por URL imutável, tamanho e SHA-256. O download é temporário e publicado atomicamente apenas após verificação. O código verificado é importado diretamente do ZIP, sem extração, instalação de pacotes ou `torch.hub` remoto. A leitura dos pesos usa `weights_only=True` e carregamento estrito. O construtor real foi conferido em CPU com os mesmos arquivos verificados. O worker verifica a disponibilidade dos arquivos antes de iniciar a inferência longa.

`hybrid/temporal_runtime.py` acompanha as imagens em blocos de até 64 quadros, com sobreposição de 16 e passagens para frente e para trás. A leitura reversa reduz cada imagem antes de armazená-la; o estado do modelo reinicia a cada janela. A última janela recebe padding somente dentro da rede, sem criar quadros no CSV ou no vídeo. As consultas partem de observações neurais aceitas; as estimativas carregadas pela sobreposição preservam a origem da âncora, sem se tornarem observações novas. Pontos rejeitados pelo trajeto para frente não podem virar âncoras neurais da passagem reversa.

São mantidas as verificações de visibilidade do rastreador, caixa observada, limites da imagem e continuidade. Pontos sem âncora ou trajetória apoiada permanecem pendentes. A autorização de mostrar estimativas não permite afirmar que uma parte invisível foi observada corretamente. O CSV de refinamento registra `temporal_anchor_frame`; o manifesto registra o modelo, os hashes, a política e a cobertura obtida.

Os pontos estimados são exportados com `source=recovered`, `status=low_confidence`, motivo de revisão e os valores anteriores preservados. O vídeo e o editor mostram círculos vazados; o editor inclui um aviso de quantidade e exclusão das métricas. As estimativas também foram removidas das entradas da mediana F+C dos pontos medidos. Um teste reproduz o caso em que uma estimativa alterava a mediana vizinha sem alterar sua marcação de qualidade.

Foram acrescentados cinco testes de provisionamento, nove de orquestração temporal e uma regressão da mediana; o empacotamento nativo confere os novos módulos. Os testes verificam janelas curtas/parciais, sobreposição, alinhamento, leitura reversa, retomada, âncoras futuras, ausência de sementes e rejeição de âncoras conflitantes. Os testes de orquestração simulam a rede; a inferência CPU real tem evidência separada.


A [execução neural real em CPU](../../artifacts/colab-continuity-2026-11-26/cpu-temporal-runtime-neural-execution.json) processou 64 quadros nas duas direções, com 26 consultas anatômicas em cada direção, em 165 segundos. O ponto `tail1` não apresentou âncora neural utilizável no trecho. A [orquestração da revisão final](../../artifacts/colab-continuity-2026-11-26/cpu-temporal-runtime.json) foi novamente executada sobre as mesmas previsões reais, conferindo os hashes dos quadros/consultas e registrando o reaproveitamento desses cálculos. O ajuste posterior apenas contabiliza também o tensor contíguo no limite declarado de armazenamento; o estado da rede continua limitado a 64 quadros por janela.

A [amostra do runtime integrado](../../artifacts/colab-continuity-2026-11-26/cpu-temporal-runtime-sequence/dlc_labeled.mp4) passou pelo exportador e renderer de produção. Foram conferidos o SHA-256, os 64 quadros a 16 FPS, resolução 900 × 720, dados anteriores e marcação das 504 estimativas. Foram inspecionados quatro quadros do MP4. O renderer foi executado no ambiente CPU com OpenCV 4.10; o OpenCV 4.13 do ambiente geral não abriu o MKV FFV1 usado somente nesta auditoria.

| Ponto no runtime automático | Quadros desenháveis |
| --- | ---: |
| Centro | 64/64: 39 neurais e 25 estimados |
| Quadril esquerdo | 64/64 |
| Quadril direito | 64/64 |
| Base da cauda | 45/64 |
| `tail1` | 0/64: sem âncora utilizável |

As transições dos quatro pontos centrais conferidos ficaram abaixo de 6,7% da diagonal da caixa por quadro nessa amostra. A base da cauda ainda apresenta lacuna de 19 quadros. Nenhum dos 64 quadros apresentou os 27 pontos apoiados simultaneamente. Esse resultado é diferente do protótipo anterior de quatro consultas: agora as âncoras são selecionadas automaticamente entre as poses refinadas da nova análise, sem reutilizar consultas previamente escolhidas da execução original. Portanto, a integração está feita, mas o objetivo de todos os pontos contínuos e precisos no vídeo inteiro continua sem comprovação. Não houve nova execução Colab/CUDA, treinamento de pesos ou substituição dos resultados salvos no aplicativo.


## Continuidade, identidade anatômica e passagem pelo vídeo completo

A revisão atual é `hybrid-df-precision-6`, com a política temporal `temporal-window-image-estimate-2`. Foram reproduzidos e corrigidos três tipos de falha: junção entre blocos contínuos que criava um salto, trajetória reversa que substituía uma observação já corroborada nas imagens e transição entre observação/estimativa que só era conferida no estado interno da rede.

O rastreador de pontos segue características da imagem, não nomes anatômicos. Agora as hipóteses devem respeitar as observações já corroboradas e a concordância com a sequência de pontos nomeados. Uma hipótese que discorda de pelo menos três observações e tem mais discordâncias que concordâncias é rejeitada. As passagens reversas priorizam âncoras confirmadas na passagem para frente. As junções são conferidas em ordem cronológica, inclusive na extremidade anterior de uma lacuna preenchida de trás para frente. Um segmento que não se conecta às observações desenhadas é rejeitado; os valores anteriores ficam preservados.

`temporal_image_support.py` também confere propostas incertas da rede usando fluxo óptico independente nas duas imagens adjacentes: erro de ida/volta de até 1 pixel, concordância com a proposta de até 2 pixels e erro de patch de até 20, no espaço das imagens do modelo. São posições propostas pela rede e apoiadas no movimento real, sem segurar coordenadas ou interpolar. Âncoras são identificadas separadamente de pares conferidos por fluxo. O CSV de refinamento registra `temporal_image_support`; o manifesto guarda a política e os totais. Toda recuperação continua identificada para revisão e excluída das métricas.

A comparação com a grade auxiliar oficial não melhorou a cobertura deste trecho: o quadril direito passou de 64 para 39 quadros desenháveis, e a lacuna da base da cauda permaneceu. Essa variante foi descartada; não houve medição de erro anatômico contra referência humana nessa comparação.

Na [amostra atual de 64 quadros](../../artifacts/colab-continuity-2026-11-26/cpu-temporal-runtime-sequence/dlc_labeled.mp4), centro, base da cauda e ambos os quadris ficaram desenháveis em 64/64 quadros. A base da cauda agora permanece próxima à base visível durante o giro; a [inspeção ampliada](../../artifacts/colab-continuity-2026-11-26/tail-base-review.png) mostra o erro de troca de região da previsão anatômica e a proposta temporal. Essa inspeção é qualitativa, não um conjunto de rótulos manuais. Foram exportadas 413 estimativas, todas com identificação e valores anteriores preservados. `tail1` continua sem uma âncora utilizável nesse recorte.

O [diagnóstico ampliado de 68 quadros](../../artifacts/colab-continuity-2026-11-26/cpu-temporal-context4-sequence/dlc_labeled.mp4) acrescenta quatro quadros reais anteriores. As âncoras desse prefixo vêm das observações neurais da execução original; os demais 64 quadros usam o detector e refinador novos. O prefixo não representa uma nova inferência HRNet integral; essa mistura é declarada no manifesto. Os 64 quadros sobrepostos foram conferidos pixel a pixel contra o recorte original. Essa amostra exercita duas janelas por direção e uma janela final com 20 quadros reais, além da transferência de âncoras de `tail1` entre blocos.

Foram auditadas todas as 27 trajetórias dos dois MP4/CSV. Os dois saltos encontrados inicialmente no nariz e na ponta da cauda foram rejeitados na revisão final. Não restou transição entre pontos desenháveis acima do limite declarado de 35% da diagonal da caixa nos dois recortes. Isso verifica continuidade, não precisão anatômica. Na amostra de 68 quadros há 548 estimativas e oito quadros com os 27 pontos desenháveis; nos demais ainda faltam pontos. [Auditoria de todos os pontos: 64 quadros](../../artifacts/colab-continuity-2026-11-26/cpu-temporal-runtime-sequence/all-points-audit.json), [68 quadros](../../artifacts/colab-continuity-2026-11-26/cpu-temporal-context4-sequence/all-points-audit.json).

A suíte completa passou com 302 testes, incluindo um ignorado por condição exclusiva do Windows. O teste nativo de geração/empacotamento passou com o novo módulo. Os testes de frontend e o build são os já repetidos na revisão de identificação visual; não foram repetidos por estas alterações exclusivamente Python/Rust de empacotamento. As inferências neurais reais em CPU e as simulações das redes nos testes têm registros separados.

Foi iniciada a detecção sequencial dos 4.438 quadros do R2 em CPU. Ela executa o detector de produção com os pesos verificados, a máscara atual e os retries; um adaptador apenas registra checkpoints e permite restaurar o estado de associação. A cópia local protegida do vídeo possui o mesmo SHA-256 da origem. Os checkpoints são JSONL, a retomada confere a configuração e um bloqueio exclusivo evita processos duplicados. O progresso fica em `cpu-full-sequence/detector-progress.json`. Esta é somente a etapa de detecção; HRNet, recuperação temporal, exportação integral e avaliação anatômica do vídeo completo continuam pendentes. Nenhum job Colab/CUDA foi iniciado e os resultados originais do aplicativo permanecem intactos.

## Conferência com o SDK real e alinhamento de quadros ausentes

Foi preparado um ambiente isolado em `/tmp`, com Python 3.11.18, DeepLabCut 3.0.2, Torch 2.2.2 e OpenCV 4.10.0. As dependências públicas foram fixadas por versão/hash; os arquivos de configuração e checkpoints existentes foram verificados antes da inferência. O ambiente de detecção em execução e o ambiente do aplicativo permanecem separados.

O SDK real e o adaptador CPU produziram as mesmas coordenadas nos quatro inputs conferidos, com diferença máxima de score de aproximadamente 0,0000053. A comparação com o resultado CUDA original, usando a mesma caixa no quadro zero, apresentou diferença máxima de 2,90625 pixels. Essa comparação confere a implementação do adaptador; não mede erro anatômico contra referência humana. [Conferência do SDK](../../artifacts/colab-continuity-2026-11-26/dlc311-runtime-probe.json).

Também foi executado o fluxo real de produção sobre quatro quadros consecutivos: DeepLabCut → H5/CSV bruto → consenso → recuperação visual/temporal → CSV canônico → MP4. Foram geradas 108 linhas canônicas e quatro quadros de vídeo em 900 × 720, a 16 FPS. O DataFrame bruto permaneceu inalterado, e as recuperações mantiveram identificação de estimativa e exclusão das métricas. [Verificação do fluxo com o SDK](../../artifacts/colab-continuity-2026-11-26/sdk-e2e-4/e2e-verification.json). Essa primeira execução antecede o ajuste de agendamento descrito abaixo e não cobre o vídeo inteiro.

A auditoria reproduziu uma falha independente de alinhamento no DeepLabCut 3.0.2: o modo paralelo devolveu zero resultados para quatro imagens sem caixa. A extração de resultados nesse modo ocorre após uma chamada da rede; imagens sem caixa não geram essa chamada. No modo sequencial, os mesmos quatro quadros foram devolvidos, cada um com a pose ausente do próprio SDK (`-1`). Os casos com lacuna inicial e lacuna intermediária/final também preservaram quatro quadros no modo sequencial. Não foi demonstrado que essa falha causou as perdas anatômicas da execução original. [Reprodução com o SDK real](../../artifacts/colab-continuity-2026-11-26/dlc-empty-frame-probe.json).

O worker de Campo Aberto v2 agora desativa somente o pré-processamento paralelo do runner, preservando seus demais ajustes e o batching neural. O arquivo verificado do modelo não é editado. A conferência de quantidade de quadros continua obrigatória; o worker não preenche silenciosamente uma saída truncada. A regressão exercita lacunas no início, meio, fim e em todos os quadros, a preservação dos índices, a configuração original e a rejeição de contagens divergentes. Os caminhos local, legado e RAM mantêm suas configurações anteriores. Os nove testes de integração passaram; a suíte Python completa passou com 303 testes e um ignorado exclusivo do Windows; o empacotamento nativo passou novamente.

Após o ajuste, a inferência por quadro e o refinamento do recorte de quatro quadros produziram os mesmos pontos, aceitação, motivos, votos e fontes. A saída bruta coincidiu com a produzida pelo iterador de vídeo real. Uma chamada sem caixa devolveu a pose ausente esperada e não contaminou a previsão seguinte. A comparação de refinamento reaproveitou apenas as mesmas saídas neurais reais para evitar recalculá-las. [Equivalência conferida](../../artifacts/colab-continuity-2026-11-26/cpu-full-sequence/pose-sdk/stream-equivalence.json).

Foi iniciada em paralelo a etapa de HRNet/consenso do vídeo completo, consumindo os checkpoints de detecção em ordem e registrando um checkpoint por quadro. Usa o SDK real em CPU; a validação temporal entre quadros será reaplicada após a sequência completa. Seu progresso fica em `cpu-full-sequence/pose-sdk/progress.json`. A recuperação temporal completa, a exportação integral e a avaliação da precisão anatômica continuam pendentes. Os recortes anteriores ainda apresentam pontos ausentes; não há comprovação de continuidade precisa dos 27 pontos nos 4.438 quadros. Nenhum job Colab/GPU foi iniciado, nenhum novo peso anatômico foi treinado e os resultados originais do aplicativo não foram substituídos.

A finalização integral está enfileirada em `audit_full_temporal_export_cpu.py --wait`. Enquanto aguarda os dois produtores, não importa os frameworks nem carrega outro modelo. O preflight conferiu vídeo, checkpoints e integridade do CSV original; a execução temporal integral ainda não começou. Quando os produtores terminarem, o finalizador usará o H5 bruto e o consenso reais já calculados, conferirá seu alinhamento e executará fluxo óptico, recuperação temporal, escritores e renderer de produção. As previsões neurais de cada janela terão checkpoints atômicos com hashes de entrada/saída, para permitir retomada sem repetir esse cálculo. A auditoria dos 27 pontos e a decodificação do MP4 inteiro estão preparadas para essa etapa; ainda não foram executadas no vídeo completo. O progresso fica em `cpu-full-sequence/finalizer-progress.json`.

## Direção proposta pelo usuário: camadas com eixo corporal e orientação

Esta seção atualiza o estado anterior: a avaliação pesada de 27 pontos foi interrompida de forma controlada, com 170 quadros completos preservados em checkpoints. O finalizador foi interrompido antes de executar recuperação temporal integral. Esta foi a etapa de proposta. O detector por CPU também foi interrompido posteriormente, com checkpoints preservados; a implementação efetiva e sua verificação aparecem na seção final abaixo.

O código atual já separa detecção e pose. O custo adicional vem da inferência anatômica detalhada, de até nove vistas por quadro e da recuperação temporal neural. A proposta é reutilizar a geometria local e reservar modelos adicionais para informação que ela não determina.

| Camada | Responsabilidade e saída |
| --- | --- |
| Localização | Detector fornece caixa, presença e confiança; resultado independente do comportamento. |
| Forma | Segmentação dentro do recorte fornece silhueta observada e eixo corporal, reutilizando os critérios locais de qualidade. |
| Orientação | Evidência visual específica de cabeça e base da cauda resolve o sentido do eixo; a continuidade controla inversões. O eixo geométrico sozinho não define esses nomes anatômicos. |
| Comportamento | Classificador temporal combina imagens do recorte, mudanças da silhueta, orientação e relação com as paredes, usando as marcações de rearing. Parede é uma pista para episódios apoiados, não uma condição obrigatória para todos os rearings. |
| Controle de qualidade | Presença/intervenção interrompe o trecho ao retirar o animal; confiança e origem acompanham todas as saídas. Estimativas permanecem identificadas e fora das métricas automáticas. |

Cada etapa deve persistir seu resultado com versão e hashes das entradas. Ajustar o classificador comportamental não deve exigir nova detecção ou nova segmentação. Refinamentos caros devem ser acionados por incerteza, em vez de repetidos em todos os quadros. O ganho de tempo e a qualidade precisam ser medidos no R2 completo. O desenho proposto mantém a separação entre eixo da silhueta e posições anatômicas; a câmera superior fornece uma projeção 2D, não uma medida direta da altura da cabeça.

Uma comparação isolada com o checkpoint público oficial RTMPose-M foi concluída em CPU sobre 13 quadros reais e as mesmas caixas, com revisão/tamanho/SHA-256 fixados. Foram obtidos 277 pontos aceitos pelo mesmo consenso, contra 149 na referência HRNet, dentre 351 possíveis. Os scores de arquiteturas diferentes não são calibrados entre si. A inspeção dos quadros 851, 866 e 890 mostrou deslocamentos de pontos e trajetos para fora do animal durante giros; a maior cobertura não sustenta sua adoção como padrão. O experimento usa a configuração RTMPose-M genérica oficial presente no SDK 3.0.2, pois o diretório Model Zoo desse pacote não fornece o YAML específico dessa variante. Não houve substituição de pesos/configuração em produção. [Comparação](../../artifacts/colab-continuity-2026-11-26/rtmpose-experiment/comparison.json), [imagens](../../artifacts/colab-continuity-2026-11-26/rtmpose-experiment/comparison-contact.png).


## Implementação das camadas em Campo Aberto

O fluxo padrão `wistar_df_v2` passou a usar `oft-layers-1` no Colab e no Wistar local. O OpenCV local (`opencv-box-13`) compartilha o eixo, a orientação e o classificador de ápices. Não há inferência HRNet/CoTracker no novo caminho v2. Os caminhos antigos de 27 pontos, RAM e FST conservam suas implementações próprias.

1. O detector Wistar fornece a caixa, independentemente da pose. Se faltar detecção neural, uma caixa sustentada pela segmentação atual pode aparecer como recuperação para revisão, excluída das métricas automáticas.
2. A segmentação reutiliza o mesmo `RobustSegmenter` do OpenCV local, com referência congelada, cor/aparência e associação espacial à caixa. Falha de silhueta não apaga uma caixa observada.
3. `body-axis-2` produz sete pontos geométricos, com rejeição de eixos ambíguos, mudanças isoladas de orientação, área e posição. O eixo permanece dentro da silhueta sustentada pela imagem.
4. Um apêndice fino conectado ao corpo pode orientar cabeça e base da cauda. Caudas com luminância diferente da pelagem são consideradas. Inversões precisam de confirmação temporal; estimativas sem apoio renovado expiram após 0,75 s. Os pontos aparecem em âmbar, vazados, com rótulo de estimativa.
5. O classificador temporal de ápices reutiliza geometria, imagem e máscaras de dados ausentes. As marcações de ápice não fornecem início, fim ou duração de episódios; os resultados são propostas pendentes de revisão.

O botão **Usar nas próximas análises locais e Colab**, na aba Rearing, importa um modelo `oft_rearing_apex_v1` com esquema `oft-apex-features-2`, tamanho e SHA-256 verificados. A escolha é persistida no armazenamento do aplicativo. O envio ao Colab preserva os bytes cobertos pelo hash; selecionar nenhum modelo elimina arquivos antigos do payload daquele job. Sem modelo selecionado, o resultado é explicitamente não classificado. Os pesos pessoais não são incorporados ao repositório ou instalador.

Detecção, geometria e descritores visuais possuem caches completos com identidade do vídeo, configuração, código relevante e hashes dos artefatos. A troca dos pesos do classificador reaproveita as camadas anteriores. Arquivos parciais não são publicados como cache válido.

A intrusão externa conectada à borda suspende o tracking e, após confirmação, encerra a execução observacional até o fim do vídeo. Caixas, eixos, pontos estimados e propostas não reaparecem depois desse encerramento. Esse mecanismo detecta uma intrusão visual grande e persistente; não foi treinado como classificador semântico de mãos humanas.

O CSV novo contém sete pontos do eixo, duas extremidades estimadas e o centro da caixa. Preserva observação original, origem, qualidade, quadro, PTS e metadados das camadas. O editor, Detalhes e os exportadores preservam essas informações e o escalonamento ao vídeo original. Estimativas e propostas não entram automaticamente nas métricas científicas. O MP4 do Colab é `oft-layered-video-1`; o OpenCV exporta `local-audit-6`.

### Evidência local no R2

Foi processado o vídeo completo de 4.438 quadros, 900 × 720, 16 fps, em CPU. O adaptador do Colab recebeu as detecções salvas da execução original, não uma nova inferência GPU. Na verificação final, houve caixas em 4.438/4.438 quadros, eixo corporal utilizável em 4.345/4.438 e orientação estimada em 3.920/4.438. São contagens de disponibilidade, não medidas de acurácia anatômica. Os 518 quadros restantes conservaram orientação ambígua.

A análise OpenCV completa e o MP4 local também foram executados. As cópias de trabalho, resultados e relatórios estão em `artifacts/colab-continuity-2026-11-26/layered-cpu/`, ignorados pelo Git. Os resultados originais do aplicativo não foram substituídos.

| Verificação final | OpenCV local | Adaptador Colab com caixas salvas |
| --- | ---: | ---: |
| Quadros com caixa | 4.438 | 4.438 |
| Quadros com eixo utilizável | 4.355 | 4.345 |
| Quadros com orientação estimada | 3.973 | 3.920 |
| Quadros decodificados do MP4 | 4.438 | 4.438 |

Os dois MP4s mantêm 900 × 720 pixels. O hash do vídeo de entrada e o hash do CSV original foram conferidos novamente, sem alteração. O resumo de verificação é `layered-cpu/verification.json`.

O modelo de ápices usado no ensaio é o experimental já treinado na sessão 03, utilizado explicitamente pelo script, sem instalá-lo como padrão. Seu teste temporal anterior no único vídeo anotado teve precisão de 18,2%; isso não comprova desempenho independente no R2. Não há rótulos anatômicos manuais para medir erro de cabeça/cauda neste vídeo.

Foram verificados o fluxo padrão sem rede de pose, geração real de MP4, preservação de estimativas no CSV Python/TypeScript, ausência explícita de modelo, troca de pesos sem repetir geometria, expiração e confirmação da orientação, encerramento por intrusão e isolamento dos caminhos antigos. A regressão em Chromium e WebKit conferiu sincronização ao reproduzir/buscar quadros e retirada da sobreposição após intervenção. Nenhum job Colab ou inferência CUDA foi executado nesta implementação.

Passaram 220 testes de frontend, 106 testes Rust, a suíte de 313 testes Python (um teste exclusivo do Windows ignorado neste macOS), build e checagem de tipos dos testes. Após ajustar a normalização do cache transportado por CSV, os dez testes específicos das camadas foram repetidos e passaram; o empacotador Python/Rust também foi conferido novamente. As regressões de navegador somaram seis casos de sincronização/intervenção e oito de configuração e disponibilidade do classificador, distribuídos entre Chromium e WebKit.

### Skeleton incorporado ao MP4 exportado

A visualização `oft-layered-video-2` substitui o desenho anterior na exportação Wistar de Campo Aberto. O MP4 incorpora o mesmo eixo de sete pontos da análise local: linha ciano e nós preenchidos, âmbar para silhuetas incertas, extremidades estimadas vazadas e identificadas. Os pontos canônicos não são desenhados novamente sobre esse eixo. Eixos rejeitados permanecem ocultos; a interrupção por intervenção também suprime caixas, skeleton e estimativas no vídeo. O painel informa a disponibilidade do skeleton, sem apresentar os pontos geométricos como probabilidades anatômicas.

O renderizador do Colab e o renderizador nativo agora recebem todos os módulos necessários, incluindo o estilo usado na exportação local. A versão, o tamanho e o nome do MP4 são persistidos para identificar vídeos antigos. A aba Vídeos oferece **Atualizar MP4** e **Baixar MP4**. A atualização pode aproveitar as camadas já salvas ou reconstruir apenas a geometria com o vídeo e as detecções de um job antigo. Não executa novamente detector/HRNet nem exige GPU. O CSV original permanece intacto. Uma falha de substituição preserva o MP4 e o marcador anteriores. A ausência de medidas físicas permite exportar o skeleton com o gráfico explicitamente sem calibração.

Foram gerados e decodificados dois MP4 completos do R2 em CPU: um com as camadas salvas e outro a partir das detecções do job antigo `02eca074`. Ambos conservam 4.438 quadros, 900 × 720 pixels, 16 fps e 4.345 quadros com eixo utilizável. Essas contagens medem disponibilidade visual, não acurácia anatômica. Os hashes do vídeo original e do CSV original foram conferidos antes e depois, sem mudança. As cópias de verificação estão em `artifacts/colab-continuity-2026-11-26/export-skeleton-v2/`, incluindo `verification.json`, os MP4 e quadros de inspeção. Os arquivos do aplicativo não foram substituídos por esse ensaio.

Passaram os 12 testes das camadas (incluindo renderização real de vídeo antigo, cache e preservação após falha), oito testes do renderizador híbrido, nove da exportação local, três testes de UI e o build. Foram conferidos os testes Rust de empacotamento remoto/nativo, versão do MP4 e download validado por tamanho/SHA-256. O teste de download utilizou um servidor temporário em loopback, sem conexão ao Colab. Nenhum job Colab ou execução GPU foi iniciado para esta correção.
