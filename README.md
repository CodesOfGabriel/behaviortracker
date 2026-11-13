<p align="center">
  <img src="public/behavior-tracker-banner.png" alt="Behavior Tracker — análise do comportamento de roedores" height="220">
</p>

# Behavior Tracker

Desenvolvido por **Gabriel Santos** e **Thiago Vargas**, uma parceria entre o **Laboratório Neurocell** e o **NeuroLab da Universidade Federal de Pelotas (UFPel)**.

Aplicativo desktop para Campo Aberto e Nado Forçado. O Campo Aberto analisa um rato com a geometria da arena; o Nado Forçado aceita um ou dois sujeitos, cada um em seu cilindro. O vídeo é enviado ao Google Colab para inferência com DeepLabCut, e os resultados ficam no dispositivo.

## Nado Forçado (FST)

Em **Novo experimento → Nado Forçado**, informe um ou dois sujeitos, selecione o vídeo e delimite uma ROI fixa que cubra cada cilindro da abertura ao fundo. A análise usa DeepLabCut 3.0.2, SuperAnimal Quadruped, HRNet-w32 de 39 pontos e CUDA, sem o detector nem o bundle Wistar de Campo Aberto. Presença visual, caixas dinâmicas, poses e indicadores são registrados separadamente por animal. O resultado automático de comportamento permanece `NOT_CLASSIFIED`; os rótulos IMMOBILITY, SWIMMING, CLIMBING, MIXED e UNCERTAIN são apenas anotações humanas auditáveis.

O contrato dos resultados, a origem nos notebooks v6.2/v6.4, os arquivos exportados e os limites da validação estão em [docs/FST_CONTRACT.md](docs/FST_CONTRACT.md). A execução real no Colab com GPU e vídeos de referência ainda precisa ser confirmada antes de usar os indicadores FST para conclusão científica.

## Detector D+F versionado

Novos experimentos usam `wistar_df_v2` por padrão; `wistar_df_v1` continua disponível para comparação. O motor permanece `wistar_superanimal_hybrid_v1`, com HRNet de 27 pontos em ambos. A referência anatômica inicial dos novos experimentos é `mouse_center`. A máscara v2 usa o polígono do piso e exclui as oclusões; a v1 preserva a união de piso e borda. Cada job registra o ID do bundle e os hashes dos dois checkpoints em `run_manifest.json`.

O instalador inclui os três arquivos do bundle v2: detector, checkpoint HRNet e configuração YAML. Cada instalação os valida por tamanho e SHA-256 antes de usar. O build de distribuição falha se algum arquivo estiver ausente ou alterado. O aplicativo não consulta arquivos de modelos em contas pessoais: cada usuário envia seu próprio vídeo ao runtime Colab da sua conta. O bundle v1 é opcional para comparação e deve ser importado localmente.

O job D+F produz CSV/H5, controle de qualidade e MP4 de inspeção. Se a renderização do MP4 falhar, as poses permanecem disponíveis. Os resultados experimentais dos três vídeos do Colab ainda precisam ser reproduzidos em uma execução real do app com os mesmos vídeos e ROI antes de afirmar equivalência.

O envio local usa blocos binários Tauri de 4 MiB. O bundle v2 é procurado primeiro no cache do runtime; se estiver ausente, o Colab tenta baixar os três arquivos da release `models-wistar-df-v2-r1` diretamente para arquivos temporários e só os publica após conferir tamanho e SHA-256. Se a release estiver indisponível, o aplicativo volta ao envio local pelo proxy do Jupyter. O bundle v1 continua usando envio local. O upload ao Jupyter tenta blocos de 4 MiB e reinicia com 1 MiB após erros de transporte ou do proxy. O vídeo e os modelos são reutilizados no mesmo runtime após validação; um runtime novo precisa obter os arquivos novamente. O histórico do job registra tempos de preparo, modelos, vídeo, inferência e artefatos.

### Publicação do bundle v2

Os arquivos da release são os três pesos/configurações e o `manifest.json` de `models/wistar_df_v2/`. Antes de publicar os checkpoints em uma release pública, confirme o direito de redistribuição de ambos. A release ainda precisa ser publicada para que o download direto seja usado; até lá o envio local permanece funcional. Valide os arquivos com `node scripts/check-release-models.mjs` e publique-os como assets da tag fixa `models-wistar-df-v2-r1` no repositório `CodesOfGabriel/behaviortracker`. Não use a URL `latest`: a tag e os hashes devem corresponder exatamente ao bundle v2.

Com a conta GitHub autenticada e a redistribuição autorizada, a publicação pode ser feita com:

```sh
node scripts/check-release-models.mjs
gh release create models-wistar-df-v2-r1 \
  models/wistar_df_v2/best_detector.pth \
  models/wistar_df_v2/snapshot-hrnet_w32-001.pt \
  models/wistar_df_v2/pytorch_config.yaml \
  models/wistar_df_v2/manifest.json \
  --repo CodesOfGabriel/behaviortracker \
  --target main \
  --title "Pesos Wistar D+F v2" \
  --notes "Bundle wistar_df_v2. Tamanhos e SHA-256 no asset manifest.json."
```

## Fluxo de Campo Aberto

1. Crie um experimento, selecione o vídeo e marque separadamente a borda superior e o chão da arena.
2. Conecte sua Conta Google na tela **Processamento**. O pipeline D+F requer um runtime com CUDA.
3. Clique em **Analisar no Colab**. O app prepara uma cópia sem perda quando ela é menor e verifica a equivalência dos frames antes do envio. O arquivo original não é alterado.
4. Acompanhe os checkpoints em **Execuções**. Ao terminar, abra **Revisar vídeo** para inspecionar pontos, corrigir frames e conferir as métricas. O vídeo D+F mostra caixas do detector e pontos válidos com `likelihood ≥ 0,60`.
5. Exporte `experiment.json`, `poses_reviewed.csv`, `corrections.jsonl` e `metrics.csv` em **Resultados**.

O motor legado usa o SuperAnimal TopViewMouse (`hrnet_w32` e `fasterrcnn_resnet50_fpn_v2`) com `video_adapt=True`, `batch_size=4`, `detector_batch_size=2`, `pseudo_threshold=0.1`, `bbox_threshold=0.9` e uma época para detector e pose. Esses são os parâmetros do Teste B do notebook `Diagnostico_DeepLabCut_Wistar_A100_COMPLETO.ipynb`. O motor D+F usa o detector Wistar escolhido e a HRNet adaptada, sem executar essa adaptação durante cada job. Ambos recusam resultados com contagem de frames incompatível com o vídeo.

O trajeto da **versão C** parte das coordenadas do Teste B. O centro corporal usa até três pontos estáveis do tronco e da base da cauda, quando disponíveis no modelo. Pontos com `likelihood < 0,60` não entram nesse centro; são necessários pelo menos dois pontos confiáveis para que ele seja válido nas métricas. Um filtro de mediana e desvio absoluto mediano (MAD), em janela de até sete frames válidos e pelo menos cinco, sinaliza picos isolados; um filtro temporal ponderado de três frames reduz oscilações nos trechos válidos. O filtro não preenche lacunas, não usa detecções recuperadas como evidência e preserva as coordenadas brutas do modelo adaptado. No editor e nos resultados, **Versão C · revisável** mostra o trajeto filtrado e eventuais correções humanas; **Teste B · bruto** mostra a referência anterior ao pós-processamento. As métricas e o gráfico acompanham a seleção.

## Limites e validação

O Teste B anexado gerou 7.356 frames e 82,2% tinham ao menos um dos 27 pontos com `likelihood ≥ 0,50`; no Teste A foram 7.349 frames e 36,2%. Essa medida é cobertura de pontos, **não** acurácia anatômica. Os limiares e o filtro da versão C são regras iniciais de qualidade, não validação científica. Pontos ocultos e postura de rearing exigem revisão humana; o app não classifica comportamentos.

Build TypeScript, testes locais e contrato da inferência com modelo simulado verificam o fluxo de código. Uma execução completa do app nesta versão com uma conta Colab A100/H100 e um vídeo real ainda precisa ser confirmada. A disponibilidade da GPU e as cotas dependem da conta Google.

## Desenvolvimento

O armazenamento local, as tabelas SQLite, as migrations e os testes de regressão estão descritos em [docs/DATABASE.md](docs/DATABASE.md).

### Distribuição para outros pesquisadores

Cada instalação usa o diretório de dados do usuário do sistema operacional e autoriza a Conta Google pessoal desse pesquisador no navegador. O token de renovação fica no cofre de credenciais do macOS/Windows/Linux; o SQLite local guarda apenas o estado da conexão. Tokens gravados por versões anteriores no SQLite são migrados para o cofre ao abrir o perfil OAuth, e o campo antigo é apagado após a gravação bem-sucedida. Se uma instalação antiga usava outro Client ID, será necessário reconectar a conta ao abrir a versão distribuída. As credenciais não são compartilhadas entre instalações.

Para gerar um instalador público, crie no Google Cloud um projeto do Behavior Tracker com público **Externo**, configure a tela de consentimento e crie um cliente OAuth do tipo **Aplicativo para computador**. Defina o Client ID desse projeto no ambiente de build:

```sh
BEHAVETRACKER_GOOGLE_CLIENT_ID='SEU_CLIENT_ID.apps.googleusercontent.com' npm run tauri build
```

O build de release exige esse ID; ele é integrado ao aplicativo, e o pesquisador não precisa informar credenciais de desenvolvedor. O Client ID identifica o aplicativo, enquanto cada usuário autoriza sua própria conta. Não inclua um Client Secret ou tokens pessoais no instalador. Em builds de desenvolvimento sem o ID integrado, o formulário manual continua disponível para testes locais.

Antes de disponibilizar o instalador a qualquer Conta Google, configure o público OAuth como **Externo** em Google Auth Platform → Público-alvo. Se o projeto atual não permitir essa mudança, crie um projeto público separado e um novo cliente Desktop; nesse caso, gere outro instalador com o novo Client ID. No modo de teste, adicione explicitamente as contas que validarão o fluxo. Configure o nome, o e-mail de suporte, o domínio verificado, a página inicial e a política de privacidade; declare os escopos `openid`, `email` e `https://www.googleapis.com/auth/colaboratory`. Publique em produção e envie a verificação solicitada pelo Google, com justificativa dos escopos e demonstração do fluxo de autorização e análise. Enquanto a verificação não estiver concluída, consulte as restrições exibidas no projeto antes de liberar o instalador ao público. Valide o instalador em computadores limpos com contas diferentes, incluindo fechar e reabrir o aplicativo. A execução no Colab também depende da elegibilidade e da disponibilidade de runtime da conta conectada.

O DMG macOS gerado sem Developer ID é apenas para testes controlados. Para distribuição macOS sem impedimentos do Gatekeeper, assine o aplicativo com Developer ID e envie-o à notarização da Apple. O instalador Windows sem assinatura de código pode exibir um aviso do SmartScreen.

### Gerar instaladores para Mac e Windows

O build local no Mac Intel gera `src-tauri/target/release/bundle/dmg/Behavior Tracker_0.1.0_x64.dmg` com o Client ID definido no ambiente, conforme o comando acima. Para gerar as versões macOS Intel, macOS Apple Silicon e Windows x64 no GitHub, use **Actions → Build desktop installers → Run workflow**. Os três arquivos aparecem como artefatos separados da execução por sete dias. O workflow compila cada plataforma no runner correspondente e valida os pesos antes de criar os instaladores.

Antes de executar o workflow, publique `best_detector.pth` e `snapshot-hrnet_w32-001.pt` como assets da release fixa `models-wistar-df-v2-r1`, após confirmar o direito de redistribuição indicado acima. O YAML e o manifesto de hashes já estão no repositório. Se faltar a release ou os hashes não conferirem, o workflow para antes da compilação. O workflow não publica instaladores automaticamente como release; revise e assine os artefatos antes da distribuição pública.

```sh
npm install
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

O app usa Tauri 2, React, TypeScript e Vite. FFmpeg/ffprobe são necessários para preparar e verificar o vídeo. Os comandos de análise local, teste híbrido, teste curto de rastreamento e treino personalizado não estão disponíveis. Dados de execuções anteriores são mantidos para leitura e revisão.

Para montar um instalador, coloque os três pesos v2 validados em `models/wistar_df_v2/` e execute `node scripts/check-release-models.mjs` antes de `npm run tauri build`. O utilitário `scripts/prepare_wistar_df_v2_bundle.py` aceita apenas caminhos locais explícitos (`--detector`, `--hrnet`, `--config`) e gera o manifesto. Os arquivos grandes são ignorados pelo Git; distribua o instalador gerado, que já contém o bundle.
