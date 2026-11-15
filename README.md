# Rael Agendamentos

Aplicação autohospedada para uma empresa por instalação. Inclui agenda pública, clientes, equipe, financeiro e planos de serviços. A página inicial exibe a vitrine da empresa e oferece acesso ao login, ao cadastro e à agenda pública. O gestor configura o logo, título, cor, descrição e endereço em **Negócio**. A vitrine usa os serviços e os profissionais do catálogo publicado. Alterações no rascunho aparecem após republicar. Gestores, profissionais e recepção usam acessos individuais.

## Antes de instalar

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

## Operação

- Comece com recebimentos manuais. Para Mercado Pago, configure `RAEL_INTEGRATION_KEY` com 32 bytes aleatórios em hexadecimal, conecte a conta do negócio e homologue antes de ativar `RAEL_MP_LIVE_APPROVED=1`.
- O SMTP é opcional. Configure `RAEL_RECOVERY_EMAIL_ENABLED=1`, a chave de integração e as variáveis `RAEL_SMTP_HOST`, `RAEL_SMTP_PORT`, `RAEL_SMTP_USER` e `RAEL_SMTP_PASSWORD`. A conta SMTP também é o remetente.
- Para backup lógico cifrado, defina `RAEL_BACKUP_KEY` com 32 bytes aleatórios em hexadecimal apenas no ambiente da tarefa e use `node tools/manage.mjs backup --slug agenda --output /caminho/privado/agenda.backup` a partir da pasta `mockup`. Use `restore --slug agenda --input caminho` em um MySQL vazio com as variáveis de inicialização do gestor ausentes. Mantenha backup e chave separados e ensaie a restauração antes de migrar dados.
- Preencha os termos e o aviso de privacidade da empresa antes de disponibilizar a instalação a consumidores. Os modelos ficam em `mockup/legal`.

Código sob [GNU AGPL v3](LICENSE). Serviços de instalação, migração e manutenção podem ser contratados separadamente.
