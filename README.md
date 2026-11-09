# PI — EncontraA!

Front-end do Projeto Integrador do grupo 3. HTML, CSS e JavaScript, sem etapa de build.

## Executar

Instale o Node.js e abra um terminal nesta pasta:

```powershell
node scripts/server.cjs
```

Acesse http://localhost:5500. Para encerrar, pressione Ctrl+C. Também é possível usar o Live Server do VS Code. Não abra o HTML diretamente por `file://`: a consulta dos arquivos JSON precisa de um servidor HTTP.

## Telas de referência

1. Ao entrar, aparece o formulário de endereço sobre o conteúdo esmaecido.
2. Informe um endereço e clique em Buscar para consultar os postos, com filtros na lateral.
3. Clique no círculo laranja na borda do mapa para recolher os filtros e ver quatro colunas de cards. Clique novamente para expandir.

O layout se adapta ao celular. Teclado: Tab navega, Enter ativa cards e botões, Escape fecha os diálogos. Sobre, Dicas e perfil abrem informações locais.

Os postos exibidos e suas coordenadas vêm do arquivo local do OpenStreetMap (`dados/json/osm_BR.json`). A grade espacial da ANP permite consultar apenas registros próximos para associar os preços, com validações de nome, proximidade, bandeira e CNPJ quando disponíveis. As coordenadas do endereço ANP não criam marcadores. Registros com localização apenas do município e associações ambíguas não fornecem preços aos marcadores. Sem OSM, a interface avisa que não consegue confirmar as localizações. O mapa inicial abre em Franca e a busca permite escolher outra região. Confira a data de coleta: os preços não são atualizados em tempo real. O mapa e a busca de endereço precisam de internet.

A logo principal em `img/logo.png` foi preservada. Os logos reais das bandeiras ficam em `img/bandeiras/` e o cadastro com as fontes em `dados/json/bandeiras.json`. Shell, BR/Petrobras, Ipiranga e ALE substituem as antigas aproximações. Os logos são arquivos das marcas, obtidos de sites oficiais ou fontes identificadas no cadastro. J.R Distribuidora permanece apenas com o nome porque não foi possível confirmar um logo confiável. Branca usa fundo branco; Sem bandeira usa cinza.

## Arquivos

- `index.html`: estrutura e diálogos.
- `style/style.css`: cores, tamanhos e layouts responsivos.
- `scripts/App.js`: busca, dados, mapa, filtros e estados da interface.
- `img/`: identidade visual e marcas dos cards.
- `dados/`: bases existentes, preservadas.

Consulte [GUIA-GITHUB.md](GUIA-GITHUB.md) para enviar as alterações ao grupo.

## Verificar os preços

Execute `node tests/precos.test.cjs`. O teste usa as bases reais e casos controlados para verificar a grade espacial, os vínculos entre OSM e ANP, a exclusão de posições artificiais, os preços, os filtros, as etiquetas e os raios.
