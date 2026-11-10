# Notificações Web Push — SPATE Charge

## O que foi implementado

O backend Express existente observa a telemetria no watchdog, persiste transições
no PostgreSQL e envia Web Push em um processamento separado a cada 15 segundos.
Não há serviço externo adicional, Firebase SDK ou dependência de aba aberta.
O Dockerfile atual já inclui os serviços, migrations e arquivos do build Vite.

Em **Administração → Configurações**, a seção **Notificações do administrador**
oferece **Ativar notificações** / **Desativar notificações**. Apenas o toque no botão
de ativação solicita permissão. Nenhuma permissão é solicitada ao abrir a página.
O painel legado `/admin.html` contém um link para essa configuração.

| Aviso | Evidência utilizada | Destino ao tocar |
| --- | --- | --- |
| Carro conectado | `connection_state`: transição de `controlpi_12v` para `controlpi_9v`, `controlpi_6v` ou `controlpi_3v` | `/admin/dashboard?station_id=…`, destacando a estação por rolagem |
| Recarga iniciada | `work_state=charger_charging` e fluxo em `phase_a` (≥ 2 A ou ≥ 0,5 kW, amostra de até 30 s quando há timestamp), sem CP indicando desconexão | Painel da estação |
| Recarga finalizada | Sessão `done`, conciliação `validated` e consumo gravado atomicamente com `push_validated_at` | `/admin/history` |

O comando `switch` não gera o aviso de início. A corrente anormal de 0,9 A, sozinha,
também não confirma início. A finalização independe de `client_id` e `user_id`.
Consumos pendentes, divergentes ou inconclusivos não geram aviso de finalização;
o aviso fica elegível quando uma nova tentativa ou correção manual os valida.
O corpo inclui estação e consumo validado, sem nome do cliente.

## Sessão e segurança

- Cada login recebe um JWT com identificador aleatório `jti` e uma sessão no banco.
  O JWT continua em cookie `HttpOnly`, com `Secure` obrigatório em produção.
- A caixa **Manter-me conectado** começa desmarcada nos dois logins (`/login` e
  `/login.html`). Marcá-la só altera a persistência para administradores.
- Admin marcado: cookie persistente com validade alinhada ao JWT e à sessão no
  banco; `ADMIN_REMEMBER_EXPIRES_IN` controla a duração, inicialmente `7d`.
- Desmarcado e contas comuns: preservam `JWT_EXPIRES_IN` e o cookie sem `Max-Age`
  anterior. A restauração de cookies de sessão pelo navegador depende do navegador.
  O padrão anterior de JWT já era `7d`; a diferença padrão é a persistência do cookie.
- Não há renovação infinita: a sessão expira no prazo contado desde o login.
- A inscrição é vinculada ao `jti` da sessão daquele aparelho, não apenas ao usuário.
  Outro aparelho precisa fazer login e ativar os próprios avisos. Novo login substitui
  e revoga a sessão do cookie anterior; é necessário reativar os avisos na nova sessão.
- O servidor verifica autenticação e `is_admin` para inscrever e consulta novamente
  a sessão, expiração, revogação e perfil atual antes de **cada envio**.
- Logout revoga a sessão no banco antes de limpar o cookie. Se o banco falhar,
  retorna erro e a interface não confirma uma saída que não foi revogada.
- JWTs anteriores sem `jti` são identificados pelo hash do token e adotados no banco
  sem desfazer revogações. O token bruto não é armazenado no banco.
- `GET /api/auth/sessions` lista as próprias sessões; `DELETE /api/auth/sessions/:id`
  revoga somente uma sessão do usuário autenticado. Não foi criada uma tela de gestão
  de sessões. Perda da função de admin ou cadastro rejeitado também bloqueiam envios.
- As rotas Push são `/api/admin/push` (`GET`, `POST`, `DELETE`), protegidas por
  autenticação e autorização de admin. Apenas a chave VAPID pública é exposta.
- Endpoints de inscrição aceitam HTTPS de provedores Apple, Google, Mozilla e Windows,
  com validação de formato das chaves, sem URLs arbitrárias para o backend acessar.
- O service worker não faz cache de telas ou respostas autenticadas. Os destinos dos
  avisos são limitados ao painel e histórico no mesmo domínio; as telas continuam
  protegidas pelo guard administrativo e pelas APIs autenticadas do servidor.

## Migração e publicação no Dado

1. Use Node.js 24 LTS, como no Dockerfile. Instale as dependências com `npm ci`.
2. Gere o par VAPID **uma única vez, localmente**:

   ```powershell
   cd C:\Projetos\carregador-condominio
   node scripts/generate-vapid.js
   ```

   O comando imprime uma chave pública e uma privada. Trate a saída como segredo:
   não envie para Git, tickets ou logs de deploy. Guarde a privada nos segredos do Dado.
   Não regenere as chaves em cada deploy; trocar o par exige reinscrever os aparelhos.

3. Configure as variáveis de runtime no Dado:

   | Variável | Conteúdo |
   | --- | --- |
   | `VAPID_PUBLIC_KEY` | Chave pública gerada |
   | `VAPID_PRIVATE_KEY` | Chave privada gerada; somente backend |
   | `VAPID_SUBJECT` | Contato real, por exemplo `mailto:administracao@seu-dominio.com.br` |
   | `ADMIN_REMEMBER_EXPIRES_IN` | `7d` inicialmente; pode usar, por exemplo, `14d` |
   | `NODE_ENV` | `production` |
   | `COOKIE_SECURE` | `true` (produção força cookie seguro de qualquer maneira) |

   Preserve `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, configurações Tuya e
   domínio/caminho atuais do cookie. **Não troque `JWT_SECRET` em cada deploy**.
   Sem VAPID, os avisos ficam desabilitados, mas o restante da aplicação funciona
   depois de aplicar a migration.

4. Aplique **`011_admin_push_sessions.sql` antes de liberar o novo backend**.
   Ela cria sessões autenticadas, inscrições, estado das estações, eventos e entregas;
   adiciona `sessions.push_validated_at`. O login passa a depender dessas tabelas,
   mesmo quando o Push está desativado. Não altera o consumo de recargas existentes.

   Use a etapa de release se disponível. Sem terminal no Dado, execute localmente,
   na raiz do projeto, com a URL do banco de produção selecionada conscientemente.
   Esta operação modifica esse banco; confira o destino e o backup primeiro:

   ```powershell
   cd C:\Projetos\carregador-condominio
   $env:DATABASE_URL_UNPOOLED = Read-Host 'Cole a URL direta do banco de produção'
   try { npm run migrate } finally { Remove-Item Env:DATABASE_URL_UNPOOLED }
   ```

   O comando deve terminar com `apply 011_admin_push_sessions.sql` e
   `Migrações finalizadas.`. Não publique a URL ou a senha do banco.

5. Gere o build e publique pelo Dockerfile da raiz. O build inclui `manifest.webmanifest`,
   `sw.js` e o ícone atual de 180×180; o favicon da aba é preservado.
   Use o mesmo domínio HTTPS para frontend e backend. Evite redirecionar o domínio
   após a instalação, pois permissão e inscrição são específicas da origem.
6. Mantenha o backend ativo, com acesso de saída HTTPS aos provedores Push. Um backend
   suspenso não consulta a Tuya nem envia notificações. Não execute outra instância
   do monitor local contra o carregador real para testar esta funcionalidade.

## Ativação no iPhone

É necessário iOS/iPadOS **16.4 ou mais recente**, HTTPS e o web app instalado na Tela
de Início. No Safari: **Compartilhar → Adicionar à Tela de Início**, abra pelo ícone,
entre como admin, marque **Manter-me conectado** se desejar persistência e acesse
**Configurações → Ativar notificações**. Autorize o pedido do sistema.

Se já havia um atalho antigo, remova-o e adicione novamente se ele não abrir como
app independente. Não é necessário manter a janela aberta depois de ativar.
Para permissão negada, use os ajustes de notificações do iPhone; o site não consegue
forçar a reapresentação do pedido. O modo Foco e ajustes do sistema afetam a exibição.

Referências: [WebKit — Web Push para apps na Tela de Início](https://webkit.org/blog/13878/)
e [Apple — Web Push em apps e navegadores](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).

## Duplicatas, falhas e limitações

- Estado anterior e contadores de ciclos são persistidos por estação; leituras
  repetidas/fora de ordem não repetem transições. Eventos têm chave única; a
  finalização usa o ID da recarga. Cada inscrição recebe no máximo uma tentativa
  por evento, com chave única de entrega e reserva atômica no PostgreSQL.
- A primeira leitura estabelece uma referência: não inventa um aviso de conexão ou
  início para um veículo já conectado ao ligar a plataforma pela primeira vez.
  Reinícios reutilizam o estado salvo. Não é possível reconstruir vários ciclos
  completos que ocorreram enquanto o backend estava desligado somente pelo estado atual.
- `connection_state` permite separar conexão e carga no equipamento atual. Se outro
  modelo omitir o CP ou usar códigos desconhecidos, não há aviso de conexão; o aviso
  de início continua possível com estado de carga e fluxo elétrico confirmados.
- A observação é por polling do watchdog existente, não instantânea nem por webhook.
  Transições mais curtas que o intervalo de leitura podem não ser observadas.
- Recargas históricas não disparam uma enxurrada de avisos na migração. O marcador
  de validação começa vazio e é preenchido em novas validações. Uma recarga antiga
  corrigida e validada após a migração pode produzir seu primeiro aviso de finalização.
- Somente eventos recentes (até 15 minutos) e posteriores à ativação da inscrição
  são entregues. Não há envio retroativo ilimitado após indisponibilidade.
- A estratégia privilegia **não duplicar**: reserva antes de enviar, sem repetição
  automática em caso de erro/timeout. Uma queda entre reserva e entrega pode perder
  aquele aviso; não existe garantia de entrega exatamente uma vez via Web Push.
  O mesmo `tag` também agrupa apresentações repetidas do mesmo evento no aparelho.
- Erros de envio são registrados por evento/inscrição/código, sem endpoint, chaves ou
  corpo da resposta do provedor. `404/410` desativam a inscrição inválida. O histórico
  e a conciliação não aguardam a rede Push e não são revertidos por falha no aviso.
- Logout, expiração, revogação e perda de admin impedem **novos envios**. Uma mensagem
  já aceita pelo provedor pode estar em trânsito e não pode ser retirada pelo servidor.
  O TTL é limitado ao menor prazo entre 5 minutos e o tempo restante da sessão.
- Sessões e eventos ficam no banco para auditoria. Planeje retenção/limpeza conforme
  o volume; não foi adicionado expurgo automático de dados nesta alteração.

## Validação

Testes locais automatizados usam sinais Tuya simulados, provedor Push simulado e
PostgreSQL local em schemas temporários com rollback. Não enviam comandos ao
carregador e não modificam o banco de produção.

```powershell
$env:TEST_DATABASE_URL = 'postgresql://carregador:carregador123@127.0.0.1:5432/carregador_db'
npm --prefix web run build:assets
npm test
```

A suíte cobre os três eventos, finalização sem cliente, deduplicação e reinício,
inscrição/admin, sessões expiradas/revogadas, logout entre duas entregas, perfil
removido, provedor indisponível, política de duração/cookie, handler de login/logout
e service worker com/sem janela e roteamento seguro. O teste de reabertura simula
uma nova requisição com o cookie; não substitui o teste de persistência no Safari.

O smoke test HTTP monta a pilha Express real, sem os processos de monitoramento e
com banco/Tuya bloqueados, e confere os arquivos PWA e a proteção das APIs Push.
Ele requer o build Vite presente; execute o build antes da suíte para incluí-lo.

Resultado de desenvolvimento nesta entrega: **62 testes passaram, sem falhas e sem
testes ignorados**, incluindo os dois testes com PostgreSQL local. O build de
produção TypeScript + Vite também passou.

**Ainda precisa ser validado no iPhone real e no Dado configurado:**

1. Admin sem a caixa marcada: cookie de sessão e prazo JWT anterior; com ela marcada:
   fechar/reabrir pelo ícone mantém autenticado durante a validade configurada.
2. Autorizar os avisos por toque, fechar o app, conectar um carro e confirmar aviso
   de conexão sem iniciar carga. Começar carga e receber um único aviso de início
   só após fluxo real. Repetir também com início externo pelo Smart Life.
3. Encerrar, aguardar conciliação validada e conferir aviso com energia e histórico
   gravado, inclusive sem cliente. Tocar nos avisos e verificar os destinos.
4. Repetir leituras/reiniciar backend e conferir ausência de duplicatas. Esta etapa
   deve ser planejada sem interromper recargas em andamento.
5. Sair e testar que o cookie anterior não acessa a API e não recebe novos envios;
   repetir com expiração, revogação e remoção de admin. Reativar exige nova sessão.
6. Usuário comum não vê controles nem pode inscrever endpoint pelas APIs.
7. Testar desativação, permissão negada, conectividade e ajustes Foco do aparelho.

Nenhuma entrega real à Apple, reabertura real do app no iPhone, migração de produção
ou publicação no Dado foi executada durante os testes de desenvolvimento.
