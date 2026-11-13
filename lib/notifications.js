import nodemailer from 'nodemailer';

export async function notify(item, offer) {
  const channels = Array.isArray(item.channels) ? item.channels : [];
  const destinations = item.destination && typeof item.destination === 'object' ? item.destination : {};
  const pending = [];
  const message = `Promoção encontrada: ${offer.name}\nLoja: ${offer.store}\nPreço: ${offer.currency} ${Number(offer.price).toFixed(2)}\nDesconto: ${Number(offer.discount).toFixed(0)}%\n${offer.url}`;

  if (channels.includes('Telegram')) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = destinations.Telegram || process.env.TELEGRAM_CHAT_ID;
    if (token && chat) {
      pending.push((async () => { try {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text: message }), signal: AbortSignal.timeout(12000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return 'Telegram';
      } catch (error) { console.error('Telegram notification failed:', String(error?.message || '').slice(0, 120)); return ''; } })());
    }
  }

  if (channels.includes('E-mail')) {
    const to = destinations['E-mail'];
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.SMTP_FROM && to && String(to).includes('@')) {
      pending.push((async () => { try {
        const smtpPort = Number(process.env.SMTP_PORT || 587);
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST, port: smtpPort,
          secure: smtpPort === 465,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
          requireTLS: smtpPort !== 465 && String(process.env.SMTP_STARTTLS ?? 'true').toLowerCase() === 'true',
          connectionTimeout: 10000, socketTimeout: 15000
        });
        await transporter.sendMail({ from: process.env.SMTP_FROM, to, subject: `Promoção encontrada: ${offer.name}`, text: message });
        return 'E-mail';
      } catch (error) { console.error('SMTP notification failed:', String(error?.message || '').slice(0, 120)); return ''; } })());
    }
  }

  if (channels.includes('WhatsApp')) {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const to = destinations.WhatsApp;
    const version = /^v\d+\.\d+$/.test(process.env.WHATSAPP_API_VERSION || '') ? process.env.WHATSAPP_API_VERSION : 'v23.0';
    if (token && phoneId && /^\d{8,20}$/.test(String(to || ''))) {
      pending.push((async () => { try {
        const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneId)}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } }),
          signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return 'WhatsApp';
      } catch (error) { console.error('WhatsApp notification failed:', String(error?.message || '').slice(0, 120)); return ''; } })());
    }
  }
  return (await Promise.all(pending)).filter(Boolean).join(',');
}
