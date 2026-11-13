# Monitor de Promoções

Aplicação web instalável (PWA) para acompanhar preços na Steam, CheapShark e feeds RSS, registrar ofertas e enviar alertas por e-mail, Telegram ou WhatsApp.

## Arquitetura

- `web/`: interface responsiva, manifesto PWA, ícone, autenticação da interface e cache do app shell.
- `api/router.js` e `lib/`: API serverless Node.js para a Vercel, autenticação por senha, pesquisa de ofertas, notificações e tarefas agendadas.
- Neon Postgres guarda monitoramentos, ofertas e alertas. O esquema é criado automaticamente na primeira requisição.
- `server.py`: modo local existente com SQLite; os dados locais não são transferidos automaticamente para o banco da Vercel.

## Publicar na Vercel

1. Importe `suporte01byseven-glitch/monitor-de-promocoes` na Vercel.
2. Configure o projeto como **Other**, com a raiz do repositório como Root Directory, sem Build Command e `web` como Output Directory.
3. Em **Storage → Marketplace**, crie/conecte um banco Neon Postgres. A integração deve adicionar `DATABASE_URL` ao projeto.
4. Em **Settings → Environment Variables**, configure em Production (e Preview, se necessário):
   - `APP_PASSWORD`: senha forte com pelo menos 16 caracteres para o acesso ao painel.
   - `SESSION_SECRET`: chave aleatória com pelo menos 32 caracteres.
   - `CRON_SECRET`: segredo aleatório para autorizar as varreduras agendadas.
5. Faça redeploy depois de conectar o banco e salvar as variáveis.
6. Em **Settings → Domains**, copie o domínio de produção. No repositório GitHub, crie a variável de Actions `APP_URL` com esse domínio sem barra final e o secret de Actions `CRON_SECRET` com o mesmo valor configurado na Vercel.
7. Acesse o domínio. A API cria as tabelas na primeira chamada; entre usando `APP_PASSWORD`.

A configuração `vercel.json` encaminha `/api/*` para uma função Node.js, define cabeçalhos da PWA e limita a duração da função a 60 segundos. A Vercel serve os arquivos estáticos de `web/` conforme o Output Directory selecionado no projeto.

## Varredura agendada

O workflow `.github/workflows/scan.yml` chama `/api/cron` a cada 15 minutos e também pode ser executado manualmente na aba **Actions**. Ele consulta até três monitoramentos vencidos por execução; as frequências de 15 minutos, hora, seis horas e diária são aplicadas pelo banco. Configure `APP_URL` e `CRON_SECRET` nas variáveis/secrets de Actions conforme acima. O agendamento do GitHub pode atrasar alguns minutos.

A senha da aplicação, chaves de sessão, conexão ao banco, tokens de notificação e credencial de cron nunca devem ser adicionados ao Git. `.env.example` é apenas um modelo sem valores secretos; `config.json` e arquivos `.env` ficam ignorados.

## Variáveis opcionais

Copie os nomes de `.env.example` para as variáveis de ambiente da Vercel quando for habilitar canais:

- Telegram: `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` (o destino do monitoramento pode substituir o chat padrão).
- E-mail: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` e `SMTP_STARTTLS`.
- WhatsApp Business Cloud API: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` e, opcionalmente, `WHATSAPP_API_VERSION`.
- RSS: `RSS_FEEDS` como JSON array de objetos `{"name":"Ofertas","url":"https://site.exemplo/feed.xml"}`. Só feeds HTTPS são aceitos na versão hospedada.

Steam consulta preços regionais BRL. CheapShark retorna USD; os preços em USD não são comparados com o preço-alvo em reais. RSS só gera oferta quando título ou descrição inclui um preço explícito `R$ 99,90` ou `BRL 99,90`. Epic Games, GOG, Nuuvem e Amazon aparecem como fontes não conectadas até uma integração oficial ser configurada.

## API

- `GET /api/health`: estado da conexão com o banco e da configuração de autenticação.
- `/api/auth`: login e encerramento de sessão.
- `/api/items`, `/api/alerts`, `/api/offers/{id}` e `/api/scan`: API usada pela interface, protegida por sessão.
- `POST /api/cron`: varredura agendada, aceita somente `Authorization: Bearer <CRON_SECRET>`.

## Modo local

O backend local continua sem dependências Python externas:

- Windows: execute `INICIAR_WINDOWS.bat`.
- Linux/macOS: `python3 server.py`.
- Abra `http://127.0.0.1:8765`.

No modo local, notificações e feeds são configurados em `config.json` (parta de `config.example.json`). O banco fica em `data/monitor.db`. Esse banco SQLite é local e independente do Neon usado em produção.
