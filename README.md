# carregador-condominio

Backend Express + frontend React/Vite para operacao de carregadores do condominio.

## Requisitos

- Node.js 20+ recomendado
- PostgreSQL acessivel pela `DATABASE_URL`
- Docker opcional para subir o Postgres local com `docker compose`

## Variaveis de ambiente

Base:

- `PORT`: porta HTTP do backend. Default: `3000`
- `NODE_ENV`: `development` ou `production`
- `DATABASE_URL`: conexao do PostgreSQL
- `JWT_SECRET`: segredo para assinar o cookie de autenticacao
- `JWT_EXPIRES_IN`: expiracao do JWT. Default: `7d`

Cookies/autenticacao:

- `COOKIE_NAME`: nome do cookie. Default: `token`
- `COOKIE_SECURE`: use `true` em producao com HTTPS
- `COOKIE_SAMESITE`: `lax`, `strict` ou `none`
- `COOKIE_DOMAIN`: dominio do cookie quando necessario
- `COOKIE_PATH`: caminho do cookie. Default: `/`

Tuya:

- `TUYA_CLIENT_ID`
- `TUYA_CLIENT_SECRET`
- `TUYA_ENDPOINT`
- `TUYA_DEVICE_REGION`
- `TUYA_DEVICE_ID`: opcional, usado como fallback em `/tuya/status`

Operacao:

- `PRICE_PER_KWH`: tarifa fallback por kWh
- `DEFAULT_CHARGE_CURRENT_A`: corrente padrao para novas estacoes

Obrigatorias em producao:

- `DATABASE_URL`
- `JWT_SECRET`

Para fluxo real de carregamento, as credenciais Tuya tambem precisam estar configuradas.

## Banco e migracoes

Subir o Postgres local:

```bash
docker compose up -d
```

Rodar migracoes:

```bash
npm run migrate
```

## Desenvolvimento

Instalar dependencias:

```bash
npm install
```

Subir o backend:

```bash
npm start
```

Subir o frontend Vite em outra janela:

```bash
npm run web:dev
```

Nesse modo, o Vite roda separado do Express. Websocket do Vite e hot reload sao apenas de desenvolvimento.

## Producao local

Gerar o frontend:

```bash
npm run build:web
```

Subir a aplicacao:

```bash
npm start
```

Com `web/dist` presente, o Express serve a SPA e continua expondo os endpoints do backend no mesmo processo.

## Health checks

- `GET /health`: retorna `{ "ok": true }`
- `GET /health/db`: executa `SELECT 1` e retorna `{ "ok": true, "db": "postgres" }`
- `GET /health/tuya`: verifica se as credenciais Tuya estao configuradas sem expor secrets

## Seguranca e observacoes operacionais

- `helmet` esta habilitado globalmente para endurecer headers HTTP.
- Rate limit global:
  `100` requisicoes por `15` minutos em rotas ` /api/* ` e ` /session/* `
- Rate limit reforcado:
  `10` requisicoes por `15` minutos em endpoints sensiveis de login/cadastro e inicio administrativo
- Logs HTTP registram metodo, rota, status, tempo de resposta, `user_id`, `station_id` e `session_id` quando disponiveis.
- Tokens, cookies e senha nao sao logados.

Cookies e HTTPS:

- Em producao, prefira `COOKIE_SECURE=true`.
- `COOKIE_SAMESITE=none` exige `COOKIE_SECURE=true`.
- Em ambiente local sem HTTPS, use `COOKIE_SECURE=false`.
- Se o frontend estiver em outro dominio/subdominio, ajuste `COOKIE_DOMAIN` e `COOKIE_SAMESITE` com cuidado.
