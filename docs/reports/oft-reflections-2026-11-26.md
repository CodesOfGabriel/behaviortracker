# Reflexos e sombras na segmentação de Campo Aberto

## Caso reproduzido

A imagem enviada corresponde à execução local `538657e0`, com vídeo de 586 × 480, 25 fps e 7.610 quadros. Entre aproximadamente 13,6 e 14 s, a busca de baixo contraste pela cabeça na parede incorporava uma região escura acima do animal. O marcador anatômico era então projetado nessa região falsa.

Aos 14 s, o retângulo salvo tinha origem `(175, 44)` e dimensões `39 × 113`. Na reprodução corrigida do trecho, passou a `(178, 77)`, com dimensões `21 × 77`. Aos 13,6 s, a silhueta corrigida ainda ultrapassa a linha do piso: o filtro não usa o chão como limite da cabeça.

## Alteração

A subtração absoluta de fundo detectava tanto o animal quanto alterações causadas por sombras e reflexos. O critério anterior de semelhança com a cor corporal também era permissivo na parede.

A nova etapa `body_background_likelihood_v1` compara os pixels atuais com a aparência corporal congelada e com o fundo local, compensando a variação global de iluminação. Pixels que favorecem o fundo são retirados antes da extração dos contornos; isso separa regiões falsas que estavam conectadas ao corpo. O preenchimento das regiões internas conserva marcas escuras dentro da silhueta. Candidatos com suporte corporal insuficiente não atualizam a identidade ou o Kalman.

A recuperação fraca de cabeça/pescoço na parede usa o mesmo critério. Para conservar partes reais pouco contrastantes, admite uma pequena faixa de proximidade à cor corporal. Quando o torso associado entra em uma região mais escura, a extensão usa sua aparência atual, desde que ela continue compatível com a referência congelada. Isso não reensina a identidade do animal a partir da parede.

A comparação usa LAB com pesos `0,5 / 1 / 1`, margem relativa de 4 unidades e proximidade absoluta de 12. Esses valores são parâmetros de engenharia, sem interpretação probabilística ou validação de acurácia anatômica. O cálculo da máscara é restrito aos pixels de foreground para limitar o custo em CPU.

O filtro é exclusivo de Campo Aberto. O piso calibrado não é alterado. Novas posições e medidas de silhueta podem mudar porque o foreground falso foi retirado; os arquivos e anotações das execuções históricas permanecem preservados.

## Preservação da cabeça na parede

Uma primeira versão excessivamente restritiva descartou parte da cabeça sombreada do R2. A comparação entre as versões foi usada para corrigir essa regressão antes de concluir o trabalho.

Na reprodução do R2 aos 17 s, a versão final mantém a origem da caixa em `(217,96875; 149,0625)`, acima da borda do piso, com extensão corporal apoiada nos pixels atuais. As regressões sintéticas cobrem cabeça de baixo contraste, cabeça mais semelhante à parede que ao torso, mudança local de sombra sem alterar a identidade congelada, reflexo escuro conectado e rejeição de foreground de contraste contrário para animais claros e escuros.

Os artefatos privados ficam em `artifacts/reflection-guard-2026-11-26/`, excluídos do Git. As variantes `probe`, `refined`, `full`, `gray20`, `r220` e `r2-*` anteriores à verificação final são experiências de desenvolvimento, não resultados da versão final. A versão final é identificada pelos hashes em `final/started.json` e pelo relatório de verificação correspondente.

Versões: motor `opencv-box-19`, vídeo local `local-audit-11`, vídeo Wistar `oft-layered-video-8`, orientação temporal `offline_pose_v2`. O manifesto inclui `silhouetteSupport`, e a reconstrução Wistar verifica essa política para evitar reutilizar a geometria antiga. Uma execução OpenCV histórica precisa de nova análise para recalcular sua silhueta; atualizar apenas o MP4 conserva as observações salvas.

## Limites

A inspeção do trecho demonstra a remoção da região falsa apontada. Não há máscaras corporais humanas para medir IoU em todos os quadros. Reflexos com aparência corporal muito semelhante continuam exigindo avaliação própria; a filtragem por aparência e fundo não constitui um detector semântico treinado de reflexos. O classificador de rearing não foi treinado ou validado nesta alteração. A reprodução usa CPU; não representa execução remota de Colab/GPU.

## Verificação final

- Reprodução completa de 7.610 quadros em CPU, usando o fundo congelado e os timestamps salvos. Os hashes dos módulos registrados no início continuaram iguais ao código final. A leitura das imagens de referência usa o quadro arredondado pelo fps, em vez da busca por tempo do FFmpeg; o replay também não executa o guarda de deslocamento global da câmera. Não representa um novo teste pela interface Tauri.
- O arquivo original de amostras manteve o SHA-256 `d1f1420d9f88852d99b845018c51771f3b7e3da3072a94bd132f7525c9a6f0b1`. Todos os índices e timestamps da reprodução coincidem com os originais.
- O caso aos 14 s passou de caixa `(175, 44, 39, 113)` para `(178, 77, 21, 77)`. A cabeça aos 13,6 s continua além do piso. O R2 aos 17 s conserva caixa `(217,96875; 149,0625; 75,9375; 40,78125)` e cabeça estimada em `(228; 157)`, identificada como projeção na parede.
- As estimativas de visualização, orientação e comportamento continuam com `metricEligible: false`. Este vídeo não disparou parada por intervenção humana em nenhuma das duas versões; essa execução não demonstra a detecção de retirada do animal.
- Houve 6.783 quadros aceitos pela lógica de qualidade, contra 6.286 anteriormente, mas também 197 saídas com fonte predita, contra 5. Isso descreve cobertura e mudança de rejeição, não acurácia. A maior sequência predita durou 41 quadros, de 254,76 a 256,36 s; ainda existem lacunas que precisam de revisão. Não são 100% de observações confirmadas.
- Suite Python: 352 testes, 351 aprovados e 1 exclusão esperada específica de Windows. Suite Rust: 107 aprovados. Incluem as cinco novas regressões de reflexo/sombra e preservação da cabeça na parede. `git diff --check` sem erros.

Artefatos finais locais: `final/verification.json`, `final/comparacao-reflexo.png` e `final/corrigido-12-a-18s.mp4`, dentro da pasta privada de artefatos citada acima. O recorte tem 150 quadros a 25 fps. Não houve execução remota no Colab/GPU, commit ou publicação.

A exportação foi também executada pelo renderizador real `local_audit_video.render`, versão `local-audit-11`. O MP4 completo `final/video-corrigido.mp4` foi decodificado e conferido com 7.610 quadros; o recorte final foi extraído desse MP4 e novamente decodificado com 150 quadros. O manifesto confirma `textOverlay: false` e marcador de cabeça em triângulo. Foram desenhados eixos em 7.608 quadros, dos quais 1.455 usam a fonte visual inferida. A presença de desenho não muda a condição de estimativa nem comprova precisão anatômica.
