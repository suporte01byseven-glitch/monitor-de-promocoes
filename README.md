# Monitor de Promoções 2.0

Aplicação local com interface web, backend Python, SQLite, agendamento automático, histórico de ofertas, alertas e exportação CSV. Não requer bibliotecas Python de terceiros.

## Requisitos
- Windows 10/11, Linux ou macOS
- Python 3.9 ou superior
- Internet para consultar as fontes e enviar notificações

## Executar no Windows
1. Extraia a pasta do ZIP.
2. Instale Python 3, se necessário: https://www.python.org/downloads/ (marque **Add Python to PATH**).
3. Execute `INICIAR_WINDOWS.bat`.
4. Acesse http://127.0.0.1:8765 no navegador.
5. Mantenha a janela do terminal aberta para o monitoramento automático continuar.

No Linux/macOS: `python3 server.py` e abra `http://127.0.0.1:8765`.

## Fontes implementadas
- **Steam:** pesquisa no catálogo e consulta preço regional BRL pelo serviço público da loja.
- **CheapShark:** pesquisa ofertas de jogos; preços retornados em USD. O limite de preço em R$ não é aplicado a preços em USD, mas a regra de desconto percentual pode ser aplicada.
- **RSS:** feeds RSS configurados em `config.json`. Para ser reconhecido como oferta, o título ou descrição precisa conter um preço explícito no formato `R$ 99,90` ou `BRL 99,90`. Não tenta adivinhar preços.

Epic Games, GOG, Nuuvem e Amazon não são anunciadas como conectadas por padrão: a disponibilidade e os termos de APIs variam. Podem ser integradas por feed RSS compatível ou por adaptador de API oficial. As chaves Amazon PA-API são reservadas no arquivo de configuração, mas o adaptador de assinatura PA-API não está implementado nesta entrega.

## Configurar notificações
Edite `config.json` com um editor de texto e reinicie o servidor:

### Telegram
1. Crie um bot com `@BotFather` e copie o token para `telegram_bot_token`.
2. Informe o chat ID em `telegram_chat_id` ou no campo Destino de cada monitoramento.
3. Inicie uma conversa com o bot antes do primeiro envio.

### E-mail (SMTP)
Preencha `smtp_host`, `smtp_port`, `smtp_user`, `smtp_password` e `smtp_from`. Para provedores que exigem TLS explícito, mantenha `smtp_starttls: true`. Use senha de aplicativo quando o provedor exigir.

### WhatsApp Business Cloud API
Preencha `whatsapp_token`, `whatsapp_phone_number_id` e, se necessário, `whatsapp_api_version`. No campo Destino, informe o telefone no formato internacional, somente dígitos (ex.: 5511999999999). A conta, número, permissões e políticas de templates/janela de atendimento precisam estar configurados na Meta.

### Feeds RSS
Adicione objetos em `rss_feeds`, por exemplo:

```json
"rss_feeds": [
  {"name": "Meu feed de ofertas", "url": "https://exemplo.com/ofertas/rss.xml"}
]
```

Use URLs de feeds que você tem autorização para consultar. A fonte RSS é consultada em cada varredura de itens que selecionaram RSS.

## Funcionamento e regras
- O agendador verifica itens ativos conforme a frequência configurada. A janela de execução do processo precisa permanecer aberta.
- O banco SQLite fica em `data/monitor.db` e persiste itens, histórico e alertas após reinicialização.
- Um alerta é criado quando o preço BRL fica abaixo do preço-alvo **ou** quando o desconto alcança o mínimo configurado.
- A regra percentual é comparada ao desconto informado pela fonte; preços em moedas diferentes não são convertidos automaticamente.
- Alertas repetidos com mesmo item, URL e preço no mesmo dia são deduplicados.
- Os destinos de e-mail, Telegram e WhatsApp são configurados separadamente em cada monitoramento.
- Remover um monitoramento também remove suas ofertas e alertas associados.
- A pesquisa manual não gera dados sintéticos. Se a fonte falhar, o erro aparece no resultado da pesquisa e no terminal.
- O histórico de ofertas é armazenado; alertas podem ser exportados em CSV.

## Segurança e operação
- Por padrão, o servidor escuta apenas em `127.0.0.1`, não expõe a aplicação à rede.
- Não publique o servidor diretamente na internet. Para uso multiusuário, instale atrás de proxy HTTPS, autenticação e controles de acesso.
- Proteja `config.json`: ele contém tokens e senhas em texto simples. Restrinja as permissões do arquivo e não compartilhe a pasta.
- Os conectores externos dependem de disponibilidade, limites, região e termos de uso dos respectivos provedores.
- Para parar o monitor, feche a janela do terminal (Ctrl+C).

## Verificação
Execute `python -m py_compile server.py` para validar a sintaxe. A API de saúde fica em `http://127.0.0.1:8765/api/health`.

## PWA e deploy na Vercel

A interface em `web/` inclui manifesto, ícone e service worker. Em HTTPS (incluindo a Vercel), o navegador pode instalar a aplicação e abrir o app shell offline. As respostas `/api/*` não são guardadas no cache.

Para publicar a interface, importe este diretório como projeto na Vercel e configure `web` como **Output Directory** (sem build command). O `vercel.json` define os cabeçalhos do manifesto e do service worker.

**Limitação do backend:** esta entrega ainda usa `server.py`, um servidor Python persistente com SQLite local. A Vercel não executa esse servidor como processo contínuo e o armazenamento local de funções serverless é efêmero. Portanto, o deploy descrito publica a PWA, mas as funções de monitoramento e API não funcionarão na Vercel por si só. Para produção, é necessário migrar a API para funções serverless e o banco para PostgreSQL gerenciado (por exemplo, Neon ou Vercel Postgres), além de configurar uma execução agendada para as varreduras. Até essa migração, mantenha o backend Python em um serviço persistente e configure um proxy `/api` para ele.

O modo offline disponibiliza apenas os arquivos da interface; consulta de preços, histórico, alertas e notificações exigem conexão com a API.
