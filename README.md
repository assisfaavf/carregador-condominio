# carregador-condominio

## Postgres e migrações

Subir o Postgres:

```bash
docker compose up -d
```

Rodar migrações:

```bash
npm run migrate
```

## Produção

Instalar dependências:

```bash
npm install
```

Gerar o frontend em `web/dist`:

```bash
npm run build:web
```

Iniciar o backend Express servindo a SPA:

```bash
npm start
```

Acessar:

```text
http://localhost:<PORT_BACKEND>/
```

## Testes

### Dev (Vite + backend separado)

Subir o backend:

```bash
npm start
```

Subir o frontend:

```bash
npm run web:dev
```

Validar:

1. Fazer login no React.
2. Atualizar a página e confirmar que a sessão foi mantida.
3. Fazer logout e confirmar que o cookie foi removido.
4. Conferir a leitura do `.env` em desenvolvimento:

```text
GET /api/debug/cookie-config
```

### Produção local (React servido pelo Express)

Gerar build:

```bash
npm --prefix web run build
```

Definir no `.env`:

```env
NODE_ENV=production
```

Subir a aplicação:

```bash
npm start
```

Validar:

1. Abrir `/login`.
2. Fazer login.
3. Atualizar `/app/home` e confirmar que a sessão continua válida.
4. Fazer logout e confirmar que o cookie foi removido.

Se o cookie não for gravado em ambiente local sem HTTPS, deixe:

```env
COOKIE_SECURE=false
```
