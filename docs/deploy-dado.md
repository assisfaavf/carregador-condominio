# Deploy na Dado com Dockerfile

## Build e processo de produção

Configure o deploy para usar o `Dockerfile` da raiz, com contexto na raiz do
repositório. Não substitua o comando de build por um preset Node que instale
somente dependências de produção antes de compilar o frontend.

O Dockerfile usa Node.js 24 e três estágios:

1. `frontend-build`: `npm ci --include=dev` na pasta `web`, seguido de `npm run build`.
   TypeScript e Vite são ferramentas de compilação e continuam em `devDependencies`.
2. `backend-dependencies`: instala as dependências de produção da raiz com `npm ci --omit=dev`.
3. `production`: recebe o backend, os arquivos legados de `public`, as migrations
   e o frontend compilado em `web/dist`. Executa `node server.js` como usuário não root.

Não há processo Vite em produção. O Express serve o frontend e a API no mesmo
processo/porta. Já escuta em `0.0.0.0` e respeita `PORT`. A porta padrão da
imagem é 3000; se a plataforma fornecer outra, use a porta fornecida no roteamento.
O endpoint de saúde HTTP é `/health`. `/health/db` verifica também o PostgreSQL.

Os dois pares `package.json`/`package-lock.json` são preservados. O build não precisa
de credenciais nem de acesso ao banco/Tuya. `.dockerignore` exclui `.env`, arquivos
locais, Git e `node_modules`. As credenciais são injetadas apenas em runtime.

## Variáveis na plataforma

Obrigatórias para a aplicação e operação real:

| Variável | Configuração |
| --- | --- |
| `NODE_ENV` | `production` (já definido na imagem) |
| `PORT` | Porta fornecida pela plataforma; padrão 3000 |
| `DATABASE_URL` | URL do PostgreSQL persistente acessível a partir do container |
| `JWT_SECRET` | Segredo forte e estável entre deploys |
| `TUYA_CLIENT_ID` | ID do projeto Tuya existente |
| `TUYA_CLIENT_SECRET` | Secret do projeto Tuya existente |
| `TUYA_ENDPOINT` | Endpoint correspondente à região do projeto Tuya |
| `COOKIE_SECURE` | `true` para acesso HTTPS |

Opcionais, conforme o ambiente:

- `DATABASE_URL_UNPOOLED`: conexão direta para `npm run migrate`, especialmente
  ao usar Neon com `DATABASE_URL` pooled.
- `TUYA_DEVICE_REGION`: região do dispositivo.
- `TUYA_DEVICE_ID`: fallback de debug; as estações operacionais vêm do banco.
- `JWT_EXPIRES_IN` (padrão `7d`).
- `COOKIE_NAME` (`token`), `COOKIE_SAMESITE` (`lax`), `COOKIE_PATH` (`/`).
- `COOKIE_DOMAIN`: deixar ausente, salvo quando um domínio de cookie explícito
  for necessário. Acesso pelo frontend e API no mesmo domínio simplifica a autenticação.
- `PRICE_PER_KWH` e `DEFAULT_CHARGE_CURRENT_A`: preservar os valores da operação.
- `ENERGY_TOLERANCE_KWH`, `ENERGY_TOLERANCE_RATIO`,
  `ENERGY_MAX_SAMPLE_GAP_SECONDS`: preservar as tolerâncias de conciliação existentes.

Nunca usar variáveis `VITE_*` para segredos: elas podem ser incorporadas ao frontend.
Não enviar o `.env` local nem usar as credenciais de exemplo do Compose em produção.

## PostgreSQL e demais serviços

`docker-compose.yml` contém somente PostgreSQL 16, com um volume `pgdata` para
desenvolvimento local. Não há Redis nem outro serviço obrigatório.

A Dado, conforme a configuração informada, não executa os serviços adicionais
do Compose. Portanto, o PostgreSQL deve ser provisionado separadamente: Neon,
um serviço PostgreSQL persistente da hospedagem ou outro banco acessível pela rede.
Configure sua URL em `DATABASE_URL`, incluindo os parâmetros TLS exigidos pelo
provedor. `localhost` dentro do container aponta para o próprio container, e o
hostname `postgres` do Compose local não existe automaticamente no deploy.

Sessões, amostras, validações e auditoria ficam no PostgreSQL. O arquivo legado
`database.sqlite` não é necessário para o backend atual e não entra na imagem.
Não há necessidade de persistir arquivos do container para essas funcionalidades.

## Publicação

1. Publique o código no repositório usado pela Dado e selecione o deploy por
   Dockerfile na raiz. Configure as variáveis de runtime acima.
2. Execute `npm run migrate` com a nova imagem em uma etapa de pré-deploy/release,
   se a plataforma disponibilizar essa opção. Caso contrário, execute uma tarefa
   única com essa imagem e as variáveis do banco antes de liberar a nova versão.
   As migrations estão incluídas na imagem e o comando aplica apenas as pendentes.
   Não execute migrations durante o build e não as inicie simultaneamente em várias réplicas.
3. Mantenha o comando padrão da imagem (`node server.js`). Configure o roteamento
   para `PORT`, HTTPS e health check `/health`.
4. Verifique `/health`, `/health/db`, login, uma rota da SPA como `/login` e o
   histórico administrativo. Confirme nos logs que o watchdog consegue ler as estações.

Para preservar o monitoramento contínuo, mantenha uma instância ativa sem
hibernação/scale-to-zero. Comece com uma réplica: o watchdog roda dentro de cada
processo Node; esta task não adiciona coordenação entre réplicas. Se o provedor
suspender o processo, o monitoramento pausa até ele retornar, mesmo usando Docker.
A recuperação e a conciliação existentes continuam disponíveis.

O build do frontend precisa de mais memória que o processo em runtime. Se a Dado
limitar também o ambiente de compilação, ajuste os recursos de build ou publique
a imagem compilada em um runner com memória suficiente. O Dockerfile não elimina
o custo de compilação do TypeScript/Vite.

## Comandos locais

```powershell
docker build -t spate-charge:local .
docker run --rm --name spate-charge -p 3000:3000 --env-file .env.production spate-charge:local
docker logs -f spate-charge
docker stop spate-charge
```

Crie `.env.production` fora do controle de versão com as variáveis corretas.
Para acessar o PostgreSQL do host pelo Docker Desktop, a URL normalmente usa
`host.docker.internal` em vez de `localhost`. Use um banco de teste para validações.
O comando abaixo altera o banco apontado pelo arquivo de ambiente; confira o destino:

```powershell
docker run --rm --env-file .env.production spate-charge:local npm run migrate
```

## Validação executada nesta task

- Os manifests da raiz e de `web` correspondem aos respectivos lockfiles.
- `npm --prefix web run build`: passou.
- `npm test` com PostgreSQL local: 18 testes passaram, sem testes ignorados.
- `docker build -t spate-charge:local .`: passou com instalação limpa por `npm ci`.
- As nove migrations foram aplicadas pela imagem em um banco temporário vazio.
- A imagem iniciou com `PORT=4317`, usuário `node` e limite de 128 MB.
- `/health`, `/health/db`, `/`, `/login`, `/app/profile`, `/admin`, `/login.html`
  e os assets JS/CSS responderam corretamente. A API administrativa retornou 401 sem login.
- O health check Docker ficou saudável. Em repouso, o container usou aproximadamente
  26 MB; isso não representa um teste de carga ou garantia de consumo em produção.
- A imagem final não contém `.env`, `web/node_modules`, TypeScript nem Vite.
- O container e o banco temporários foram removidos após os testes.

Nenhuma recarga real foi iniciada/interrompida. O deploy na Dado em si depende
da publicação do código/imagem e das variáveis da plataforma; não foi executado
nesta validação local.
