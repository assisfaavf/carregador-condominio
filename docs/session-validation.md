# Validação energética das sessões

## Diagnóstico

O consumo anterior era a diferença de `forward_energy_total` entre início e
detecção do término, com fallback para `charge_energy_once`. Não havia amostras
persistidas, lacunas não eram identificadas e o instante de detecção era usado
como término. O watchdog podia encerrar prematuramente, deixando a detecção
externa recriar a carga sem o usuário original.

## Implementação

Branch: develop. Migration incremental: `009_session_validation.sql`.
As sessões antigas permanecem intactas e precisam de revisão explícita antes
de entrarem nos totais confirmados. Nenhum script recalcula o histórico antigo.

O watchdog persiste as propriedades selecionadas e os timestamps de origem.
`forward_energy_total` e `charge_energy_once` mantêm a escala existente /100;
`phase_a` mantém tensão /10, corrente /1000 e potência /1000. Essas escalas
seguem o decodificador existente; não foram verificadas contra um carregador real
nesta execução. A potência de `phase_a` pode representar somente uma fase:
isso pode gerar divergência com o contador em cargas trifásicas. Não se aplica
um multiplicador fixo para validar cobrança.

`charge_energy_once` é armazenado como referência não confirmada. Não há aprovação
automática baseada apenas nesse campo; ele pode pertencer à recarga anterior.
Diferenças com ele permanecem visíveis para revisão.

A integração usa apenas intervalos entre amostras próximas da mesma sessão.
Lacunas não recebem energia estimada. Contadores reiniciados, potência inválida,
cobertura incompleta e ausência de horário final impedem aprovação automática.
As tabelas preservam os campos brutos e deduplicam amostras por hash.

O término físico salva uma sessão encerrada com validação pendente antes de
confirmar a conciliação. Sem prova do término após uma lacuna, `end_time` fica
NULL. O histórico Tuya é consultado de forma limitada (48 horas, 100 registros
por código); se ele não cobrir a sessão, a validação permanece inconclusiva.
Uma rotina independente tenta novamente uma sessão pendente por minuto, com
intervalo mínimo de cinco minutos por sessão, por até sete dias. Após esse
período, a revisão manual continua disponível. Ela nunca comanda o carregador.

No histórico administrativo, “Revisar consumo / vincular cliente” mostra as
três fontes, o consumo conciliado e as pendências. O administrador pode selecionar
um cliente existente, reconciliar novamente ou confirmar um consumo com
justificativa. As alterações são auditadas com autor, data e valores anteriores.

Os totais financeiros e energéticos confirmados recebem apenas sessões encerradas,
validadas e vinculadas, com preço definido. Marcar como pago também exige essas
condições no backend. Dados antigos e inconclusivos seguem no histórico,
sem aprovação implícita. Alterações manuais prevalecem sobre novas tentativas
automáticas de conciliação.

## Configuração

- `ENERGY_TOLERANCE_KWH`: tolerância absoluta, padrão 0,2 kWh.
- `ENERGY_TOLERANCE_RATIO`: tolerância proporcional, padrão 0,05 (5%).
- `ENERGY_MAX_SAMPLE_GAP_SECONDS`: intervalo máximo integrado, padrão 30 segundos.

A maior tolerância das duas é usada. Nenhuma dependência nova foi adicionada.
O carregamento de amostras para conciliação tem limite de 20.000; atingido o
limite, a sessão requer revisão em vez de validar com dados truncados.

## Aplicação e testes

Aplicar a migration em banco de teste antes do deploy. Para Neon, usar conexão
direta para migrations. O código depende da migration; publicar somente o
backend sem atualizar o schema causa erros de consulta.

`npm test` executa cenários simulados sem importar/iniciar o servidor nem acessar
Tuya. `npm --prefix web run build` valida TypeScript e gera o frontend.
O teste opcional de PostgreSQL exige `TEST_DATABASE_URL`, explicitamente de teste;
ele cria schema temporário dentro de transação e executa rollback.

Não executar testes contra `DATABASE_URL` de produção. Não iniciar ou interromper
recargas reais para validação. As respostas reais da Tuya e o schema do Render/
Neon precisam de validação no ambiente de homologação antes do uso em produção.
