# Instalação

> Esta é a tradução em português de [setup.md](setup.md). A versão em inglês é
> a canônica; em caso de divergência, vale a inglesa.

Instalação ponta a ponta para hospedar sua própria instância. Escrito para um
único usuário rodando um único vault, o que é o design, não uma limitação a
contornar.

Todos os hostnames abaixo são placeholders (`vault.example.com`); use os seus.

## O que você precisa

- Uma VPS Linux com systemd (qualquer instância pequena serve; o servidor é
  I/O-bound numa pasta de arquivos markdown).
- Uma conta Cloudflare com Workers e KV, e um domínio gerenciado na Cloudflare
  (para o hostname do túnel).
- Uma forma de sincronizar seu vault Obsidian com a VPS de forma
  **bidirecional** (veja o [passo 3](#3-escolha-e-configure-um-cliente-de-sync)).
- Node 22 e pnpm (via corepack), na VPS para o servidor e na sua máquina para
  fazer o deploy do Worker.

## 0. Opcional: teste local primeiro (sem VPS, sem túnel, sem Worker)

Você pode rodar o servidor MCP na sua própria máquina contra qualquer pasta de
notas markdown, com a checagem do segredo de origem desativada. É a forma mais
rápida de ver as tools funcionando antes de assumir infraestrutura.

```sh
corepack enable
pnpm install
pnpm build

VAULT_PATH="$HOME/my-vault" \
MCP_HOST=127.0.0.1 \
MCP_ALLOW_INSECURE_LOCAL=1 \
node apps/mcp-server/dist/main.js
```

`MCP_ALLOW_INSECURE_LOCAL=1` desativa o gate do segredo compartilhado; ele só
tem efeito quando o servidor está ligado ao loopback, e nunca deve ser usado em
produção.

Smoke test com curl (o servidor fala MCP streamable HTTP em `POST /mcp`):

```sh
curl -s -X POST http://127.0.0.1:9820/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'
```

Um resultado JSON-RPC com `serverInfo.name: "vault-mcp"` significa que está
vivo. Para explorar as tools interativamente, use o MCP Inspector:

```sh
npx @modelcontextprotocol/inspector
# transport: Streamable HTTP, URL: http://127.0.0.1:9820/mcp
```

## 1. Prepare a VPS: `bootstrap`

O repositório precisa terminar sob o home do usuário dedicado; a parte de
usuário do bootstrap roda a partir do próprio clone e cria links dos scripts no
`~/.local/bin` desse usuário. Numa máquina nova o usuário ainda não existe,
então a primeira execução o cria e para, pedindo para você mover o clone. Esse
loop é esperado:

```sh
git clone https://github.com/<you>/vault-mcp.git
sudo ./vault-mcp/infra/scripts/bootstrap      # primeira execução: cria o usuário e pede para mover o clone
sudo mv vault-mcp /home/vaultmcp/vault-mcp
sudo chown -R vaultmcp: /home/vaultmcp/vault-mcp
sudo /home/vaultmcp/vault-mcp/infra/scripts/bootstrap   # rode de novo até completar
```

`bootstrap` é idempotente, não interativo e não lida com segredos. Ele:

- instala dependências de sistema (git, curl, jq);
- cria o usuário dedicado sem privilégios (`vaultmcp` por padrão);
- habilita **linger** para esse usuário, para que os serviços systemd de
  usuário sobrevivam ao logout e iniciem no boot;
- verifica/instala Node 22, pnpm (corepack) e o binário `cloudflared` (em
  `~/.local/bin`). Note que o Node é um pacote **system-wide** da NodeSource:
  numa máquina que já roda outra coisa em Node, isso também atualiza aquilo (e
  substitui o npm embarcado). Numa VPS compartilhada, cheque o que mais depende
  do Node atual antes da primeira execução;
- cria `~/vault`, `~/.config/vault-mcp/` e diretórios de estado;
- cria links de `start`/`doctor`/`autocommit` em `~/.local/bin` como
  `vault-mcp-*`; é o nome fixo que as units do systemd chamam;
- instala as units **de usuário** do systemd e as habilita (habilitadas, não
  iniciadas: nada roda até você configurar).

Rode de novo quando quiser; cada passo é check-then-act.

Daqui em diante, trabalhe como o usuário dedicado. Note que um shell
`sudo -iu vaultmcp` pode não ter o bus de usuário do systemd; prefira:

```sh
sudo machinectl shell vaultmcp@
```

Se você acabar num shell `sudo -iu`, o sintoma é `systemctl --user` respondendo
`Failed to connect to bus: No such file or directory`. Aponte-o para o runtime
directory do usuário que você está de fato usando:

```sh
export XDG_RUNTIME_DIR=/run/user/$(id -u)
```

Só shells interativos precisam disso. O linger é o que faz as units iniciarem
no boot, e ele não precisa da sua sessão.

## 2. Build do servidor na VPS

Como o usuário dedicado, faça o build do checkout que o bootstrap deixou em
`~/vault-mcp`:

```sh
cd ~/vault-mcp
pnpm install
pnpm build
```

Sem `corepack enable` aqui: o `bootstrap` já colocou `pnpm` em `~/.local/bin`
para esse usuário, e rodar `corepack enable` como usuário sem privilégios falha
com `EACCES`. No layout da NodeSource que o bootstrap instala, o corepack quer
escrever seus shims em `/usr/bin`, que pertence ao root. (Se você pulou o
bootstrap, a forma gravável pelo usuário é
`corepack enable --install-directory ~/.local/bin pnpm`. Nunca use `sudo`:
nada no caminho de runtime deve precisar de root.) Se aparecer
`pnpm: command not found`, `~/.local/bin` não está no `PATH` desse shell.

O `configure` (passo 4) registra a localização deste checkout como
`VAULT_MCP_HOME` no arquivo de env; é onde o script de start procura
`apps/mcp-server/dist/main.js`. Se você mover o checkout, atualize
`VAULT_MCP_HOME` em `~/.config/vault-mcp/env`.

## 3. Escolha e configure um cliente de sync

Um processo separado mantém `~/vault` em sincronia com suas notas. O servidor
MCP não sabe que o sync existe, ele só vê arquivos, então qualquer cliente
funciona, com um requisito rígido:

> **O modo de sync PRECISA ser bidirecional.** Modos de reversão, qualquer
> coisa que trate a cópia do servidor como espelho e reverta mudanças locais,
> vão **destruir silenciosamente toda nota que o servidor escrever**. Uma nota
> criada pelo chat apareceria e sumiria na próxima passada de sync, sem erro em
> lugar nenhum.

Opções:

- **`obsidian-headless`** (sincroniza com o Obsidian Sync): o CLI oficial,
  publicado pelo time do Obsidian. É um cliente genuinamente headless: sem
  Electron, sem Xvfb, sem app desktop forçado a virar servidor. É o caminho
  detalhado abaixo.
- **Qualquer sincronizador de arquivos bidirecional** em que você já confia (por
  exemplo Syncthing, Unison em modo bidirecional) apontado para a mesma pasta
  que seus outros dispositivos sincronizam.

Considere sincronizar um **subconjunto** do vault em vez de tudo: se a VPS for
comprometida, só o que está sincronizado fica exposto (veja o
[modelo de ameaças](threat-model.md)).

### Exemplo passo a passo: `obsidian-headless`

Como o usuário dedicado:

```sh
npm config set prefix ~/.local     # veja abaixo, sem isso o npm -g falha
npm install -g obsidian-headless   # instala o binário `ob`
```

O `npm config set prefix` não é opcional. O prefixo global padrão pertence ao
root (`/usr/lib/node_modules` no layout da NodeSource que o bootstrap instala),
então `npm install -g` como usuário sem privilégios morre com `EACCES`. Não
recorra a `sudo`: o `ob` guarda as credenciais no home de quem o executa, e a
unit roda como `vaultmcp`.

Depois vincule a conta e configure o vault, **interativamente, agora**, para que
as credenciais estejam em disco antes de qualquer coisa rodar sem supervisão:

```sh
ob login
ob sync-list-remote                       # o nome exato do vault remoto
cd ~/vault && ob sync-setup --vault "MyVault"
ob sync-config                            # confirme: "Sync mode: bidirectional"
```

`ob sync-config --mode` também aceita `pull-only` e `mirror-remote`. Esses são os
modos de reversão sobre os quais o aviso acima fala; `mirror-remote` em
particular vai apagar toda nota que o servidor escrever. `bidirectional` é o
padrão; o ponto de rodar `ob sync-config` é confirmar que nada mais foi
selecionado.

O comando para entregar ao `configure` no próximo passo é:

```
/home/vaultmcp/.local/bin/ob sync --path /home/vaultmcp/vault --continuous
```

Cada parte dessa linha é essencial:

- **caminho absoluto para o `ob`**: o comando roda dentro de uma unit do
  systemd, cujo `PATH` não inclui `~/.local/bin` mesmo que o da sua shell de
  login inclua. Um `ob` puro falha no boot com `exec: ob: not found` (saída 127)
  e entra em crash-loop. O `configure` resolve isso para você, mas a mesma
  armadilha vale para qualquer cliente que você instale no seu home;
- **`--path` absoluto**: as units não definem `WorkingDirectory`, então o
  wrapper roda com o diretório de trabalho em `$HOME`, não no vault. Um cliente
  que assume "o diretório atual" apontaria para o próprio home, que contém
  `~/.config/vault-mcp/env` e as credenciais do túnel;
- **`--continuous`**: o `vault-sync.service` supervisiona um processo em
  primeiro plano. Um sync one-shot termina com sucesso e o systemd o reinicia
  para sempre.

Você vai entregar esse comando de longa duração ao `configure` no próximo passo;
ele é embrulhado como `~/.config/vault-mcp/sync-command` e supervisionado pela
unit `vault-sync`.

## 4. `configure`, o único passo interativo

```sh
~/vault-mcp/infra/scripts/configure
```

Este é o único script que faz perguntas e produz estado local (nunca roda no
boot e se recusa a sobrescrever uma configuração existente sem `--force`). Ele
te guia por:

1. o comando do cliente de sync (gravado em
   `~/.config/vault-mcp/sync-command`). Ele te diz para autenticar/vincular o
   cliente **primeiro**, à mão no mesmo terminal, e o que acontece se você não
   fizer isso; o login é sua parte (cada cliente tem o seu, e a unit roda sem
   supervisão no boot);
2. geração do `ORIGIN_SECRET` (`openssl rand -hex 32`) no arquivo de env em
   `~/.config/vault-mcp/env` (modo 600). Você vai colar esse mesmo valor no
   Worker no passo 6;
3. `VAULT_PATH`, `MCP_PORT` e `LOW_TRUST_FOLDERS` (pastas separadas por vírgula
   com conteúdo importado, recortes web, notas compartilhadas, excluídas da
   busca por padrão). O `MCP_HOST` fica fixo em `127.0.0.1` e o `VAULT_MCP_HOME`
   é registrado automaticamente a partir do checkout onde o configure roda,
   nada a digitar para nenhum dos dois;
4. `git init` do vault mais um primeiro commit; o timer de autocommit vai
   fotografar as mudanças a cada 30 minutos a partir daí.

Veja o [.env.example](../.env.example) para cada variável e seu significado.

## 5. Crie o Cloudflare Tunnel

A origem nunca é exposta a tráfego de entrada; o `cloudflared` abre uma conexão
de saída e a Cloudflare roteia o hostname do túnel por ela.

Na VPS, como o usuário dedicado:

```sh
cloudflared tunnel login
cloudflared tunnel create vault-mcp
cloudflared tunnel route dns vault-mcp vault.example.com
```

O `tunnel login` não tem navegador para abrir numa VPS headless, então ele
imprime uma URL; abra-a na sua máquina e escolha a zona lá. Ele grava
`~/.cloudflared/cert.pem` na VPS quando você terminar. O `tunnel create` então
imprime o UUID do túnel e grava `~/.cloudflared/<UUID>.json`.

Mova esse JSON de credenciais para `~/.config/vault-mcp/` com o resto do estado
local, e mantenha-o legível só pelo dono:

```sh
mv ~/.cloudflared/<UUID>.json ~/.config/vault-mcp/
chmod 600 ~/.config/vault-mcp/<UUID>.json
```

Depois escreva `~/.config/vault-mcp/tunnel.yml` com base no
[infra/tunnel/config.yml.example](../infra/tunnel/config.yml.example): uma regra
de ingress enviando `vault.example.com` para `http://127.0.0.1:9820`, e um
catch-all 404. Mantenha a linha `metrics: 127.0.0.1:9821`; o `doctor` sonda
`/ready` ali para verificar que o túnel mantém conexões vivas com a borda. E dê
ao `credentials-file` um caminho absoluto (o cloudflared não expande `~`).

O `cloudflared` consegue checar o arquivo antes do systemd. Note a posição da
flag: `--config` pertence a `tunnel`, não a `ingress validate`.

```sh
cloudflared tunnel --config ~/.config/vault-mcp/tunnel.yml ingress validate
cloudflared tunnel --config ~/.config/vault-mcp/tunnel.yml ingress rule \
  https://vault.example.com/mcp     # precisa casar com a regra, não com o catch-all
```

### Cheque a origem antes de construir a borda

Vale a pena fazer agora em vez de depois que o Worker existir: te diz qual
metade está quebrada enquanto há só uma metade:

```sh
systemctl --user start vault-mcp vault-tunnel
curl -si https://vault.example.com/mcp | head -1
```

| Resposta | Significado |
| --- | --- |
| `HTTP/2 404` | **É o que você quer.** A rota funciona e a origem recusou uma requisição sem o `x-origin-secret`, exatamente o trabalho dela. |
| Erro 1033 da Cloudflare / `530` | O registro DNS não aponta para este túnel, ou o cloudflared não mantém conexões com a borda. Rode `tunnel route dns` de novo. |
| `502` / `503` | Túnel de pé, servidor não: `journalctl --user -u vault-mcp -n 50`. |

Note que alcançar `vault.example.com` diretamente não dá nada a um atacante: sem
o header `x-origin-secret`, que só o Worker anexa, a origem responde 404 a tudo.
É por isso que a resposta saudável acima é um 404, e por isso um 404 *depois* de
o Worker estar implantado significa que os dois lados discordam sobre o segredo.

## 6. Faça o deploy do Worker de auth

Na sua máquina (ou na VPS, em qualquer lugar com wrangler):

```sh
cd apps/auth-worker
cp wrangler.jsonc wrangler.local.jsonc      # cópia de trabalho, git-ignored
npx wrangler kv namespace create OAUTH_KV
```

Edite `wrangler.local.jsonc`, **não** o
[apps/auth-worker/wrangler.jsonc](../apps/auth-worker/wrangler.jsonc)
versionado, que é o exemplo e deve manter só placeholders. Manter os valores
reais na cópia não versionada é o que mantém o id do namespace KV, o hostname do
túnel e o callback id do ChatGPT fora do histórico do git (não são segredos, mas
são identificadores que a política deste projeto mantém fora do repositório).
Preencha:

- o `id` do namespace `OAUTH_KV` do comando acima;
- `ORIGIN_URL`: o hostname do túnel, `https://vault.example.com`;
- `REDIRECT_ALLOWLIST`: valores de `redirect_uri` **exatos** separados por
  vírgula que o fluxo OAuth vai aceitar, por exemplo os callbacks do Claude mais
  o callback exato do ChatGPT
  `https://chatgpt.com/connector/oauth/<callback_id>` mostrado ao configurar
  aquele conector. Qualquer coisa que não esteja exatamente nessa lista é
  rejeitada. É isso que neutraliza registros dinâmicos de clientes maliciosos;
  veja o [modelo de ameaças](threat-model.md).

O callback id do ChatGPT é normalmente estável para aquela instância de
conector, mas pode mudar se o conector for apagado e recriado ou se você criar
outro conector. Um callback alterado causa `403` em `/authorize`; adicione a URL
exata nova e refaça o deploy. Nunca use `https://chatgpt.com/connector/oauth/*`
como atalho, porque isso autorizaria URLs de callback de outros conectores
ChatGPT. O callback legado
`https://chatgpt.com/connector_platform_oauth_redirect` vale apenas para
integrações já publicadas que ainda o usam.

Depois defina os segredos e faça o deploy:

```sh
npx wrangler secret put ORIGIN_SECRET      # o mesmo valor que o configure gerou na VPS
npx wrangler secret put CONSENT_PASSWORD   # alta entropia, por exemplo: openssl rand -base64 24
npx wrangler deploy --config wrangler.local.jsonc
```

A flag `--config` aponta o wrangler para a cópia não versionada; um
`wrangler deploy` puro leria o exemplo versionado e falharia nos placeholders.

O `ORIGIN_SECRET` é guardado **entre aspas simples** em `~/.config/vault-mcp/env`;
é essa aspa que permite ao systemd e ao bash lerem o mesmo arquivo. As aspas são
sintaxe, não fazem parte do segredo: colar `'abc…'` em vez de `abc…` dá à origem
um header que ela não reconhece, e a falha se parece exatamente com um túnel mal
roteado (um 404 sem explicação em lugar nenhum). Ler o valor pelo shell evita a
dúvida de vez; na VPS:

```sh
sh -c 'set -a; . ~/.config/vault-mcp/env; printf %s "$ORIGIN_SECRET"'
```

Segredos passam a valer assim que o `wrangler secret put` retorna; rotacionar um
depois não precisa de redeploy, só de um `systemctl --user restart vault-mcp`
correspondente no lado da origem.

(Não há cookie secret para definir: a biblioteca OAuth mantém todo o estado dela
em KV e não emite cookies assinados.)

O `CONSENT_PASSWORD` é o que *você* digita na página de consentimento ao
autorizar um cliente; trate-o como uma entrada de gerenciador de senhas, não
como algo memorável. Tentativas erradas são limitadas na borda (5 por 15 minutos
por IP).

Detalhes de deploy e o que o Worker pode e não pode ver estão em
[apps/auth-worker/README.md](../apps/auth-worker/README.md).

## 7. Inicie tudo

Como o usuário dedicado na VPS:

```sh
systemctl --user start vault-sync vault-mcp vault-tunnel
systemctl --user start vault-autocommit.timer
```

(As units já foram *habilitadas* pelo bootstrap, então também vão iniciar a cada
boot daqui em diante.)

## 8. Adicione o conector no Claude ou no ChatGPT

Nas configurações do Claude, adicione um conector customizado apontando para o
endpoint MCP do Worker:

```
https://<your-worker>.<your-subdomain>.workers.dev/mcp
```

(ou seu domínio customizado do Worker, caminho `/mcp`). O Claude vai descobrir os
metadados OAuth, te mandar para a página de consentimento e pedir a consent
password. Depois disso, as tools do vault ficam disponíveis em qualquer conversa,
em qualquer dispositivo.

No ChatGPT, crie o conector/plugin MCP usando o mesmo endpoint `/mcp`. Copie a
URL de callback exibida pelo ChatGPT para o `REDIRECT_ALLOWLIST`, faça o deploy
do Worker e então inicie a autorização. O callback normalmente tem a forma
`https://chatgpt.com/connector/oauth/<callback_id>`.

Teste: *"procure nas minhas notas por …"* ou *"o que eu escrevi na nota diária de
ontem?"*.

## 9. Verifique, agora e depois de cada reboot

```sh
~/vault-mcp/infra/scripts/doctor      # o bootstrap também linkou como ~/.local/bin/vault-mcp-doctor
```

O `doctor` confirma em segundos: as três units estão ativas, o arquivo de env e o
diretório do vault existem, o servidor responde ao seu health check, o túnel está
conectado, o timer de autocommit ainda está agendado e sua última execução teve
sucesso (isso, e não a idade do último commit, é o que prova que o histórico de
desfazer está sendo escrito), e o último sync bem-sucedido é recente (ele avisa
acima de 6 horas; "tudo parece vivo mas o conteúdo está congelado no tempo" é a
falha silenciosa mais provável).

Por fim, faça o teste real do requisito operacional central: **reinicie a VPS e
não toque em nada**. Quando ela voltar, o `doctor` precisa estar verde e uma
pergunta no Claude precisa ser respondida. Se um reboot exigir passos manuais, a
instalação está errada; conserte isso agora, não no dia em que quebrar.

O que cada FAIL do `doctor` significa e cada procedimento de day-2 (revogar
tokens, rotacionar segredos, restaurar notas do git) está em
[operations.md](operations.md).

## Limitações conhecidas (por design, vale saber antes de confiar)

- `create_daily_note` aplica o template da sua nota diária, renderizando os
  placeholders do core (`{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`,
  `{{time:FORMAT}}`; o tempo suporta `H/HH`, `h/hh`, `m/mm`, `s/ss`, `A/a`), mas
  sintaxe de plugin (Templater etc.) **não** é executada e fica literal na nota.
  O `get_daily_note` lê as configurações de daily notes do seu vault (core Daily
  Notes ou o plugin Periodic Notes; pasta, formato do nome, um subconjunto de
  tokens do moment: `YYYY YY MMMM MMM MM M DD D dddd ddd` e escapes
  `[literal]`) para que os caminhos batam com o que o Obsidian mostra, mas ele
  nunca cria a nota.
- `append_to_note` exige que a nota exista; `create_note` e `move_note` se
  recusam a sobrescrever; `delete_note` só move notas para a pasta `.trash/` do
  próprio vault. O `move_note` **não** reescreve wiki-links que apontam para o
  nome antigo.
- `edit_note` exige que cada `old_string` bata exatamente uma vez; passe o hash
  `version` de uma leitura anterior como `expected_hash` para detectar edições
  obsoletas. A versão é checada de novo imediatamente antes da substituição, mas
  uma janela residual estreita de corrida com escritores externos não
  relacionados permanece, porque filesystems comuns não oferecem
  compare-and-swap por conteúdo. `complete_task` e `postpone_task` exigem o hash
  retornado pelo `list_tasks`, já que o número de linha só faz sentido para
  aquela versão exata da nota.
- A busca é um match **literal de substring** case-insensitive, não regex e não
  semântico.
- `complete_task` não gera a próxima ocorrência de tarefas recorrentes (🔁); abra
  a tarefa no Obsidian se você depende da recorrência do plugin Tasks.
- Só arquivos `.md` são alcançáveis, e pastas ocultas (incluindo `.obsidian`) são
  bloqueadas de todas as tools.
