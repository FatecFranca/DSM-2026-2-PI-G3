# Enviar atualizações do PI ao GitHub

Repositório: https://github.com/FatecFranca/DSM-2026-2-PI-G3

Esta pasta está conectada ao repositório do grupo. A branch das alterações de front-end é `feat/frontend-encontraa-2026-11-09`.

## Ver e testar o código dos colegas

No GitHub, selecione a branch acima. Para executar no computador, clone o repositório:

```powershell
git clone https://github.com/FatecFranca/DSM-2026-2-PI-G3.git
cd DSM-2026-2-PI-G3
git switch feat/frontend-encontraa-2026-11-09
node scripts/server.cjs
```

Abra http://localhost:5500. O mapa precisa de internet. Para encerrar, pressione Ctrl+C.

Se já tiver um clone, salve seu trabalho antes de trocar de branch. Use `git fetch origin` e depois `git switch feat/frontend-encontraa-2026-11-09`.

## Enviar novas alterações desta pasta

Abra o terminal nesta pasta, confira a branch e os arquivos alterados:

```powershell
git branch --show-current
git status
node tests/precos.test.cjs
git diff
```

Adicione somente os arquivos que você quer enviar. Exemplo para HTML, CSS e JavaScript:

```powershell
git add index.html style/style.css scripts/App.js
git diff --cached --stat
git commit -m "fix: descreva o ajuste realizado"
git push
```

Inclua os caminhos dos novos arquivos no `git add` quando necessário. O `commit` registra no computador; o `push` envia ao GitHub. O Pull Request da branch recebe os novos commits automaticamente.

## Juntar as alterações à main

Abra o Pull Request no GitHub, peça a revisão dos colegas e faça o merge depois da revisão. Para atualizar um clone que já está na main, use `git pull --ff-only`.

O código fica disponível na branch antes do merge. O envio ao GitHub não publica automaticamente um site na internet.
