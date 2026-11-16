# Rael Agendamentos

Aplicação autohospedada para uma empresa por instalação. Inclui agenda pública, clientes, equipe, financeiro e planos de serviços. A página inicial exibe a vitrine da empresa e oferece acesso ao login, ao cadastro e à agenda pública. O gestor configura o logo, título, cor, descrição e endereço em **Negócio**. A vitrine usa os serviços e os profissionais do catálogo publicado. Alterações no rascunho aparecem após republicar. Gestores, profissionais e recepção usam acessos individuais.

## Antes de instalar

Para entregar a **Community**, deixe `APP_LICENSE_MODE` e `RAEL_TEST_MODE` ausentes. O limite de **dois profissionais ativos por instalação** funciona localmente. O cadastro profissional inicial do gestor ocupa uma vaga enquanto estiver ativo. Recepção e cadastros inativos ficam fora da contagem. Inative um profissional para liberar a vaga e preservar seu histórico. Se atualizar uma instalação que já excede o limite, reduza o número de ativos e republique o catálogo. Os registros e agendamentos existentes são preservados.

Escolha o domínio definitivo e a origem HTTPS sem barra final. Gere um token de instalação temporário com `node -p "require('node:crypto').randomBytes(32).toString('base64url')"`. Use uma data de expiração ISO 8601, por exemplo 24 horas após o início da instalação.

Configure `APP_ORIGIN`, `APP_SLUG` (padrão `agenda`), `APP_BUSINESS_NAME`, `APP_OWNER_NAME`, `APP_OWNER_EMAIL`, `APP_SETUP_TOKEN` e `APP_SETUP_EXPIRES`. Configure `APP_SOURCE_URL` com a URL HTTPS da tag ou do commit que corresponde à versão instalada para exibir o link do código-fonte.

Depois de subir, abra `https://SEU_DOMINIO/sistema/SEU_SLUG#ativar=SEU_TOKEN` em privado. Defina a senha e entre novamente para configurar serviços e publicar a agenda. Remova as cinco variáveis `APP_BUSINESS_NAME`, `APP_OWNER_NAME`, `APP_OWNER_EMAIL`, `APP_SETUP_TOKEN` e `APP_SETUP_EXPIRES` após a ativação. Preserve `APP_SLUG` em atualizações.

## VPS com Docker Compose

1. Aponte o domínio para a VPS e libere as portas 80 e 443 para o proxy HTTPS.
2. Clone o repositório e copie `.env.example` para `.env`.
3. Preencha as variáveis da instalação e escolha senhas distintas para `DB_PASSWORD` e `DB_ROOT_PASSWORD`.
4. Execute `docker compose up -d --build` e confira `docker compose ps`. O MySQL fica na rede interna do Compose e o proxy emite o certificado HTTPS.
5. Após ativar o gestor e remover o token da configuração, execute `docker compose up -d` para aplicar a mudança.

No Docker Manager da Hostinger, o arquivo para importação por URL é [docker-compose.hostinger.yml](docker-compose.hostinger.yml). O painel usará uma referência ao repositório público para fazer o build. Cadastre as variáveis antes de subir a aplicação.

## Hostinger App Web Node

1. Crie um banco MySQL dedicado e um usuário com acesso somente a esse banco no hPanel. Use os valores do painel em `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` e `DB_PASSWORD`.
2. Importe o repositório em **App Web Node**, selecione **Other**, Node.js **24**, diretório do app **mockup**, comando de build **npm run build** e ponto de entrada **server.js** (ou comando **npm start** quando o painel pedir o comando de início).
3. Defina as variáveis da instalação no painel com `NODE_ENV=production`. A aplicação usa a porta fornecida pelo painel em `PORT`.
4. Publique em HTTPS e ative o gestor. Em seguida, remova o token de instalação e aplique a configuração novamente.

Esse fluxo requer um plano com Apps Web Node e conectividade ao MySQL. Consulte o [guia de deploy Node da Hostinger](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/). O App Web Node recebe somente o código Node e a configuração. O Docker Compose é usado para a VPS.

## Licenciamento em homologação

No piloto, `APP_LICENSE_MODE=test` disponibiliza **Configurações → Licença do sistema** ao administrador. O modo fica desativado por padrão. A instalação usa um identificador próprio e guarda a credencial no banco do negócio. O painel aceita apenas licenças assinadas pela chave pública de homologação e links do sandbox do Mercado Pago.

- A Community permite dois profissionais ativos. O painel consulta preço e capacidade dos planos pagos na central.
- Na primeira compra, confirme o e-mail e abra o checkout pelo painel. A licença aparece após a confirmação do pagamento, mesmo se o checkout for fechado sem voltar à loja.
- A renovação é anual e manual. Prepare o pedido no painel e pague pelo checkout de teste.
- Após reinstalar, solicite a recuperação com o e-mail da compra e confirme a transferência pelo link recebido. A validade é preservada. O backup lógico não inclui a identidade da instalação.

## Integrações PRO no piloto

No piloto, `APP_PRO_MODE=test` e `APP_LICENSE_MODE=test` habilitam as integrações e o licenciamento de homologação. Em **Configurações → Licença do sistema → Integrações PRO**, o gestor pode simular conversões, acompanhar entregas e gerar ou revogar o token da API. As permissões dependem de uma licença PRO assinada e ativa.

- **Meta.** Defina o conjunto de dados, o token e o código de teste no servidor em `APP_PRO_META_TEST_DATASET_ID`, `APP_PRO_META_TEST_TOKEN` e `APP_PRO_META_TEST_EVENT_CODE`. O piloto envia o evento `Schedule`. A simulação inclui o código de teste do Gerenciador de Eventos.
- **Google Ads.** Defina a conta em `APP_PRO_GOOGLE_TEST_ACCOUNT` e o ID da ação de importação de cliques em `APP_PRO_GOOGLE_TEST_ACTION`. Para produção, dê à [conta de serviço do Google Cloud](https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access) acesso Padrão à conta do Google Ads que contém a ação. Guarde a chave JSON em Base64URL como segredo no servidor em `APP_PRO_GOOGLE_SERVICE_ACCOUNT_B64`. A conta de serviço tem precedência e autentica o piloto com o escopo `https://www.googleapis.com/auth/datamanager`.
- **OAuth de teste do Google.** A alternativa é usar `APP_PRO_GOOGLE_TEST_OAUTH_B64` com o JSON `{client_id, client_secret, refresh_token}` em Base64URL ou fornecer `APP_PRO_GOOGLE_CLIENT_ID`, `APP_PRO_GOOGLE_CLIENT_SECRET` e `APP_PRO_GOOGLE_REFRESH_TOKEN`. Nas duas formas, a credencial precisa do escopo do Data Manager e de acesso à conta da ação. A simulação do painel sempre usa `validateOnly: true`.
- **API.** Envie `Authorization: Bearer <token de teste>` para `GET /api/v1/appointments?limit=30&offset=0&status=confirmed`. A resposta inclui os horários, o status e IDs operacionais, e `nextOffset` informa a próxima página. O token troca imediatamente ao gerar outro. O backup lógico exclui tokens e fila de eventos.
- **Webhooks.** Defina `APP_PRO_WEBHOOK_TEST_URL` com um endereço HTTPS controlado e `APP_PRO_WEBHOOK_TEST_SECRET` com 32 bytes em hexadecimal. O teste sintético pode chegar ao endereço externo. Com envios reais habilitados, o mesmo receptor recebe novas confirmações com `X-Rael-Mode: live`. O receptor valida `X-Rael-Signature` como `sha256=<HMAC-SHA256 do timestamp, ponto e corpo JSON bruto>`, usando os bytes do segredo e `X-Rael-Timestamp`. Rejeite timestamps fora da janela do receptor, compare em tempo constante e deduplique por `X-Rael-Event-Id`. A fila repete falhas transitórias e guarda o histórico por 30 dias. O webhook externo de operação usa apenas confirmação de agendamento.

### Envios reais

Na instalação standalone, habilite `APP_PRO_REAL_EVENTS=1` depois de configurar os destinos. O piloto envia novas confirmações com a licença PRO ativa e deduplica cada destino por agendamento. Pagamentos do sandbox ficam fora dos envios reais.

- **Meta e Google Ads.** O cliente precisa entrar pela página inicial com o identificador do clique do anúncio e autorizar a medição. A atribuição usa o vínculo entre o acesso e o agendamento. Os identificadores locais expiram em sete dias.
- **Webhook.** O receptor recebe a confirmação assinada com `X-Rael-Mode: live`. O corpo inclui o identificador e o horário do agendamento, sem dados de contato.

Em **Entregas recentes**, cada evento aparece como **Real** ou **Teste**. **Validado pelo Google** indica que a API aceitou o teste de validação. Para um envio real, **Google aceitou para processamento** indica que a solicitação entrou na fila do Google. Confira a atribuição no relatório da ação de conversão. Quando falta uma credencial de destino, a simulação correspondente aparece como **Simulado localmente**.

## Operação

Em **Negócio**, adicione uma foto horizontal de capa para a página inicial. A capa pode ser trocada ou removida sem alterar o logo. Em **Acessos**, o gestor pode consultar o gráfico diário e filtrar por período, origem, meio e campanha. Use os atalhos de 7, 30 ou 90 dias ou datas personalizadas. A taxa por campanha divide os acessos rastreados que geraram ao menos um agendamento em até duas horas pelo total de acessos rastreados no período. A mesma abertura conta uma vez, mesmo com várias reservas, e a conversão pertence à data do acesso. Os totais de acessos e agendamentos também incluem o histórico sem vínculo. Para marcar uma campanha, compartilhe `https://SEU_DOMINIO/?utm_source=instagram&utm_medium=social&utm_campaign=lancamento`.

- Comece com recebimentos manuais. Para Mercado Pago, configure `RAEL_INTEGRATION_KEY` com 32 bytes aleatórios em hexadecimal, conecte a conta do negócio e homologue antes de ativar `RAEL_MP_LIVE_APPROVED=1`.
- O SMTP é opcional. Configure `RAEL_RECOVERY_EMAIL_ENABLED=1`, a chave de integração e as variáveis `RAEL_SMTP_HOST`, `RAEL_SMTP_PORT`, `RAEL_SMTP_USER` e `RAEL_SMTP_PASSWORD`. A conta SMTP também é o remetente.
- Para backup lógico cifrado, defina `RAEL_BACKUP_KEY` com 32 bytes aleatórios em hexadecimal apenas no ambiente da tarefa e use `node tools/manage.mjs backup --slug agenda --output /caminho/privado/agenda.backup` a partir da pasta `mockup`. Use `restore --slug agenda --input caminho` em um MySQL vazio com as variáveis de inicialização do gestor ausentes. Mantenha backup e chave separados e ensaie a restauração antes de migrar dados.
- Preencha os termos e o aviso de privacidade da empresa antes de disponibilizar a instalação a consumidores. Os modelos ficam em `mockup/legal`.

Código sob [GNU AGPL v3](LICENSE). Serviços de instalação, migração e manutenção podem ser contratados separadamente.
