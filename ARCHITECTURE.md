# vault-mcp — arquitetura e plano de execução

> Servidor MCP remoto que expõe um vault Obsidian ao Claude, com sincronização
> headless e sem dependência do aplicativo desktop.
>
> **Status:** documento de arquitetura, pré-implementação
> **Data:** julho de 2026

---

## 1. Problema

O Obsidian resolve muito bem a captura e a organização de notas, mas o conteúdo
fica inerte: para usar o que está no vault dentro de uma conversa com um LLM, é
preciso copiar e colar. As integrações existentes não resolvem isso para quem
trabalha no navegador ou no celular:

- **Plugins de MCP para Obsidian** (`mcp-tools`, `vault-as-mcp`, `cli-rest-mcp`)
  expõem servidores em `localhost`, pensados para o Claude Desktop conectar via
  ponte stdio na mesma máquina. O Claude web e o app iOS falam com a infra da
  Anthropic, que precisa de um endpoint HTTPS público — esses plugins não
  alcançam esse caso.
- **O CLI oficial do Obsidian** exige o aplicativo Electron rodando, o que num
  servidor significa Xvfb e um display virtual. Funciona, mas é uma adaptação
  frágil de um app desktop.
- **Remote Control do Claude Code** dá acesso ao filesystem remoto, mas é uma
  sessão única e persistente na aba Code — não uma capacidade disponível em
  qualquer conversa nova.

O que falta é um servidor MCP **remoto**, que leia os arquivos markdown
diretamente do disco, sem depender do aplicativo Obsidian em lugar nenhum.

---

## 2. Visão do produto

Um conector que você adiciona uma vez nas configurações do Claude e passa a ter
disponível em qualquer conversa, em qualquer dispositivo. O vault vira contexto
consultável e um destino de escrita, mantendo o Obsidian como a interface de
leitura e edição humana.

**Princípio central:** o vault continua sendo uma pasta de arquivos markdown. O
servidor não introduz banco de dados, índice proprietário nem formato próprio. Se
o projeto for desligado amanhã, as notas continuam exatamente como estavam.

### Casos de uso alvo

| Situação | O que o usuário faz hoje | O que passa a fazer |
| --- | --- | --- |
| Retomar uma decisão antiga | Abre o Obsidian, busca, lê, cola no chat | Pergunta direto no chat |
| Capturar uma conclusão da conversa | Copia, abre o app, cola, formata | Pede para anexar na daily |
| Consultar notas fora de casa | Abre o app no celular e busca manualmente | Pergunta ao Claude no iOS |
| Cruzar várias notas | Abre uma por uma | Uma pergunta, o modelo busca |

### Não-objetivos

Explicitados para manter o escopo fechado:

- **Não substituir o Obsidian.** Nenhuma interface de leitura ou edição própria.
- **Não executar o runtime do Obsidian.** Sem Templater, Dataview, plugins ou
  `eval`. Quem precisa disso quer o CLI oficial, não este projeto.
- **Não ser multi-tenant.** Uma instância serve um usuário e um vault. Isolamento
  entre usuários é um problema diferente e muito maior.
- **Não gerenciar o Obsidian Sync.** O projeto depende do cliente headless
  oficial; não reimplementa sincronização.
- **Não indexar semanticamente** (embeddings, RAG) na primeira versão. Busca
  full-text resolve a maioria dos casos e não introduz estado a manter.

---

## 3. Arquitetura

### 3.1 Zonas

O sistema tem três zonas com responsabilidades estritamente separadas.

**Cliente** — Claude web, iOS, Android ou Desktop. Fala apenas MCP sobre HTTPS.
Nunca alcança a VPS diretamente.

**Borda (Cloudflare)** — um Worker que resolve autenticação OAuth 2.1 e encaminha
requisições já autenticadas. Não conhece o vault, não lê arquivos, não guarda
conteúdo. É um porteiro sem estado, à exceção do armazenamento de tokens.

**Origem (VPS)** — onde tudo de fato existe: os arquivos markdown, o processo de
sincronização e o servidor MCP que executa as tools. Não é alcançável pela
internet: só recebe tráfego através de um túnel de saída.

### 3.2 Fluxo de uma requisição

1. O usuário pergunta algo em qualquer conversa do Claude.
2. O modelo decide chamar uma tool e envia JSON-RPC ao endpoint público.
3. O Worker valida o bearer token e identifica o dono.
4. O Worker encaminha o payload pelo túnel, acrescentando o segredo de origem.
5. O servidor MCP resolve a tool contra o filesystem e devolve o resultado.
6. O conteúdo passa pela sanitização de saída antes de virar resposta.
7. O Worker repassa a resposta ao cliente.

### 3.3 Sincronização

Um processo separado mantém o vault local em dia com o Obsidian Sync, em modo
bidirecional e contínuo. Consequências de projeto:

- O servidor MCP **não** sabe que sincronização existe; ele só vê arquivos.
- Escritas precisam ser atômicas, porque o observador de mudanças do sync é
  rápido o suficiente para capturar um arquivo pela metade.
- O modo de sincronização é uma decisão de segurança: modos que revertem
  alterações locais apagariam silenciosamente o que o servidor escreveu.

### 3.4 Estrutura do monorepo

```
apps/
  mcp-server/       servidor MCP na VPS; expõe as tools sobre HTTP
  auth-worker/      Worker de borda; OAuth e proxy autenticado
packages/
  vault-core/       leitura, escrita atômica, validação de caminho, busca
  vault-guards/     sanitização de entrada e saída, heurísticas de alerta
  tool-contract/    schemas e descrições das tools, compartilhados
infra/
  scripts/
    bootstrap        instalação idempotente da máquina
    configure        vinculação do vault e credenciais (interativo, uma vez)
    start            entrada única dos serviços; chamada pelo systemd
    doctor           diagnóstico do estado atual
  systemd/           units do servidor, do sync e do túnel
  tunnel/            configuração do túnel
docs/
  setup.md          instalação passo a passo
  threat-model.md   modelo de ameaças
  operations.md     backup, rotação de credenciais, revogação
```

A separação entre `vault-core` e `mcp-server` é deliberada: o núcleo de acesso ao
vault não deve saber o que é MCP. Isso mantém a lógica testável sem transporte e
abre caminho para outras superfícies no futuro sem reescrever o núcleo.

`tool-contract` isolado importa mais do que parece — as descrições das tools são
o que faz o modelo decidir buscar no vault sem ser instruído. Elas são um artefato
de produto, não detalhe de implementação, e merecem versionamento e iteração
próprios.

---

## 4. Superfície de tools

O inventário de tools é simultaneamente a interface do produto e o principal
controle de segurança. Cada adição precisa passar pela pergunta: *o que acontece
se uma nota maliciosa conseguir chamar isto com os argumentos que quiser?*

### Versão inicial

| Tool | Tipo | Descrição |
| --- | --- | --- |
| `search_notes` | leitura | Busca full-text; retorna caminho, linha e trecho |
| `read_note` | leitura | Conteúdo completo de uma nota, com limite de tamanho |
| `list_recent` | leitura | Notas modificadas mais recentemente |
| `get_daily_note` | leitura | Resolve e lê a nota diária de uma data |
| `create_note` | escrita | Cria nota nova; falha se já existir |
| `append_to_note` | escrita | Acrescenta ao final; nunca sobrescreve |

#### Nota sobre `get_daily_note`

É a tool com mais decisão de produto embutida, porque a "nota de hoje" não é um
arquivo — é uma convenção que vive na configuração do vault: pasta de destino,
formato de data e template associado. A tool lê essa configuração em vez de
assumir um padrão, para que o comportamento coincida com o que o usuário vê ao
abrir o app.

Três definições que precisam ser explícitas:

- **Aceita uma data opcional**, com hoje como padrão. Sem isso, "o que anotei
  ontem" vira uma busca em vez de um acesso direto.
- **Não cria a nota se ela não existir.** Retorna o caminho que a nota teria e
  sinaliza a ausência. Criar como efeito colateral de uma leitura é
  surpreendente, e a criação real esbarra no problema seguinte.
- **Não aplica template.** O template do usuário provavelmente contém sintaxe de
  plugin, que só o runtime do Obsidian resolve. Uma nota diária criada por fora
  nasce sem a estrutura esperada, e isso precisa estar documentado — é a
  diferença mais visível entre criar pelo app e criar pelo servidor.

O par natural de uso é `get_daily_note` seguido de `append_to_note` com o caminho
retornado, o que mantém a escrita concentrada numa tool só.

### Deliberadamente ausentes

- **`delete_note` e `move_note`** — transformam ruído em perda de dados. Mover
  também quebra wikilinks, e a quebra se propaga pelo sync para todos os
  dispositivos.
- **Qualquer tool de requisição HTTP** — é o que transforma "lixo numa nota" em
  exfiltração de conteúdo.
- **Execução de shell ou JavaScript** — sem exceções.

### Candidatas para depois

`list_tags`, `get_backlinks`, `update_frontmatter` com montagem programática do
YAML. Cada uma entra apenas após passar pela pergunta acima.

---

## 5. Modelo de segurança

O modelo de ameaças completo vai em `docs/threat-model.md`. Resumo das decisões
que orientam a implementação.

### 5.1 Autenticação

O endereço público **não é segredo** — ele fica salvo nas configurações do
cliente, transita por infraestrutura de terceiros e aparece em logs. O sistema é
projetado assumindo que conhecê-lo não dá vantagem nenhuma.

- OAuth 2.1 com PKCE na borda; escrever a camada de OAuth à mão é o que menos se
  quer errar, então usa-se biblioteca estabelecida.
- Client ID Metadata Documents é o mecanismo de registro preferido; registro
  dinâmico permanece apenas como compatibilidade.
- **Allowlist fixa de `redirect_uri`.** Como o registro dinâmico de clientes é
  aberto por especificação, sem essa trava um atacante registra um cliente com
  redirect próprio e induz o dono a autorizar no domínio legítimo. Sendo um
  usuário só, fixar a lista elimina a classe inteira de ataque.
- Consentimento com credencial de alta entropia, comparação em tempo constante e
  limite de tentativas na borda.
- A origem exige um segredo compartilhado e responde 404 sem ele — não 401, para
  não confirmar que existe algo ali.

### 5.2 Acesso ao filesystem

Toda tool que recebe caminho passa por validação que resolve symlinks no
diretório pai antes de checar o prefixo do vault, rejeita caminhos absolutos,
restringe a arquivos markdown e bloqueia pastas ocultas — incluindo a de
configuração do Obsidian.

O processo roda como usuário dedicado, sem privilégios, com o filesystem restrito
ao diretório do vault.

### 5.3 Prompt injection

**Esta é a ameaça dominante do projeto**, e é estrutural: o conteúdo do vault é
entrada não confiável, porque boa parte dele não foi escrita pelo dono — recortes
web, PDFs colados, notas recebidas.

A defesa não é detecção, é fechamento de canais:

1. **Inventário mínimo de tools** — sem exfiltração e sem destruição, o pior caso
   de uma injeção bem-sucedida é conteúdo estranho numa nota.
2. **Bloqueio de imagem remota na escrita** — o único canal de vazamento que
   sobrevive ao item anterior: o cliente busca a URL sozinho quando o dono abre a
   nota, levando dados no query string.
3. **Sanitização na leitura** — remoção de comentários HTML, elementos ocultos
   por CSS, caracteres invisíveis e o bloco Unicode de tags, todos vetores de
   instruções invisíveis ao humano mas legíveis pelo modelo.
4. **Procedência por pasta** — conteúdo importado é marcado como baixa confiança
   e fica fora da busca padrão.

Filtros de palavra-chave existem apenas para alertar o dono, nunca para bloquear:
são triviais de contornar e geram falso positivo nas próprias notas do usuário
sobre o assunto.

### 5.4 Recuperação

Commit automático periódico no vault via git. Não previne nada, mas é o que torna
verdadeira a afirmação "o pior caso é lixo numa nota" — sem um caminho de
reversão, essa frase é otimismo.

---

## 6. Infraestrutura e operação

O sistema roda numa máquina que reinicia — por atualização de kernel, manutenção
do provedor ou queda. **O requisito operacional central é que um reboot não exija
intervenção nenhuma.** Se depois de reiniciar for preciso lembrar de subir três
processos na ordem certa, o projeto falha silenciosamente e o usuário só descobre
quando faz uma pergunta e o conector não responde.

### 6.1 Separação entre instalar, configurar e iniciar

Três responsabilidades que costumam virar um script só, e não deveriam:

| Etapa | Quando roda | Característica |
| --- | --- | --- |
| `bootstrap` | Uma vez por máquina | Idempotente, sem interação, sem segredos |
| `configure` | Uma vez por vault | Interativo, produz credenciais e estado local |
| `start` | Todo boot, e a cada falha | Sem interação, sem escrita de configuração |

A confusão entre `configure` e `start` é o erro clássico: um script único que
tenta autenticar no boot ou pede entrada do usuário trava a inicialização, e o
serviço fica parado esperando alguém que não está olhando.

**`bootstrap`** instala dependências do sistema, cria o usuário dedicado sem
privilégios, prepara o diretório do vault com as permissões corretas, instala as
units e habilita o `linger` — sem o qual serviços de usuário param ao encerrar a
sessão. Roda quantas vezes for preciso sem quebrar nada.

**`configure`** é o único passo interativo do projeto: autentica no serviço de
sincronização, vincula o diretório local ao vault remoto, define o modo de
sincronização e grava as variáveis de ambiente. Produz estado que não vai para o
repositório.

**`start`** é a entrada única invocada pelo systemd. Valida pré-condições, falha
rápido com mensagem clara se algo estiver faltando e entrega o controle ao
processo. Nunca autentica, nunca escreve configuração, nunca pede entrada.

**`doctor`** existe para o momento em que algo não responde: verifica se o vault
está montado e sincronizando, se o servidor responde no health check, se o túnel
está conectado e há quanto tempo foi o último sync bem-sucedido. É o primeiro
comando a rodar antes de olhar logs.

### 6.2 Serviços e ordem de inicialização

Três unidades supervisionadas, todas habilitadas no boot:

| Serviço | Função | Depende de |
| --- | --- | --- |
| Sincronização | Mantém o vault em dia | Rede disponível |
| Servidor MCP | Executa as tools | Vault existindo em disco |
| Túnel | Expõe a origem à borda | Servidor respondendo |

A dependência do servidor com o sync é **fraca de propósito**: o servidor deve
subir mesmo com a sincronização quebrada, servindo o conteúdo que já está em
disco. Notas possivelmente desatualizadas são muito melhores que um conector
morto — e amarrar os serviços faria uma falha de credencial de sync derrubar
funcionalidade que não depende dela.

**Política de reinício.** Reiniciar sempre, com espera crescente entre tentativas
e sem limite de desistência. O ponto que motiva isso: o cliente de sincronização
encerra após um período prolongado sem rede. Numa VPS com instabilidade
transitória, uma política que desiste depois de N tentativas deixa o sync parado
até alguém perceber — que costuma ser semanas depois.

**Serviços de usuário, não de sistema.** Rodar como usuário dedicado com `linger`
mantém as credenciais no home desse usuário e o processo sem privilégios, sem
`sudo` em lugar nenhum do caminho.

### 6.3 Validação pós-boot

Um reinício bem-sucedido precisa ser verificável sem inspeção manual. Após o
boot, o `doctor` deve confirmar em segundos: vault presente e com escrita
recente, servidor respondendo, túnel conectado, sync sem erro pendente.

Vale um alerta ativo quando o último sync bem-sucedido passar de algumas horas.
Esse é o modo de falha mais provável e o mais silencioso — tudo parece
funcionando, as respostas continuam vindo, e o conteúdo está congelado no tempo.

### 6.4 Deploy

Duas cadeias independentes. A borda muda raramente (lógica de autenticação); a
origem muda com frequência (tools e descrições). Nenhuma depende da outra para
subir, e nenhuma exige tocar em `configure`.

Toda configuração por variável de ambiente, sem exceção — pré-requisito para o
código ser publicável, e o que permite que `bootstrap` e `start` sejam os mesmos
em qualquer máquina.

### 6.5 Observabilidade e procedimentos

Log estruturado de toda chamada de tool: horário, tool, caminho tocado, tamanho
do retorno. Alerta em falhas de autenticação — num sistema de um usuário,
qualquer falha já é anômala.

Procedimentos escritos antes de serem necessários, em `docs/operations.md`:
revogar todos os tokens, rotacionar o segredo de origem, restaurar o vault a
partir do git, refazer a vinculação de sincronização após perda de credencial.

---

## 7. Plano de execução

Fases pensadas para que cada uma entregue algo utilizável, e não como camadas de
uma stack que só funciona completa.

### M0 — Fundação
Monorepo, workspaces, TypeScript, lint, CI. Núcleo de acesso ao vault com
validação de caminho e escrita atômica, com testes. Scripts de `bootstrap`,
`configure` e `start`, com a unidade de sincronização habilitada no boot.
*Pronto quando:* a máquina reinicia e o vault volta a sincronizar sem
intervenção, e o núcleo tem cobertura de teste nos casos de escape de caminho.

### M1 — Leitura local
Servidor MCP com as três tools de leitura, acessível apenas em localhost.
Validação por linha de comando, sem rede nem autenticação.
*Pronto quando:* uma listagem de tools e uma busca respondem corretamente.

### M2 — Acesso remoto autenticado
Túnel, Worker com OAuth, allowlist de redirect, segredo de origem, limite de
tentativas. Conector adicionado nas configurações do Claude.
*Pronto quando:* a busca funciona numa conversa nova no celular.

Este é o marco que entrega a promessa do produto. Tudo antes é infraestrutura;
tudo depois é ampliação.

### M3 — Escrita
Tools de criação e anexação, sanitização de entrada, bloqueio de imagem remota,
commits automáticos, log de auditoria.
*Pronto quando:* uma nota criada pelo chat aparece no app do celular com o
formato correto e o histórico registra a mudança.

### M4 — Publicável
Remoção de qualquer traço de configuração pessoal, documentação de instalação
para terceiros, modelo de ameaças escrito, licença, exemplos de configuração.
*Pronto quando:* alguém que não é o autor consegue subir a própria instância
seguindo apenas a documentação.

---

## 8. Considerações para código aberto

O projeto é publicável, mas exige cuidado específico porque lida com dados
pessoais e credenciais.

**O que a publicação exige:**

- Nenhum domínio, caminho, identificador ou credencial no repositório. Tudo por
  ambiente, com arquivo de exemplo.
- `.gitignore` que torne difícil commitar um vault por acidente — o erro mais
  provável e mais caro deste projeto.
- Modelo de ameaças público. Quem for hospedar isso precisa entender que está
  expondo notas pessoais à internet, mesmo que atrás de autenticação.
- Documentação honesta sobre limitações: sem Templater, sem Dataview, sem
  resolução automática de wikilinks ao mover.
- Assinatura de commits e política de dependências. Um servidor com acesso a
  notas pessoais é alvo interessante para ataque de cadeia de suprimentos.

**O que a publicação não deve mudar:** a decisão de ser mono-usuário. A pressão
para adicionar multi-tenancy vai aparecer, e aceitá-la reintroduz toda uma classe
de problemas de isolamento que hoje simplesmente não existe. Cada usuário sobe a
própria instância.

**Diferencial:** os projetos existentes assumem o Obsidian rodando localmente.
Acesso remoto real, sem GUI, com autenticação adequada, é o espaço vazio.

---

## 9. Decisões em aberto

| Questão | Alternativas | Observação |
| --- | --- | --- |
| Autenticação | OAuth na borda vs. autenticação por header fixo | Header fixo é muito mais simples, mas depende de disponibilidade do recurso na conta |
| Onde fica o OAuth | Worker na borda vs. tudo na VPS | Borda economiza a parte mais delicada; VPS elimina uma peça móvel |
| Escopo do vault | Vault inteiro vs. subconjunto sincronizado | Restringir o que chega ao servidor reduz o impacto de um comprometimento |
| Busca | Full-text vs. híbrida com embeddings | Semântica ajuda em consultas vagas, mas adiciona estado e custo |
| Confirmação de escrita | Sempre vs. após período de confiança | Confirmar sempre é o certo no início; pode virar atrito depois |

---

## 10. Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Injeção via conteúdo importado | Escrita indevida no vault | Inventário mínimo de tools; canais de saída fechados |
| Comprometimento da VPS | Vault inteiro exposto | Sincronização parcial; nenhum segredo dentro do vault |
| Conflito de escrita simultânea | Notas duplicadas ou divergentes | Escrita atômica; uso natural raramente concorre |
| Quebra de contrato do cliente MCP | Conector para de funcionar | Aderência estrita à especificação; teste após cada atualização |
| Frontmatter malformado | Queries de plugins param de enxergar notas | Montagem programática do YAML, nunca texto livre |
| Escopo crescente para multi-usuário | Reintrodução de problemas de isolamento | Não-objetivo declarado no README |
