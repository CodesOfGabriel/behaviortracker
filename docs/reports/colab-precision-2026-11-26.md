# Campo Aberto no Colab: revisão do detector e da pose

A política `hybrid-df-precision-2` passa a ser usada nas novas análises Colab de Campo Aberto com `wistar_df_v2`. O ponto de partida é o [diagnóstico do Teste R2](colab-r2-diagnosis-2026-11-26.md), cujo detector encontrava caixas em 98,74% dos quadros, mas cuja HRNet só entregava `mouse_center` acima do limiar em 6,51%. Esses números são cobertura da saída, não acurácia anatômica.

## Alterações

- O Faster R-CNN passa de `min_size=640 / max_size=1280` para `1280 / 2048`. A resolução original do vídeo e as coordenadas exportadas são preservadas. A ampliação interna não cria informação ausente no vídeo.
- A associação compara caixas brutas entre quadros, sem incluir a margem reservada ao recorte da pose. Seleções com caixas separadas de pontuação de associação semelhante ficam explicitamente ambíguas. Mudanças extremas de tamanho sem sobreposição, saltos, caixas inválidas e scores fora do intervalo são rejeitados.
- O início e a retomada após mais de 16 quadros sem observação exigem score de detector ≥ 0,65. A continuidade mantém o limite de 0,30. A preferência geométrica pelo piso é reduzida para que ela não domine uma detecção de maior score na parede durante exploração vertical.
- A HRNet reavalia cada quadro com caixa confirmada em três rotações, de 90°, 180° e 270°, e uma vista com CLAHE. As coordenadas são convertidas de volta ao mesmo quadro original. Os nomes anatômicos não são trocados nas rotações.
- Cada ponto precisa de pelo menos duas vistas com score ≥ 0,60 e distância entre todos os pares de até 10% da diagonal da caixa, com tolerância mínima de 3 px. A previsão original participa como quinta vista quando elegível. Grupos de mesmo tamanho que divergem entre si são rejeitados. A coordenada selecionada usa a mediana do grupo; o score é o menor score do grupo, sem aumento artificial de confiança.
- Há rejeição de pontos fora da imagem/caixa, poses com pontos centrais colapsados e saltos isolados entre vizinhos temporalmente contíguos. Lacunas continuam lacunas; não há interpolação nem substituição por coordenadas do quadro anterior.
- O CSV, o renderer e a interface respeitam `tracking_accepted=false`, inclusive quando o score bruto é alto. Os pontos rejeitados não entram no desenho nem nas métricas por esse caminho. Confirmações humanas mantêm sua precedência. A regra existente que permite referência pelo centro de uma caixa confirmada permanece independente da confiança da pose anatômica.

A HRNet continua usando o mesmo checkpoint verificado e seu pré-processador oficial. O formato das entradas `(imagem RGB, contexto com bboxes xywh)` e a reutilização do runner seguem a [implementação oficial da inferência DeepLabCut 3.0.2](https://github.com/DeepLabCut/DeepLabCut/blob/v3.0.2/deeplabcut/pose_estimation_pytorch/runners/inference.py) e a [fábrica do runner](https://github.com/DeepLabCut/DeepLabCut/blob/v3.0.2/deeplabcut/pose_estimation_pytorch/apis/utils.py). O provisionamento Colab fixa `deeplabcut[modelzoo]==3.0.2` para evitar alterações silenciosas dessa API.

## Custo, memória e rastreabilidade

O processamento deve ser mais lento: o detector usa imagens maiores e há quatro vistas adicionais por quadro observado. O lote inicial do detector é menor; após falta de memória, ele é reduzido sem voltar a subir repetidamente. A retomada exige reposicionar o vídeo e mantém as contagens de entrada/saída, evitando deslocamento dos quadros.

`pose_raw.csv` e `pose_raw.h5` preservam a inferência original. `pose_refinement.csv` registra coordenadas e scores brutos/selecionados, quantidade de vistas concordantes, origem, aceitação e motivo da rejeição por ponto. Sua escrita é sequencial para evitar manter uma segunda tabela de auditoria inteira em memória. `pose_filtered.csv` distingue o score original do selecionado. O manifesto registra a versão, a resolução interna e as contagens de aceitação; `scientificallyValidated` permanece `false`.

O aplicativo baixa os novos artefatos conforme o manifesto do worker que efetivamente executou. Uma execução antiga retomada não precisa fornecer um arquivo que ainda não existia. As análises anteriores não são sobrescritas. A nova política não é aplicada ao RAM, FST ou processamento local.

## Conferência nos dados salvos do R2

Foram aplicados apenas os controles geométricos e temporais às previsões já salvas de `openfield02.mp4`, sem nova inferência. Entre 12.018 pontos acima do limiar, 13 foram sinalizados: 11 saltos temporais e 2 pontos fora da caixa/tolerância. Restaram 12.005 pontos aceitos por esses controles; os 289 quadros de centro acima do limiar permaneceram 289. Os arquivos originais foram preservados.

Essa conferência não demonstra que os 13 pontos estavam anatomicamente errados nem estima o ganho das novas vistas. Ela confirma que os controles executam sobre os dados reais e que só filtrar a saída antiga não recupera a cobertura baixa do centro. [Resultado reproduzido em JSON](../../artifacts/colab-precision-2026-11-26/saved-r2-quality-audit.json).

## Validação e limites

Os testes exercitam consenso e desacordo, score conservador, inversão das rotações, RGB e padding, rejeição de coordenadas inválidas, lacunas, poses colapsadas, saltos isolados versus movimento contínuo, término prematuro do vídeo, recuperação por vistas concordantes, preservação dos dados brutos e exportação. O fluxo real de integração Python usa um runner neural simulado; OpenCV, NumPy, pandas, refinamento e escritores executam de verdade. O backend verifica o empacotamento dos módulos e a compatibilidade de download com resultados antigos/RAM. A regressão de frontend verifica que importar e reexportar a rejeição mantém desenho e métricas bloqueados.

| Verificação local | Resultado |
| --- | --- |
| `.venv-test/bin/python scripts/quality/python-tests.py` | 252 testes; aprovado, com 1 ignorado por ser específico de bloqueio de arquivo no Windows |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib colab::tests` | 50 aprovados |
| `npm run test:unit -- --reporter=dot` | 210 aprovados, em 34 arquivos |
| `npx playwright test tests/ui/tracking-sync.spec.ts tests/ui/rearing-annotation.spec.ts` | 16 aprovados em Chromium e WebKit; IPC Tauri simulado |
| `npm run build` | TypeScript e Vite aprovados; aviso de tamanho de bundle permanece |
| `git diff --check` | Aprovado |

Não houve treinamento de novos pesos nem execução CUDA/Colab nesta alteração. As marcações temporais de rearing não constituem referência de posições anatômicas. Concordância entre transformações do mesmo modelo é um teste de consistência, não validação independente. A política pode rejeitar mais pontos e reduzir cobertura, além de permitir erros sistemáticos em que várias vistas concordam.

Para medir a melhora, é necessário executar uma nova análise do R2 e comparar posições/erros, cobertura e lacunas com pontos anatômicos revisados manualmente. O resultado anterior continua disponível para comparação. Se a HRNet continuar inadequada à gravação, será necessária adaptação supervisionada com essas referências e validação em outra sessão; a resolução maior e o consenso não garantem resolver uma incompatibilidade do checkpoint.

Não foram feitos commit, push, publicação ou alterações na VPS.
