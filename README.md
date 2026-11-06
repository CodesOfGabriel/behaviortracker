# BehaveTracker

Aplicação desktop para preparar, revisar e documentar análises comportamentais de campo aberto. O foco do MVP é um rato por vídeo, câmera fixa, dados brutos imutáveis, correção humana auditável e métricas locais reproduzíveis.

## O que já funciona

- criação do experimento e importação local de vídeo;
- captura de frame e seleção separada dos quatro vértices da borda superior e dos quatro vértices do chão;
- importação de pose em CSV canônico;
- execução remota do SuperAnimal TopViewMouse em runtime GPU elegível do Colab;
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

O checkpoint mostra a contagem de frames e a porcentagem do **lote atual**, quando disponíveis no log do SuperAnimal. O detector pode chegar a 100% antes da próxima fase; isso não conclui a análise. O app só baixa o resultado depois de o worker terminar com sucesso. **Ver log técnico** carrega o último estado consultado, os 16 KiB finais da saída por tarefa e o traceback de falhas, salvos no dispositivo; os arquivos completos permanecem na pasta do job no runtime enquanto ela existir. Avisos de configuração permanecem no log, separados da mensagem da exceção.

Interrupções da resposta MCP e deadlines tentam se reanexar à mesma consulta e ao mesmo `executionId`, sem criar um novo job. A resposta em streaming é encerrada no resultado final, sem aguardar o fechamento da conexão HTTP. Se todas as tentativas falharem, o app informa que o resultado não foi confirmado e preserva a sessão remota, que pode continuar executando. Isso não impede o Colab de encerrar ou substituir o runtime, não persiste dependências entre máquinas e não contorna limites do provedor. Os tokens são renovados durante o acompanhamento e antes do download.

## Borda, chão e visibilidade parcial

Em **Novo experimento → Arena**, ajuste e confirme primeiro a **borda superior**, depois o **chão**. Use a mesma ordem dos cantos nas duas áreas: superior esquerdo, superior direito, inferior direito e inferior esquerdo. Cada confirmação é invalidada se seus vértices forem alterados. Somente o chão define a homografia, as dimensões em centímetros e as zonas de campo aberto.

As duas áreas seguem na solicitação da análise, com revisão e resolução, e ficam registradas por job no SQLite. No runtime, `output/arena_geometry.json` registra o contrato do adaptador `superanimal-canonical-3` e a política de recuperação. O recorte retangular é a união dos vértices das duas áreas, com margem de 5% em cada eixo, limitada ao vídeo. Assim, a inferência não fica restrita ao chão: preserva as paredes e a borda na imagem. O [parâmetro `cropping` do SuperAnimal](https://deeplabcut.github.io/DeepLabCut/dev/main/reference/deeplabcut/modelzoo/video_inference/#cropping) recebe esse recorte; as coordenadas são convertidas de volta ao vídeo original antes da importação. Um vídeo com resolução diferente da calibração é recusado. Projetos antigos sem borda continuam abrindo e usam o vídeo inteiro, sem inventar outra área.

O H5 original não é modificado. No CSV canônico, sentinelas `(-1, -1, -1)` viram coordenadas ausentes; a trajetória é interrompida nas lacunas, em vez de atravessar o canto da imagem. Cada ponto disponível é preservado independentemente dos demais. O centro corporal é uma média dos pontos disponíveis do tronco, nunca uma substituição pelo focinho/orelhas; com suporte parcial, exige revisão e registra quantos pontos o sustentam. Sem nenhum ponto do tronco, o centro fica ausente mesmo que o focinho esteja visível. FPS inválido interrompe a conversão, sem inventar timestamps.

As regiões `floor`, `wall_projection`, `outside` e `unknown` descrevem **projeções 2D**, não contato com o chão, altura ou postura. Marcar as duas áreas **não treina o modelo**, não recupera partes ocultas e não garante reconhecimento de ratos em pé. Adaptação/treinamento e validação com vídeo real são etapas distintas, não ativadas automaticamente por essa calibração. A projeção de um ponto acima do piso não determina sua posição real no chão.

## Recuperação visual e revisão de comportamentos

Após a passagem original, `visual-recovery-1` tenta novamente os frames com pontos pouco confiáveis usando o pose runner do DeepLabCut e uma caixa baseada na última evidência visual. Reutiliza os pesos já baixados; não reinstala o DeepLabCut por frame. A história expira em 0,75 s sem nova evidência. Coordenadas recuperadas precisam passar por filtros de suporte, limites e deslocamento; nenhuma parte oculta é preenchida por interpolação. Essas regras são heurísticas versionadas, não validação de acurácia. Incompatibilidade da API desativa somente a segunda passagem, informa isso no editor/log e preserva a primeira passagem.

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
3. Se o projeto foi reaberto, selecione novamente o vídeo original quando solicitado; o navegador não persiste objetos `File`.
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

