# Stongel · Formulários de Obras (POC)

App web instalável (PWA) para registrar obras, preencher os formulários OB-01 a OB-22 e fazer a **passagem de bastão** por e-mail. Esta é a versão de validação (POC), publicada no GitHub Pages, com dados numa Planilha Google.

## Como funciona

```
Celular / PC (PWA no GitHub Pages)  ──►  Apps Script (App da Web)  ──►  Planilha Google
  cópia local p/ uso offline              login por código, dados,       abas: obras, forms, team, handoffs,
  fila de envio quando sem internet        envio de e-mails               usuarios, acessos, sessoes, log
```

- **Acesso:** e-mail + código de 6 dígitos, cadastrados pelo administrador na aba `usuarios` (só entra quem tem `ativo = SIM`). Depois do login o aparelho fica conectado por 30 dias.
- **Controle:** cada tentativa de login fica na aba `acessos` (ok, código errado, não cadastrado, inativo, bloqueado), e cada aparelho logado fica na aba `sessoes`. Cinco códigos errados em 15 minutos bloqueiam o e-mail por 15 minutos.
- **Offline:** o app abre sem internet e guarda as alterações numa fila; quando a conexão volta, elas vão para a planilha. A cada 30 s o app busca o que os outros mudaram.
- **Sem servidor configurado** (`config.js` vazio), o app funciona como a versão original: dados só no aparelho e e-mail aberto no programa de e-mail.
- **Formulários:** OB-01 a OB-21 ficam dentro de cada obra, organizados pelas etapas do manual. O OB-22 (Matriz de Habilidades) é geral, não pertence a uma obra.
- **Ajustes:** "Sincronizar agora", "Enviar e-mail de teste para mim" (confere se o envio pela planilha funciona), **Baixar backup** (arquivo `.json` com todos os dados do aparelho) e **Restaurar backup**. Conectado à planilha, restaurar envia todos os registros do backup para ela e substitui os de mesmo código.

## Arquivos

| Arquivo | Para quê |
|---|---|
| `index.html` | O app inteiro |
| `config.js` | URL do App da Web (Apps Script) |
| `apps-script/Code.gs` | Código para colar no Apps Script da planilha |
| `manifest.webmanifest`, `sw.js`, `icons/` | Instalação como app e funcionamento offline |

## Instalação (uma vez)

### 1. Planilha e Apps Script
1. Na conta Google que vai enviar os e-mails (ex.: obras@...), crie uma **Planilha Google** nova, por exemplo "Stongel Obras - dados".
2. Na planilha: **Extensões → Apps Script**. Apague o conteúdo, cole o arquivo [`apps-script/Code.gs`](apps-script/Code.gs) inteiro e salve.
3. No topo do editor, escolha a função **`configurar`** e clique em **Executar**. Aceite as permissões (aparece "app não verificado": Avançado → Acessar). Ela cria as abas.
4. **Implantar → Nova implantação → ⚙ App da Web**. *Executar como:* **Eu**. *Quem pode acessar:* **Qualquer pessoa**. Copie a URL (termina em `/exec`).

### 2. Site
1. Edite `config.js` e cole a URL em `scriptUrl`. Faça commit (pode ser pelo próprio site do GitHub, no lápis ✏️).
2. Em **Settings → Pages** do repositório: *Source:* `Deploy from a branch`, branch `main`, pasta `/ (root)`.
3. Em 1 a 2 minutos o app fica em `https://<usuario>.github.io/<repositorio>/`.

### 3. Liberar pessoas
Na aba `usuarios`, uma linha por pessoa:

| email | nome | papel | ativo | codigo |
|---|---|---|---|---|
| fulano@stongel.com.br | Fulano | encarregado | SIM | 482913 (gerado sozinho) |

- Ao digitar o e-mail, a planilha gera sozinha um **código de 6 dígitos** na coluna `codigo`. Passe o e-mail e o código para a pessoa.
- Para trocar o código: apague a célula (gera outro), digite 6 dígitos à mão, ou use o menu **Stongel → Gerar novo código para a linha selecionada**.
- O menu **Stongel → Gerar códigos que faltam** preenche quem ainda está sem código.
- Cadastre você mesmo primeiro, com `papel = admin`.

- Para bloquear alguém: `ativo = NÃO` (vale em até 2 minutos).
- Para derrubar um aparelho específico: na aba `sessoes`, coluna `revogado = SIM`.

### Instalar no celular
- **Android (Chrome):** abrir o link → menu ⋮ → **Instalar app**.
- **iPhone (Safari):** abrir o link → Compartilhar → **Adicionar à Tela de Início**.

## Mudou o código?
- **Apps Script:** Implantar → Gerenciar implantações → ✏️ → Versão: **Nova versão** (a URL continua a mesma).
- **Site:** com internet, o app sempre busca `index.html` e `config.js` direto do GitHub Pages, então os aparelhos pegam a versão nova sozinhos. Mesmo assim, aumente `VERSION` em `sw.js` a cada mudança para renovar a cópia offline.

## Limites desta POC
- Todos os usuários liberados veem todas as obras; o `papel` ainda é só informativo (permissões por papel ficam para a versão do servidor interno).
- Se duas pessoas editarem o **mesmo formulário** ao mesmo tempo, vale a última gravação.
- Gmail gratuito envia ~100 e-mails/dia (passagens de bastão); Google Workspace, ~1.500.
- Os códigos ficam visíveis para quem abre a planilha: compartilhe a planilha só com quem administra.
- O repositório é público: o código e o logo ficam visíveis. Nenhum dado nem código de acesso fica no repositório; os dados ficam na planilha.

## Próxima fase
A migração para o servidor interno (login e senha, controle de acesso por papel) troca apenas o objeto `API` em `index.html` (`login`, `list`, `bulk`, `send`, `logout`). Os dados da planilha já estão em JSON por registro, prontos para importar num banco.
