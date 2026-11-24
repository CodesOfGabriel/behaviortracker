# Componentes shadcn/ui e detalhes lado a lado

As abas compartilhadas, os cards de informações e os seletores de execução usam código do registro oficial shadcn/ui, estilo New York, com primitivas Radix. Os arquivos são mantidos no projeto, conforme o modelo de distribuição do shadcn/ui. Não há execução de CLI durante o build nem dependência de um serviço remoto em tempo de uso.

Fontes primárias consultadas:

- [Tabs](https://ui.shadcn.com/docs/components/radix/tabs) — `src/components/ui/tabs.tsx`.
- [Card](https://ui.shadcn.com/docs/components/radix/card) — `src/components/ui/card.tsx`.
- [Select](https://ui.shadcn.com/docs/components/radix/select) — `src/components/ui/select.tsx`.
- [Badge](https://ui.shadcn.com/docs/components/radix/badge) — `src/components/ui/shadcn-badge.tsx`. O nome evita conflito com o componente legado `Badge.tsx` em sistemas de arquivos sem diferenciação entre maiúsculas e minúsculas.

Código obtido de `https://ui.shadcn.com/r/styles/new-york-v4/{component}.json`; a [licença MIT original](licenses/shadcn-ui-MIT.txt) acompanha a adaptação. Imports de `cn` foram direcionados ao utilitário local com `clsx` e `tailwind-merge`. As versões de dependências estão fixadas pelo `package-lock.json`.

## Interface

O Resumo separa o seletor de execução, quatro indicadores principais e os metadados do experimento. O tema dos novos componentes usa tokens próprios para evitar conflitos com as cores existentes do editor. A interface usa superfícies neutras, bordas discretas, números tabulares e destaque em verde para observações. Os seletores usam portal, navegação por teclado, fechamento com Escape e retorno de foco ao botão; as abas usam foco e navegação Radix.

Em Detalhes, a coluna esquerda contém o vídeo e seus controles. A direita contém os gráficos e resultados da execução selecionada. O FST mantém históricos separados por animal; o Campo Aberto mostra locomoção, ocupação visual e métricas complementares; o RAM mantém deslocamento, eventos e revisão conforme os dados disponíveis. Os controles de correção da posição e da caixa ficam recolhidos. Abaixo de 780 px, as colunas são empilhadas.

O gráfico de locomoção usa centros de caixas ou, no RAM Colab, centros observados existentes. As séries usam PTS, conservam lacunas e são identificadas em px/s. Navegar pelo gráfico altera o tempo do vídeo. Esses gráficos não alteram a elegibilidade científica, não convertem pixels para distância no piso e não classificam comportamento.

O vídeo original salvo pode ser recuperado do staging no RAM, sem exigir uma nova seleção do arquivo quando ele já está disponível. O MP4 de auditoria e suas regras de renderização permanecem independentes da organização da interface.

## Verificação

O [relatório desta mudança](reports/shadcn-results-ui-2026-11-24.json) registra hashes, testes e capturas. A verificação de navegador usa comandos Tauri simulados, experimentos genéricos e um MP4 de teste. Foram conferidos os três protocolos, local e Colab, navegação por teclado, troca de execução, sincronização pelo gráfico e layouts de 1440, 980 e 390 px. Isso não representa interação com o aplicativo Tauri instalado nem execução remota de Colab/GPU.
