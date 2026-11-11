# Auditoria de segurança do backend — 11/11/2026

## Escopo e resultado

Branch local `feature/backend-security-audit`, criada a partir de `develop`
(`e097d12`). A mudança atualiza as dependências de produção da raiz do projeto;
não altera regras de cobrança, autenticação, telemetria ou infraestrutura.

| `npm audit --omit=dev` | Críticas | Altas | Moderadas | Total |
| --- | --- | --- | --- | --- |
| Antes | 1 | 5 | 1 | 7 |
| Depois de `npm ci` | 0 | 0 | 0 | 0 |

Resultado final: `found 0 vulnerabilities`. É o resultado do registro npm na data
acima, não uma garantia de ausência de vulnerabilidades desconhecidas. A auditoria
registrada aqui é do **backend**, não das dependências do frontend.

## Atualizações

| Pacote com alerta | Antes | Depois | Vínculo |
| --- | --- | --- | --- |
| `compression` | 1.8.1 | 1.8.2 | Direto |
| `express-rate-limit` | 8.2.1 | 8.7.4 | Direto |
| `body-parser` | 2.2.2 | 2.4.0 | Transitivo do Express |
| `ip-address` | 10.0.1 | 10.7.6 | Transitivo de express-rate-limit |
| `path-to-regexp` | 8.3.0 | 8.4.2 | Transitivo do roteador do Express |
| `proxy-addr` | 2.0.7 | 2.0.8 | Transitivo do Express |
| `qs` | 6.15.0 | 6.17.1 | Transitivo do Express/body-parser |

`express` permanece em **5.2.1**. Não foi necessário trocar sua versão principal
nem adicionar dependências transitivas como dependências diretas.

O lockfile também atualizou auxiliares compatíveis exigidos pela resolução:

| Pacote | Antes | Depois |
| --- | --- | --- |
| `es-object-atoms` | 1.1.1 | 1.1.2 |
| `hasown` | 2.0.2 | 2.0.4 |
| `iconv-lite` | 0.7.2 | 0.7.3 |
| `side-channel` | 1.1.0 | 1.1.1 |
| `side-channel-list` | 1.0.0 | 1.0.1 |
| `type-is` | 2.0.1 | 2.1.0 |
| `content-type` | Novas cópias aninhadas | 2.1.0, em body-parser e type-is |
| `destroy` | Novo | 1.2.0 |

## Procedimento

1. `npm audit --omit=dev` confirmou os sete alertas anteriores.
2. `npm audit fix --dry-run` propôs somente mudanças compatíveis com as faixas
   existentes. O dry-run continuou exibindo os alertas porque não aplicou mudanças.
3. `npm audit fix` corrigiu os sete alertas sem `--force` ou `overrides`.
4. Os mínimos de `compression` e `express-rate-limit` no `package.json` foram
   elevados a `^1.8.2` e `^8.7.4`, respectivamente. O `package-lock.json` foi
   sincronizado com `npm install --package-lock-only --ignore-scripts`.
5. `npm ci` fez a instalação limpa e `npm audit --omit=dev` confirmou zero alertas.
   `npm ls --omit=dev` e a comparação dos manifestos confirmaram árvore válida
   e concordância entre package.json e lockfile.

Não há atualização incompatível ou vulnerabilidade conhecida pendente no relatório
de produção do backend. As versões exatas reproduzíveis ficam no lockfile: usar
`npm ci`, não regenerá-lo durante o deploy.

## Testes executados

Ambiente: Node.js **24.14.0**, PostgreSQL 16 local, sessões/repositórios simulados
nos testes HTTP e provedor Web Push simulado. Os testes com PostgreSQL criam schemas
temporários e desfazem tudo com rollback. Nenhum comando foi enviado ao carregador,
nenhuma notificação real foi enviada e nenhum banco de produção foi acessado.

- `npm test`: **69 passaram, zero falhas, zero ignorados**, incluindo sete novas
  regressões em `tests/backendSecurity.test.js`.
- `npm run build`: **aprovado**; inclui instalação limpa do frontend, TypeScript e
  Vite. Nenhum manifesto/lockfile do frontend foi alterado.
- `git diff --check`: **aprovado**.

Cobertura específica:

- Login HTTP com bcrypt/JWT reais, admin com/sem **Manter-me conectado**, cookie
  HttpOnly/Secure/SameSite e validade persistente alinhada; nova requisição com o
  cookie autentica, logout revoga e replay retorna 401. Usuário comum não recebe
  persistência ampliada mesmo enviando a opção marcada.
- Atrás de um proxy confiável (`trust proxy=1`): dez tentativas de login por IP em
  15 minutos, 11ª retorna 429 com `Retry-After`; outro IP no mesmo proxy continua
  podendo entrar. Inserir outro IP à esquerda no X-Forwarded-For não libera o IP
  já bloqueado.
- Alternar IPv4 com formas IPv4-mapeadas-em-IPv6 não reinicia a contagem; IPv6
  preserva agrupamento por /56 sem bloquear outra sub-rede. Regressão do proxy-addr
  verifica que prefixo mapeado incorreto não passa a confiar em IP arbitrário.
- body-parser aceita JSON gzip válido, rejeita JSON inválido e mantém limite de
  tamanho tanto no corpo normal quanto no descomprimido. compression produz gzip
  válido em resposta autenticada. A pilha Express compila as rotas existentes.
- Web Push: conexão separada do início, início exige fluxo real, término depende
  de histórico/consumo validado inclusive sem cliente; deduplicação, reinício,
  expiração/revogação/logout, perda de admin, autorização antes de cada envio,
  erro do provedor e destinos seguros do service worker continuam passando.

Comandos para repetir, usando somente o banco local:

```powershell
npm ci
npm audit --omit=dev
npm run build
$env:TEST_DATABASE_URL = 'postgresql://carregador:carregador123@127.0.0.1:5432/carregador_db'
try { npm test } finally { Remove-Item Env:TEST_DATABASE_URL }
```

## Publicação e verificações manuais pendentes

- Não há migration nova ou variável de ambiente nova nesta branch. O banco precisa
  continuar com as migrations anteriores aplicadas, inclusive `011_admin_push_sessions.sql`,
  exigida pelo login com sessões revogáveis. Atualizar dependências não substitui
  essa migration nem corrige sua ausência.
- Publicar somente depois de revisar a branch. O Dockerfile atual usa Node 24 e
  `npm ci --omit=dev`; não necessita alteração. Esta entrega não faz commit, push,
  merge ou deploy automaticamente.
- No Dado, validar um login de admin com/sem a caixa marcada, logout e uma sequência
  controlada de tentativas. Os testes simulam **um** proxy; não verificam a topologia
  real do Dado. Confirmar que o proxy informa o IP real e saneia/acrescenta o
  X-Forwarded-For, e que não há caminho público direto que permita falsificá-lo.
  Não trocar `trust proxy` por `true` para contornar problemas.
- O limitador existente usa memória por processo: reinícios zeram contagens e
  réplicas não compartilham o limite. Não foi introduzido armazenamento distribuído
  nesta correção de dependências.
- Persistência efetiva após fechar/reabrir o app e entrega Web Push com o app fechado
  continuam exigindo iPhone real, HTTPS e VAPID configurado. Não houve teste com
  Safari/aparelho ou serviço de entrega real nesta alteração.
- O build mostrou apenas o aviso de base Browserslist desatualizada; não é alerta
  de `npm audit` do backend. Sua atualização não foi misturada a esta correção.

Referências: [advisory de IPv4/IPv6 no limitador](https://github.com/express-rate-limit/express-rate-limit/security/advisories/GHSA-46wh-pxpv-q5gq),
[advisory de proxy-addr](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) e
[orientação oficial sobre proxies](https://express-rate-limit.mintlify.app/guides/troubleshooting-proxy-issues).
