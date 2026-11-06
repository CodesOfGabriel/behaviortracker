# BehaveTracker

Aplicação desktop para preparar, revisar e documentar análises comportamentais de campo aberto. O foco do MVP é um rato por vídeo, câmera fixa, dados brutos imutáveis, correção humana auditável e métricas locais reproduzíveis.

## O que já funciona

- criação do experimento e importação local de vídeo;
- captura de frame e calibração dos quatro vértices do piso;
- importação de pose em CSV canônico;
- execução remota do SuperAnimal TopViewMouse em runtime GPU elegível do Colab;
- upload em blocos, verificação SHA-256, progresso persistido e importação automática do resultado;
- editor com overlay, timeline de qualidade e correção por arraste;
- preservação do tracking bruto e eventos de revisão;
- métricas OFT locais e exportações CSV/JSON;
- demonstração sintética acessível pelo dashboard.

A tela Google Colab permite configurar o Client ID por perfil local, autorizar a Conta Google com OAuth 2.0 + PKCE e consultar assinatura/runtimes elegíveis. A configuração e a autorização ficam no SQLite do diretório de dados do app. Segredos e tokens não são devolvidos à interface nem devem ser versionados. O Keychain só é consultado pelo botão **Recuperar conexão anterior**, para importar credenciais de instalações antigas.

No editor de um experimento real, **Analisar no Colab** cria ou reutiliza um runtime GPU elegível, transfere o vídeo pela API Jupyter, executa o DeepLabCut e importa o CSV canônico. O fluxo está implementado, mas a prova P0 com uma conta e um vídeo reais ainda deve ser registrada antes de tratá-lo como validado. O app não promete GPU gratuita e não contorna cotas, billing ou regras do provedor.

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

## Rodar como desktop Tauri

Além do Node, instale Rust estável e os [pré-requisitos oficiais do Tauri 2](https://v2.tauri.app/start/prerequisites/). Depois:

```bash
npm run tauri dev
```

No aplicativo, abra **Processamento → Google Colab**, salve o Client ID de um cliente OAuth do tipo **Desktop app** uma vez e clique em **Conectar conta Google**. Não é necessário criar um `.env`; essa configuração é persistida pelo backend nativo para o perfil local. A prévia aberta somente com `npm run dev` não acessa o armazenamento nativo.

Se a conexão parou de funcionar após a mudança do Keychain para SQLite, clique em **Recuperar conexão anterior**. O macOS pode pedir permissão para ler as credenciais antigas. Após importar, o app valida a sessão; caso a autorização tenha expirado, use **Conectar conta Google** novamente. As análises seguintes acessam o SQLite, sem consultar o Keychain. A página do navegador confirma a conexão somente depois de salvar o e-mail e o token localmente; falhas na troca de tokens aparecem na interface.

Para processar um vídeo:

1. Crie o experimento, selecione o vídeo e calibre a arena.
2. No editor, clique em **Analisar no Colab**.
3. Se o projeto foi reaberto, selecione novamente o vídeo original quando solicitado; o navegador não persiste objetos `File`.
4. Aguarde os estágios de runtime, upload, instalação, inferência e download. Ao terminar, o CSV é importado automaticamente e fica salvo no diretório de dados do app.

A primeira execução pode demorar porque o runtime instala o DeepLabCut e baixa os pesos do modelo. Fechar o aplicativo interrompe o job local; ao reabrir, ele será marcado como falho e poderá ser iniciado novamente.

O bundling está desabilitado neste corte até assinatura, FFmpeg e políticas de distribuição serem definidos.

## CSV canônico

```csv
frame_index,timestamp_sec,animal_id,keypoint,x_px,y_px,likelihood,status
1200,40.000000,animal_1,body_center,320.0,245.0,0.98,valid
1201,40.033367,animal_1,body_center,322.0,247.0,0.97,valid
1202,40.066733,animal_1,body_center,,,0.21,missing
```

Coordenadas ausentes permanecem vazias; nunca são convertidas em `(0,0)`. Os status aceitos são `valid`, `low_confidence`, `jump`, `missing` e `out_of_arena`.

## Limites científicos

- Tempo no centro é um indicador comportamental, não diagnóstico de ansiedade.
- Imobilidade locomotora operacional não equivale automaticamente a freezing.
- Rearing, grooming e freezing são anotações manuais/experimentais no MVP.
- O modelo SuperAnimal-TopViewMouse não deve ser tratado como validado para ratos sem estudo próprio.
- Lacunas não são interpoladas nem conectadas silenciosamente.

O estado detalhado está em [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md), e o gate remoto em [docs/P0_COLAB_FEASIBILITY.md](docs/P0_COLAB_FEASIBILITY.md).

