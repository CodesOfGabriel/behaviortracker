# Gate P0 — viabilidade da integração Google Colab

Status: **implementado no aplicativo, execução real ainda não validada neste repositório**.

O botão executa o fluxo documentado e exibe falhas do provedor, mas o gate só pode ser considerado concluído depois de uma execução real registrada. O aplicativo não anuncia processamento gratuito nem cria fallback pago.

O BehaveTracker possui credenciais seguras, OAuth 2.0 + PKCE, consultas de elegibilidade, criação/reuso de runtime, upload em blocos, sessão MCP resumível, execução do DeepLabCut e retorno do CSV. Os itens abaixo permanecem desmarcados porque uma compilação local não substitui evidência de uma execução real na conta alvo.

## Evidências obrigatórias

- [ ] Cliente OAuth do tipo Desktop configurado com PKCE/S256.
- [ ] `GET /v1beta/subscription` executado em conta de teste, sem registrar token.
- [ ] `GET /v1beta/runtimespecs` executado e respostas sanitizadas arquivadas.
- [ ] Runtime criado ou reutilizado com uma spec realmente elegível.
- [ ] Operação de criação acompanhada até estado terminal.
- [ ] `connectionInfo` obtida e utilizada sem persistir credencial efêmera.
- [ ] Sessão Jupyter iniciada via MCP e saída de uma célula recuperada.
- [ ] Vídeo transferido em blocos e verificado por tamanho e SHA-256 no runtime.
- [ ] DeepLabCut executado e CSV canônico recuperado pelo aplicativo.
- [ ] Custo observado e exigência de billing registrados.
- [ ] Uso externo via aplicativo desktop confirmado como permitido no tier testado.

## Regra de decisão

Uma listagem de specs elegíveis não comprova alocação, execução nem permissão de uso. Se o cenário Free não for permitido ou viável, o provedor remoto permanece desabilitado e o editor local continua funcionando com importação de poses.

Nunca implementar automação do navegador, múltiplas contas, APIs não documentadas ou fallback pago automático.

