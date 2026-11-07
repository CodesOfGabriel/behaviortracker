# BehaveTracker

Aplicação desktop para preparar, revisar e documentar análises comportamentais de campo aberto. O foco do MVP é um rato por vídeo, câmera fixa, dados brutos imutáveis, correção humana auditável e métricas locais reproduzíveis.

## O que já funciona

- criação do experimento e importação local de vídeo;
- compactação local sem perda, comparação de pixels/tempos e reutilização da cópia preparada;
- captura de frame e seleção separada dos quatro vértices da borda superior e dos quatro vértices do chão;
- importação de pose em CSV canônico;
- execução remota do SuperAnimal TopViewMouse em runtime GPU elegível do Colab;
- diagnóstico de até 60 segundos, com caixas do detector, todos os pontos brutos, cobertura, falhas por frame e tempos por etapa;
- vídeo rotulado pelo DeepLabCut, salvo localmente e reproduzido em uma aba separada do editor;
- upload em blocos, verificação SHA-256, progresso persistido e importação automática do resultado;
- fluxograma horizontal com checkpoints, GPU confirmada pelo runtime e diário persistido de cada execução;
- editor com overlay, timeline de qualidade e correção por arraste;
- preservação do tracking bruto e eventos de revisão;
- segunda passagem visual para recuperar falhas curtas do detector, com procedência e confirmação humana;
- revisão de episódios de rearing, grooming e freezing, sugestões exploratórias e exportação de frequência/duração;
- métricas OFT locais e exportações CSV/JSON;
- demonstração sintética acessível pelo dashboard.

A tela Google Colab permite configurar o Client ID por perfil local, autorizar a Conta Google com OAuth 2.0 + PKCE e consultar assinatura/runtimes elegíveis. A configuração e a autorização ficam no SQLite do diretório de dados do app. Segredos e tokens não são devolvidos à interface nem devem ser versionados. O Keychain só é consultado pelo botão **Recuperar conexão anterior**, para importar credenciais de instalações antigas.

No editor de um experimento real, **Analisar no Colab** cria ou reutiliza um runtime GPU elegível, transfere o vídeo pela API Jupyter, executa o DeepLabCut e importa o CSV canônico. O fluxo está implementado, mas a prova P0 com uma conta e um vídeo reais ainda deve ser registrada antes de tratá-lo como validado. O app não promete GPU gratuita e não contorna cotas, billing ou regras do provedor.

Antes do upload, o app cria uma pasta identificada na sessão Python e confirma que ela está acessível pela API Jupyter. Isso trata a diferença entre o caminho absoluto `/content/...` e os caminhos relativos à raiz do servidor Jupyter. O fluxo mostra preparação, GPU, envio, integridade do vídeo, instalação do modelo, inferência e recebimento do resultado. Falhas preservam o checkpoint e os eventos anteriores; registros de análises antigas podem não conter esse detalhamento.

A preparação verifica DeepLabCut 3.x, a API SuperAnimal, suas dependências e o acesso CUDA. Um ambiente válido é reutilizado sem chamar pip. Dependências ausentes ou incompatíveis são preparadas e verificadas novamente; instalações concorrentes no mesmo runtime usam uma trava e uma segunda checagem. Se o Colab substituir a máquina, o novo ambiente precisa ser preparado novamente.

A escolha da GPU usa uma heurística, não um benchmark: para vídeos abaixo de 4K e menores que 30 minutos, a preferência é T4 → L4 → A100 → H100; para 4K ou vídeos mais longos, L4 → A100 → H100 → T4. O app ordena primeiro os runtimes GPU já alocados para reutilizá-los. Só cria outro runtime quando não há GPU alocada, usando as specs elegíveis da conta e preferindo memória padrão entre opções equivalentes. A política não estima preço, garante desempenho nem compra recursos; o motivo da seleção e a GPU efetivamente reportada ficam no diário.

A instalação e a inferência rodam em processos independentes da célula MCP, no mesmo runtime. As células apenas lançam o processo e consultam seu estado a cada cinco segundos. Uma trava herdada pelo worker impede lançamentos duplicados, inclusive após reconexões; repetir o lançamento de um job encerrado não reinicia a tarefa. Um `KeyboardInterrupt` na célula de acompanhamento não é enviado ao processo de inferência.

Essa separação evita depender de uma chamada HTTP longa para concluir o modelo: o [contrato MCP do Colab](https://developers.google.com/colab/api/reference/mcp/tools_list/execute_code) prevê prazo de streaming, interrupção do kernel por cancelamento e truncamento de saídas grandes. O estado compacto do worker é enviado separadamente dos detalhes para continuar legível quando o log é truncado.

O checkpoint mostra a contagem de frames e a porcentagem do **lote atual**, quando disponíveis no log do SuperAnimal. O detector pode chegar a 100% antes da próxima fase; isso não conclui a análise. As poses são baixadas após o worker de inferência terminar, antes do worker separado de renderização. Assim, a revisão pode começar enquanto o vídeo rotulado é gerado; uma falha posterior não descarta o CSV recebido. **Ver log técnico** carrega o último estado consultado, os 16 KiB finais da saída por tarefa, o traceback e os tempos da análise, salvos no dispositivo; os arquivos completos permanecem na pasta do job no runtime enquanto ela existir. Avisos de configuração permanecem no log, separados da mensagem da exceção.

## Teste curto antes de analisar tudo

No editor, abra **Testar rastreamento**, escolha início/fim (em segundos, até 60 s) e clique em **Testar trecho no Colab**. Inclua os momentos em que o animal fica em pé ou passa perto das paredes. FFmpeg/ffprobe são necessários: o app recorta apenas esse trecho sem perda, confere pixels/tempos e envia somente a cópia curta. Se a verificação falhar, o upload remoto é cancelado, sem enviar o vídeo completo como alternativa.

O diagnóstico `tracking-diagnostic-1` executa o mesmo detector e modelo de pose, separadamente, em lotes de dois frames. Não treina, adapta, recupera nem interpola pontos. O resultado mostra a caixa **pós-filtro** exposta pelo runner, todos os pontos utilizáveis do modelo e os estados: sem caixa, caixa sem pose, pontos rejeitados na conversão geométrica, pontos sem suporte para o centro, parcial/baixa confiança ou pontos disponíveis. O CSV inclui também `raw_crop_x_px`, `raw_crop_y_px` e `raw_model_likelihood`, preservando coordenadas/scores anteriores à conversão para investigar o adaptador. Isso ajuda a localizar a etapa da perda; não comprova a causa biológica nem a posição correta sem revisão humana.

O player usa o trecho local, caixa roxa e pontos verdes (score ≥ 0,60) ou amarelos (0,10–0,60). Permite avançar por frame e até a próxima perda. O relatório mede carregamento dos modelos, decodificação, detector, pose e exportação; o total do worker não inclui preparação local, instalação, espera por GPU ou transferências. **Cobertura não é acurácia**: caixas e pontos presentes ainda podem estar errados. Timestamps seguem índice/FPS; a posição na origem é aproximada, principalmente para VFR.

O histórico do teste e suas exportações JSON/CSV ficam separados das análises completas. Seus pontos não substituem poses, correções ou métricas do experimento. Use esse diagnóstico e anotações independentes para decidir se é necessário ajustar detector, treinar pose específica para os ratos ou revisar o adaptador. O treino personalizado é uma ação explícita no espaço **Ensinar o modelo**, descrito abaixo. Nenhuma melhoria de velocidade/acurácia foi medida no Colab ainda.

Interrupções da resposta MCP e deadlines tentam se reanexar à mesma consulta e ao mesmo `executionId`, sem criar um novo job. A resposta em streaming é encerrada no resultado final, sem aguardar o fechamento da conexão HTTP. Se todas as tentativas falharem, o app informa que o resultado não foi confirmado e preserva a sessão remota, que pode continuar executando. Isso não impede o Colab de encerrar ou substituir o runtime, não persiste dependências entre máquinas e não contorna limites do provedor. Os tokens são renovados durante o acompanhamento e antes do download.

## Preparar o vídeo e conferir a saída do Colab

Ao selecionar um vídeo no app desktop, o BehaveTracker prepara uma cópia local com FFmpeg, antes do envio. A política `lossless-upload-1` usa H.264 sem perda (`libx264`, CRF 0), sem redimensionar nem descartar frames, remover detalhes por compressão com perda ou converter o formato de pixel. Áudio não necessário ao tracking é removido somente da cópia. O arquivo escolhido permanece intacto. O app só aceita a cópia se ela for menor, mantiver os metadados visuais e passar pela comparação SHA-256 dos pixels decodificados de **cada frame**, com mesma contagem e timestamps relativos dentro de 1 ms. Isso valida a equivalência da imagem, não a acurácia do modelo.

Se a cópia ficar maior, o formato/rotação não for compatível, a verificação divergir ou FFmpeg/ffprobe não estiverem disponíveis, o app mantém o original e explica o motivo. Não existe redução garantida para um vídeo já bem comprimido. A [documentação do DeepLabCut](https://github.com/DeepLabCut/DeepLabCut/blob/main/docs/recipes/io.md) descreve re-encoding e redução de resolução; este app deliberadamente não reduz resolução/FPS automaticamente, para preservar os detalhes de animais parcialmente visíveis. Arquivo menor reduz transferência/armazenamento, mas não promete acelerar a inferência quando o número e o tamanho dos frames são iguais.

FFmpeg e ffprobe devem estar no PATH, em `/opt/homebrew/bin`, em `/usr/local/bin`, ou ser indicados por `BEHAVETRACKER_FFMPEG` / `BEHAVETRACKER_FFPROBE`. Os executáveis não estão empacotados neste protótipo. A comparação completa pode levar tempo; ela ocorre localmente e não instala modelos. A cópia validada fica em cache e é reutilizada ao analisar, inclusive após reabrir o app enquanto o cache existir. Se o cache for removido, selecione novamente o original. A prévia web não compacta arquivos.

Após a análise, o runtime usa o [renderizador do DeepLabCut](https://github.com/DeepLabCut/DeepLabCut/blob/main/deeplabcut/utils/make_labeled_video.py) com o H5 bruto e score de visualização ≥ 0,10. Borda/chão e offset do recorte são respeitados, mantendo a resolução original. Essa saída mostra os pontos do modelo, **sem as correções humanas nem a segunda passagem de recuperação**. O MP4 de reprodução é codificado em H.264/yuv420p com CRF 18; essa compressão afeta apenas a prévia e não as poses utilizadas para análise.

O arquivo retornado só é publicado localmente após conferir tamanho e SHA-256. Abra **Vídeo do DeepLabCut** na barra do editor para reproduzi-lo com controles nativos. Volte para **Editor** para revisar/corrigir. O vídeo fica no diretório `results` do app, acessível ao player pelo protocolo de arquivos limitado a `results/*.mp4`, sem carregar o arquivo inteiro no JavaScript. Falhas de renderização/download preservam as poses e exibem aviso. Execuções antigas não possuem esse artefato: use **Reprocessar no Colab**. A integração real no Colab ainda precisa ser validada; os testes locais usam vídeos sintéticos e contratos falsos do modelo.

## Ensinar um detector e os pontos dos seus ratos

No editor, abra **Ensinar o modelo**. Este espaço funciona mesmo sem tracking e não altera resultados científicos nem suas correções.

1. Selecione o vídeo original para reproduzir. Use **Andando**, **Nas duas patas**, **Grooming**, **Freezing** ou **Outro / incerto**, marque início/fim e salve o trecho. Esses rótulos são contexto humano, não um classificador de comportamentos.
2. Use **Anotar frame atual** ou **Extrair exemplos do trecho**, com espaçamento configurável e limite de 100 imagens por extração. O tempo solicitado é mapeado ao frame mais próximo pelos PTS reais, sem confiar no FPS estimado do navegador. A imagem é extraída pelo índice exato e seu PTS é guardado. Confira a imagem antes de rotular.
3. Desenhe uma caixa envolvendo a extensão visível do animal. Selecione cada parte e clique/arraste para posicioná-la. São nove partes: focinho, orelhas, nuca, meio do dorso, quadril, base da cauda e patas anteriores. Esquerda/direita são as do animal. Não estime coordenadas atrás da parede: marque **Não visível**.
4. Salve rascunhos enquanto trabalha. **Confirmar exemplo revisado** exige caixa, todas as partes revisadas e pelo menos uma visível. Confirmar um frame não replica os pontos para o trecho inteiro. Um trecho marcado, sozinho, não fornece caixas/pontos para treino.
5. Separe exemplos de treino e validação por vídeo e animal. Alterar o grupo de um frame atualiza o grupo dos demais frames daquele vídeo. A construção do snapshot bloqueia duplicatas e mistura de vídeo/animal entre treino e validação. Vídeos sem validação independente permitem apenas treinamento exploratório, sem estimativa de generalização.
6. Marque a autorização e clique em **Enviar exemplos e treinar no Colab**. Isso envia todos os exemplos revisados dos experimentos deste perfil local, não o vídeo completo, e pode consumir recursos da sua conta. O mínimo de dois exemplos permite testar o fluxo, não demonstra precisão. Limites iniciais: 500 frames, 200 MiB de imagens e 1–20 épocas. Mantenha o app aberto para acompanhar.
7. Confira o relatório e escolha **Selecionar para teste experimental**. O modelo anterior não é substituído automaticamente. Use **Testar rastreamento** para comparar no mesmo trecho; novas análises usam a versão selecionada, com seu identificador congelado por job. **Voltar ao SuperAnimal original** desfaz a seleção sem apagar nenhum modelo.

O treino `behavetracker-keypoint-rcnn-v1` usa Keypoint R-CNN/ResNet-50-FPN do TorchVision, com features inicializadas por pesos pré-treinados e cabeças ajustadas para a classe animal e nove pontos. Não é uma arquitetura criada do zero. Os frames revisados acumulam-se no corpus; cada treino cria um snapshot independente e parte da inicialização pré-treinada, sem aprender sozinho a partir de previsões não revisadas. Usa somente a GPU remota; não instala ou executa modelos no Mac. Requer PyTorch/TorchVision, Pillow, OpenCV e CUDA compatíveis no Colab; a checagem explícita não reinstala nem modifica o DeepLabCut. Pesos pré-treinados podem ser baixados na primeira execução.

Imagens PNG, anotações e trechos ficam no diretório de dados/SQLite; datasets JSONL e checkpoints versionados ficam em `training/datasets` e `training/models`. Imagens, snapshots e checkpoints têm SHA-256. Arquivos locais revisados são preservados mesmo quando o cache do vídeo desaparece; para extrair novos frames, selecione o original novamente. Os rótulos podem ser exportados como JSON; o JSON de rótulos não inclui as imagens e não é um backup completo do dataset. Não há limpeza automática desses arquivos neste corte.

O relatório informa loss por época e, quando há validação independente, precisão/recall de caixas com IoU ≥ 0,5 e score ≥ 0,5, cobertura dos pontos e erro médio de pose normalizado pela diagonal da caixa. Esse erro usa somente detecções correspondidas e deve ser lido junto com recall/cobertura. Não é uma avaliação científica completa: o conjunto atual contém exemplos com animal, não avaliação de cenas sem animal. O treino não demonstra automaticamente ganho, visibilidade de partes ocultas, comportamento ou generalização.

Checkpoints são baixados com verificação de tamanho/SHA e carregados com `weights_only=True` e esquema estrito. A cópia no runtime é reutilizada por SHA enquanto a máquina existir. Resultados personalizados aparecem como **experimentais**, sem atribuir confiança anatômica calibrada aos logits do Keypoint R-CNN. As coordenadas entram como baixa confiança; não são automaticamente elegíveis para métricas. Revise e confirme pontos visíveis antes de utilizá-los. O vídeo de resultado identifica a origem personalizada e não substitui correções humanas.

O fluxo foi verificado localmente com extração FFmpeg real, modelo/treino simulados, integridade HTTP e interação no navegador. Ainda falta executar um treino real no Colab com imagens humanas revisadas e comparar em vídeos/animais independentes. Não há melhoria de precisão ou desempenho demonstrada neste corte.

## Borda, chão e visibilidade parcial

Em **Novo experimento → Arena**, ajuste e confirme primeiro a **borda superior**, depois o **chão**. Use a mesma ordem dos cantos nas duas áreas: superior esquerdo, superior direito, inferior direito e inferior esquerdo. Cada confirmação é invalidada se seus vértices forem alterados. Somente o chão define a homografia, as dimensões em centímetros e as zonas de campo aberto.

As duas áreas seguem na solicitação da análise, com revisão e resolução, e ficam registradas por job no SQLite. No runtime, `output/arena_geometry.json` registra o contrato do adaptador `superanimal-canonical-3` e a política de recuperação. O recorte retangular é a união dos vértices das duas áreas, com margem de 5% em cada eixo, limitada ao vídeo. Assim, a inferência não fica restrita ao chão: preserva as paredes e a borda na imagem. O [parâmetro `cropping` do SuperAnimal](https://deeplabcut.github.io/DeepLabCut/dev/main/reference/deeplabcut/modelzoo/video_inference/#cropping) recebe esse recorte; as coordenadas são convertidas de volta ao vídeo original antes da importação. Um vídeo com resolução diferente da calibração é recusado. Projetos antigos sem borda continuam abrindo e usam o vídeo inteiro, sem inventar outra área.

O H5 original não é modificado. No CSV canônico, sentinelas `(-1, -1, -1)` viram coordenadas ausentes; a trajetória é interrompida nas lacunas, em vez de atravessar o canto da imagem. Cada ponto disponível é preservado independentemente dos demais. O centro corporal é uma média dos pontos disponíveis do tronco, nunca uma substituição pelo focinho/orelhas; com suporte parcial, exige revisão e registra quantos pontos o sustentam. Sem nenhum ponto do tronco, o centro fica ausente mesmo que o focinho esteja visível. FPS inválido interrompe a conversão, sem inventar timestamps.

As regiões `floor`, `wall_projection`, `outside` e `unknown` descrevem **projeções 2D**, não contato com o chão, altura ou postura. Marcar as duas áreas **não treina o modelo**, não recupera partes ocultas e não garante reconhecimento de ratos em pé. Adaptação/treinamento e validação com vídeo real são etapas distintas, não ativadas automaticamente por essa calibração. A projeção de um ponto acima do piso não determina sua posição real no chão.

## Recuperação visual e revisão de comportamentos

Após a passagem original, `visual-recovery-2` tenta novamente frames sem suporte confiável suficiente do tronco (ou sem três âncoras quando não há pontos de tronco no modelo), usando o pose runner do DeepLabCut e uma caixa baseada na última evidência visual. Orelha/cauda distal com score baixo, isoladamente, não disparam outra inferência. Reutiliza os pesos já baixados e avança o decoder sequencialmente, sem buscar um keyframe a cada tentativa. A passagem principal usa lotes de dois frames; a recuperação temporal continua sequencial para não usar posições futuras como evidência.

Por execução, o limite é o menor entre 1.200 tentativas e 15% dos frames (arredondado para cima, mínimo de uma). Não inicia outra tentativa depois de 60 s desde a primeira; isso não interrompe uma chamada já em andamento e não garante limite de duração total da análise. Ao atingir o orçamento, registra `recovery_state=limited`, preserva as lacunas e mostra aviso. O objetivo é limitar retrabalho, não ocultar falhas para produzir uma trajetória contínua.

A história expira em 0,75 s sem nova evidência. Coordenadas recuperadas precisam passar por filtros de suporte, limites e deslocamento; nenhuma parte oculta é preenchida por interpolação. Essas regras são heurísticas versionadas, não validação de acurácia. Incompatibilidade da API desativa somente a segunda passagem, informa isso no editor/log e preserva a primeira passagem. `results/<job>-profile.json` registra inferência principal, recuperação + conversão, exportação, tentativas e aceitações; a duração da renderização fica no log `render`. A precisão desses tempos e o ganho de desempenho precisam de benchmark no runtime real.

A segunda passagem usa o [pose runner do DeepLabCut](https://github.com/DeepLabCut/DeepLabCut/blob/main/deeplabcut/pose_estimation_pytorch/apis/utils.py) com [bounding boxes fornecidas ao pré-processador](https://github.com/DeepLabCut/DeepLabCut/blob/main/deeplabcut/pose_estimation_pytorch/data/preprocessor.py), sem depender de uma nova detecção global em cada falha. Durante essa fase, o diário informa quantos frames foram verificados; não confunde o fim do detector com a conclusão da recuperação.

No editor, pontos recuperados aparecem em roxo, com `source=recovered`; **Bruto** restaura a observação anterior. Após conferir o vídeo, use **Confirmar ponto após revisar**, arraste para corrigir ou **Posicionar ponto ausente**. Não posicione partes invisíveis por adivinhação. Cada confirmação/correção é auditável e pode ser desfeita. Resultados antigos não ganham recuperação retroativamente: use **Reprocessar no Colab**.

Em **Comportamentos · revisão assistida**, selecione rearing, grooming ou freezing, marque início/fim no vídeo e confirme o episódio. Sugestões exploratórias ajudam a localizar trechos: rearing combina projeção da parede e encurtamento corporal; grooming exige patas anteriores observadas próximas ao focinho com movimento relativo; freezing procura baixa movimentação de cinco pontos. As sugestões não são probabilidades, não são um classificador treinado e não comprovam esses comportamentos. Sem patas observadas, não há sugestão de grooming; sem evidência suficiente, anote revisando o vídeo. Falsos positivos e negativos precisam ser medidos com anotações independentes.

Somente episódios confirmados entram em frequência/duração. Intervalos sobrepostos da mesma classe são unidos. Sem revisão completa, os totais são parciais; **não anotado** não vira zero. Assinale que revisou o vídeo inteiro para cada classe apenas depois de conferir também os trechos sem sugestões. Exporte os episódios em `behaviors.csv` e o histórico em `corrections.jsonl`. O `experiment.json` inclui as políticas e o estado da revisão. Para obter classificação automática validada, ainda é necessário anotar exemplos representativos, treinar um classificador e avaliar em vídeos/animais independentes.

O método `oft-0.2` só calcula métricas a partir de pontos válidos detectados ou confirmados manualmente. Baixa confiança, saltos, previsões e recuperações não confirmadas ficam fora. Um intervalo exige ambos os extremos válidos e no máximo 0,5 s entre eles; os demais são desconhecidos. Imobilidade operacional usa velocidade ≤ 2 cm/s por pelo menos 0,5 s, **não equivale a freezing** e não é um critério biológico validado. Tempos por zona são atribuídos ao extremo inicial de cada intervalo elegível. Distância é parcial, calculada só em pares elegíveis; a cobertura deve acompanhar qualquer comparação. Para comparar resultados anteriores, mantenha a versão do método registrada.

## Rodar localmente

Requisitos do frontend: Node.js 22+.

```bash
npm install
npm run dev
```

Abra `http://localhost:1420`. Para validar o projeto:

```bash
npm test
npm run build
```

Para validar o verificador do ambiente e o worker (continuidade sem a célula, lançamento único, interrupções e logs) sem instalar DeepLabCut nem usar GPU local:

```bash
python3 -B -m unittest discover -s src-tauri/python -v
```

O teste Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib` também verifica o script completo de inferência com módulos falsos, sem instalar DeepLabCut ou usar GPU local. Para testar o cadastro no navegador (Chrome isolado, exemplo sintético), mantenha `npm run dev` aberto e execute `node scripts/check-arena-ui.mjs`. O script salva capturas em uma pasta temporária e não acessa a conta Google. Em outros sistemas, configure `BEHAVETRACKER_BROWSER_BIN` com o executável do Chrome/Chromium.

## Rodar como desktop Tauri

Além do Node, instale Rust estável e os [pré-requisitos oficiais do Tauri 2](https://v2.tauri.app/start/prerequisites/). Depois:

```bash
npm run tauri dev
```

No aplicativo, abra **Processamento → Google Colab**, salve o Client ID de um cliente OAuth do tipo **Desktop app** uma vez e clique em **Conectar conta Google**. Não é necessário criar um `.env`; essa configuração é persistida pelo backend nativo para o perfil local. A prévia aberta somente com `npm run dev` não acessa o armazenamento nativo.

Se a conexão parou de funcionar após a mudança do Keychain para SQLite, clique em **Recuperar conexão anterior**. O macOS pode pedir permissão para ler as credenciais antigas. Após importar, o app valida a sessão; caso a autorização tenha expirado, use **Conectar conta Google** novamente. As análises seguintes acessam o SQLite, sem consultar o Keychain. A página do navegador confirma a conexão somente depois de salvar o e-mail e o token localmente; falhas na troca de tokens aparecem na interface.

Para processar um vídeo:

1. Crie o experimento, selecione o vídeo e confirme separadamente a borda superior e o chão da arena.
2. No editor, clique em **Analisar no Colab**.
3. A cópia preparada é reutilizada enquanto estiver no cache. Se o cache não existir, selecione novamente o vídeo original quando solicitado.
4. Aguarde os estágios de runtime, upload, instalação, inferência e download. Ao terminar, o CSV é importado automaticamente e fica salvo no diretório de dados do app.

A primeira execução pode demorar porque o runtime instala o DeepLabCut e baixa os pesos do modelo. Mantenha o aplicativo aberto para receber o resultado: fechar o app encerra o acompanhamento local, mas um worker já iniciado pode continuar no Colab. Ao reabrir, o job fica marcado como não confirmado/falho, sem retomada automática. Verifique o runtime antes de iniciar outra análise para não duplicar processamento.

O bundling está desabilitado neste corte até assinatura, FFmpeg e políticas de distribuição serem definidos.

## CSV canônico

```csv
frame_index,timestamp_sec,animal_id,keypoint,x_px,y_px,likelihood,status
1200,40.000000,animal_1,body_center,320.0,245.0,0.98,valid
1201,40.033367,animal_1,body_center,322.0,247.0,0.97,valid
1202,40.066733,animal_1,body_center,,,0.21,missing
```

Coordenadas ausentes permanecem vazias; nunca são convertidas em `(0,0)`. Os status aceitos são `valid`, `low_confidence`, `jump`, `missing` e `out_of_arena`.

As novas análises incluem `spatial_region`, `support_count`, `support_total`, `source`, `raw_x_px`, `raw_y_px`, `raw_likelihood`, `raw_status`, `raw_spatial_region`, `raw_support_count`, `raw_support_total` e `recovery_state`. As exportações preservam a procedência e as observações originais. Os arquivos antigos sem essas colunas continuam aceitos.

## Limites científicos

- Tempo no centro é um indicador comportamental, não diagnóstico de ansiedade.
- Imobilidade locomotora operacional não equivale automaticamente a freezing.
- Rearing, grooming e freezing são anotações manuais/experimentais no MVP.
- O modelo SuperAnimal-TopViewMouse não deve ser tratado como validado para ratos sem estudo próprio.
- Lacunas não são interpoladas nem conectadas silenciosamente.

O estado detalhado está em [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md), e o gate remoto em [docs/P0_COLAB_FEASIBILITY.md](docs/P0_COLAB_FEASIBILITY.md).

