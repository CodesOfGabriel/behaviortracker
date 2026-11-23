# Model Delivery v2

O instalador contém a configuração pequena e o manifesto Wistar, além dos binários FFmpeg/ffprobe. Os checkpoints de 173.392.347 e 118.196.193 bytes são obtidos somente quando uma análise neural precisa deles. A soma retirada dos recursos do instalador é 291.588.540 bytes antes da compactação; a redução real do DMG/NSIS/AppImage depende do empacotamento.

`models/wistar_df_v2/manifest.json` registra tag fixa, URLs, tamanhos, SHA-256, arquitetura, protocolos e compatibilidade de runtime. O teste Rust verifica que os valores usados pelo runtime coincidem com esse registro. FST continua utilizando seu fluxo DeepLabCut próprio; não recebe o bundle Wistar por essa mudança.

O Colab verifica seu cache e baixa os dois checkpoints diretamente da release `models-wistar-df-v2-r1`. A configuração YAML pequena é enviada como dados do próprio aplicativo, com tamanho/SHA-256 verificados e publicação atômica; a release atual não contém esse asset. A inicialização aceita entrega remota sem exigir pesos no computador. Um bundle local completo e verificado continua servindo como alternativa de upload quando o download remoto falha. O aplicativo comunica a falha quando nenhuma origem verificada está disponível.

`model_delivery.py` é o downloader compartilhado. Verifica tamanho e SHA-256 antes de reutilizar cache ou publicar arquivo. Downloads usam temporários exclusivos no mesmo diretório, `fsync` e `os.replace`; corrupção, interrupção e cancelamento cooperativo preservam o arquivo anterior. Há limite de tamanho durante streaming e três tentativas para erros transitórios. Progresso é publicado em stdout ou por callback. O monitor de jobs existente controla cancelamento da tarefa Colab. A interrupção forçada de um processo pode deixar temporários; estes nunca são utilizados como checkpoints.

A função `install_bundle` prepara futura inferência neural local sob `app_data_dir/models/{bundleId}`, validando compatibilidade e tag. Não há novo motor neural local nem download no início do aplicativo. O diretório de dados deve ser fornecido pelo runtime Tauri. A política de cache é reutilização verificada e remoção manual, sem expiração automática; atualização do app não apaga pesos. No Colab o cache dura enquanto o armazenamento do runtime persistir, sem promessa de persistência entre runtimes.

Verificações:

- `node scripts/check-release-models.mjs`: contrato, configuração pequena e ausência de checkpoints em `bundle.resources`; funciona sem checkpoints locais ou rede.
- `node scripts/check-release-models.mjs --local`: adicionalmente verifica os dois checkpoints locais.
- `node scripts/check-release-models.mjs --remote`: adicionalmente faz streaming e verifica os dois checkpoints remotos; transfere cerca de 292 MB, sem gravar no repositório.

O workflow continua manual (`workflow_dispatch`). Foram alteradas as instruções de empacotamento; o tamanho final e a instalação nos quatro sistemas precisam ser verificados nos respectivos artefatos. Testes locais não representam uma execução real CUDA/Colab.
