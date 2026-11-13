# Preparação de mídia para Nado Forçado

Política `fst-adaptive-1`, aplicada somente ao FST quando a análise é iniciada:

1. MP4 H.264 4:2:0, sem rotação e com geometria e tempos válidos: enviar o arquivo original. O SHA-256 calculado no staging é conferido novamente no Colab. A validação local decodifica amostras no início e perto do fim, sem percorrer todos os frames.
2. H.264 4:2:0 em outro contêiner: copiar o fluxo visual para MP4 sem recodificar. A contagem, ordem e PTS dos pacotes são comparados antes de usar a cópia.
3. Codec ou formato de pixels incompatível: tentar os encoders de hardware do sistema e, se não funcionarem, `libx264`. A conversão mantém a resolução, conta os pacotes e compara os tempos de apresentação. O relatório registra o encoder e informa que os pixels mudaram.

A disponibilidade do encoder é verificada executando a conversão no binário empacotado. A política não depende de um nome de GPU ou da versão declarada do FFmpeg.

O arquivo original nunca é sobrescrito. Vídeos com rotação, resolução divergente da calibração, tempos inválidos ou resolução ímpar que exija conversão são rejeitados com uma mensagem específica. A política de Campo Aberto continua independente.

Preparações anteriores são reutilizadas pelo SHA-256 do original, dimensões e versão da política. O relatório guarda método, encoder, duração local e uso de cache. Se houver uma cópia convertida, o cache a vincula ao novo experimento por link local ou cópia, preservando o original de cada seleção.

O workflow manual `build-installers.yml` executa os testes de preparação com os binários FFmpeg e ffprobe empacotados em Linux x64, Windows x64, Mac Intel e Apple Silicon. Esse teste cobre a compatibilidade local dos binários e as três decisões da política. A confirmação de desempenho e de qualidade anatômica requer uma execução real com o mesmo vídeo FST e comparação dos resultados brutos; o teste de mídia isolado não valida o tracking.
