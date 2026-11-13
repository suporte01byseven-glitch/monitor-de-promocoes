import { createHash, randomUUID } from 'node:crypto';
import { pingDatabase, query } from '../lib/db.js';
import { authConfigurationReady, clearSessionCookie, isAuthenticated, makeSessionCookie, sameOrigin, validCronRequest, verifyPassword } from '../lib/security.js';
import { searchSources } from '../lib/sources.js';
import { notify } from '../lib/notifications.js';

const VALID_FREQUENCIES = new Set(['A cada 15 min', 'A cada hora', 'A cada 6 horas', 'Uma vez por dia']);
const FREQUENCY_SECONDS = { 'A cada 15 min': 900, 'A cada hora': 3600, 'A cada 6 horas': 21600, 'Uma vez por dia': 86400 };
const VALID_SOURCES = new Set(['Steam', 'CheapShark', 'RSS', 'Epic Games', 'GOG', 'Nuuvem', 'Amazon']);
const VALID_CHANNELS = new Set(['E-mail', 'Telegram', 'WhatsApp']);

function respond(res, status, data, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
      return Array.isArray(req.body) ? {} : req.body;
    }
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const error = new Error('Corpo da solicitação excede 1 MB.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function numericOrNull(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw Object.assign(new Error(`${label} inválido.`), { statusCode: 400 });
  return number;
}

function priceQualifies(item, offer) {
  const target = item.target_price !== null && item.target_price !== undefined;
  const discount = item.min_discount !== null && item.min_discount !== undefined;
  const priceOk = target && offer.currency === 'BRL' && Number(offer.price) <= Number(item.target_price);
  const discountOk = discount && Number(offer.discount) >= Number(item.min_discount);
  return (priceOk || discountOk) && (target || discount);
}

async function scanItem(item) {
  const { offers, errors } = await searchSources(item);
  let added = 0;
  let triggered = 0;
  for (const offer of offers) {
    if (!offer.url || !Number.isFinite(Number(offer.price)) || Number(offer.price) < 0) continue;
    const normalizedPrice = Number(offer.price);
    const offerKey = createHash('sha256').update(JSON.stringify([item.id, offer.store, offer.url, normalizedPrice])).digest('hex');
    const inserted = await query(`INSERT INTO offers(dedupe_key,item_id,name,store,kind,currency,original_price,price,discount,url)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
    [offerKey, item.id, offer.name, offer.store, offer.kind, offer.currency, Number(offer.original_price), normalizedPrice, Number(offer.discount) || 0, offer.url]);
    if (inserted.length) added += 1;
    if (!priceQualifies(item, offer)) continue;
    const day = new Date().toISOString().slice(0, 10);
    const alertKey = createHash('sha256').update(JSON.stringify([item.id, offer.url, normalizedPrice, day])).digest('hex');
    const alertRows = await query(`INSERT INTO alerts(dedupe_key,item_id,name,store,kind,currency,original_price,price,discount,url)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(dedupe_key) DO NOTHING
      RETURNING id`,
    [alertKey, item.id, offer.name, offer.store, offer.kind, offer.currency, Number(offer.original_price), normalizedPrice, Number(offer.discount) || 0, offer.url]);
    if (!alertRows.length) continue;
    const notified = await notify(item, offer);
    await query('UPDATE alerts SET notified=$1 WHERE id=$2', [notified, alertRows[0].id]);
    triggered += 1;
  }
  const seconds = FREQUENCY_SECONDS[item.frequency] || 3600;
  await query('UPDATE items SET last_checked=NOW(), next_check=NOW()+($1 * INTERVAL \'1 second\') WHERE id=$2', [seconds, item.id]);
  return { offers_found: offers.length, offers_added: added, alerts_created: triggered, errors };
}

async function authenticate(req, res, method, body) {
  if (method === 'GET') return respond(res, 200, { configured: authConfigurationReady(), authenticated: isAuthenticated(req) });
  if (!sameOrigin(req)) return respond(res, 403, { error: 'Origem da solicitação inválida.' });
  if (!authConfigurationReady()) return respond(res, 503, { error: 'Configure APP_PASSWORD e SESSION_SECRET nas variáveis de ambiente.' });
  if (method === 'POST') {
    if (!verifyPassword(String(body.password || ''))) return respond(res, 401, { error: 'Senha incorreta.' });
    return respond(res, 200, { authenticated: true }, { 'Set-Cookie': makeSessionCookie() });
  }
  if (method === 'DELETE') return respond(res, 200, { authenticated: false }, { 'Set-Cookie': clearSessionCookie() });
  return respond(res, 405, { error: 'Método não permitido.' }, { Allow: 'GET, POST, DELETE' });
}

async function createItem(body) {
  const name = String(body.name || '').trim().slice(0, 180);
  const sources = body.sources;
  const channels = body.channels;
  const destinations = body.destinations || {};
  if (!name || !Array.isArray(sources) || !sources.length || sources.some(source => !VALID_SOURCES.has(source)) ||
      !Array.isArray(channels) || !channels.length || channels.some(channel => !VALID_CHANNELS.has(channel)) ||
      !destinations || typeof destinations !== 'object' || Array.isArray(destinations)) {
    throw Object.assign(new Error('Informe nome, fontes e canais válidos.'), { statusCode: 400 });
  }
  const target = numericOrNull(body.target_price, 'Preço-alvo');
  const discount = numericOrNull(body.min_discount, 'Desconto mínimo');
  if ((target === null && discount === null) || (target !== null && target <= 0) || (discount !== null && (discount < 0 || discount > 100))) {
    throw Object.assign(new Error('Informe um preço positivo ou um desconto entre 0 e 100.'), { statusCode: 400 });
  }
  const frequency = String(body.frequency || 'A cada hora');
  if (!VALID_FREQUENCIES.has(frequency)) throw Object.assign(new Error('Frequência inválida.'), { statusCode: 400 });
  const cleanDestinations = {};
  for (const key of VALID_CHANNELS) {
    if (typeof destinations[key] === 'string') cleanDestinations[key] = destinations[key].trim().slice(0, 320);
  }
  const id = randomUUID();
  await query(`INSERT INTO items(id,name,category,target_price,min_discount,sources,channels,destination,frequency)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9)`,
  [id, name, String(body.category || 'Outro').slice(0, 40), target, discount, JSON.stringify([...new Set(sources)]), JSON.stringify([...new Set(channels)]), JSON.stringify(cleanDestinations), frequency]);
  return { id, saved: true };
}

async function patchItem(id, body) {
  const updates = [];
  const values = [];
  if (Object.hasOwn(body, 'active')) {
    values.push(Boolean(body.active));
    updates.push(`active=$${values.length}`);
    if (body.active) updates.push('next_check=NOW()');
  }
  if (Object.hasOwn(body, 'frequency')) {
    if (!VALID_FREQUENCIES.has(body.frequency)) throw Object.assign(new Error('Frequência inválida.'), { statusCode: 400 });
    values.push(body.frequency);
    updates.push(`frequency=$${values.length}`);
    updates.push('next_check=NOW()');
  }
  if (!updates.length) throw Object.assign(new Error('Nenhum campo válido para atualizar.'), { statusCode: 400 });
  values.push(id);
  const rows = await query(`UPDATE items SET ${updates.join(', ')} WHERE id=$${values.length} RETURNING id`, values);
  if (!rows.length) throw Object.assign(new Error('Monitoramento não encontrado.'), { statusCode: 404 });
  return { updated: true };
}

async function deleteItem(id) {
  const rows = await query('DELETE FROM items WHERE id=$1 RETURNING id', [id]);
  if (!rows.length) throw Object.assign(new Error('Monitoramento não encontrado.'), { statusCode: 404 });
  return { deleted: true };
}

async function dispatch(req, res, route, url) {
  const method = req.method || 'GET';
  if (route === 'health') {
    try {
      await pingDatabase();
      return respond(res, 200, { ok: true, database: 'connected', authentication: authConfigurationReady(), time: new Date().toISOString() });
    } catch {
      return respond(res, 503, { ok: false, database: 'unavailable', authentication: authConfigurationReady() });
    }
  }

  if (route === 'auth') {
    let body = {};
    if (method !== 'GET') {
      try { body = await readBody(req); } catch { return respond(res, 400, { error: 'JSON inválido.' }); }
    }
    return authenticate(req, res, method, body);
  }

  if (route === 'cron') {
    if (method !== 'POST') return respond(res, 405, { error: 'Método não permitido.' }, { Allow: 'POST' });
    if (!validCronRequest(req)) return respond(res, 401, { error: 'Credencial de agendamento inválida.' });
    const due = await query('SELECT * FROM items WHERE active=TRUE AND next_check<=NOW() ORDER BY next_check ASC LIMIT 3');
    const results = await Promise.all(due.map(async item => ({ item: item.name, ...await scanItem(item) })));
    return respond(res, 200, { scanned: results.length, results });
  }

  const safeMethods = new Set(['GET', 'HEAD']);
  if (!safeMethods.has(method) && !sameOrigin(req)) return respond(res, 403, { error: 'Origem da solicitação inválida.' });
  if (!authConfigurationReady()) return respond(res, 503, { error: 'Autenticação ainda não foi configurada.' });
  if (!isAuthenticated(req)) return respond(res, 401, { error: 'Entre para acessar seus monitoramentos.' });

  if (route === 'items' && method === 'GET') {
    const rows = await query('SELECT * FROM items ORDER BY created_at DESC');
    return respond(res, 200, rows);
  }
  if (route === 'items' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return respond(res, 400, { error: 'JSON inválido.' }); }
    return respond(res, 201, await createItem(body));
  }
  const itemMatch = route.match(/^items\/([\w-]+)$/);
  if (itemMatch && method === 'PATCH') {
    let body;
    try { body = await readBody(req); } catch { return respond(res, 400, { error: 'JSON inválido.' }); }
    return respond(res, 200, await patchItem(itemMatch[1], body));
  }
  if (itemMatch && method === 'DELETE') return respond(res, 200, await deleteItem(itemMatch[1]));
  const offersMatch = route.match(/^offers\/([\w-]+)$/);
  if (offersMatch && method === 'GET') {
    const rows = await query('SELECT * FROM offers WHERE item_id=$1 ORDER BY checked_at DESC LIMIT 300', [offersMatch[1]]);
    return respond(res, 200, rows);
  }
  if (route === 'alerts' && method === 'GET') {
    const rows = await query('SELECT * FROM alerts ORDER BY id DESC LIMIT 300');
    return respond(res, 200, rows);
  }
  if (route === 'config' && method === 'GET') {
    return respond(res, 200, {
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      email: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.SMTP_FROM),
      whatsapp: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
    });
  }
  if (route === 'scan' && method === 'POST') {
    const active = await query('SELECT * FROM items WHERE active=TRUE ORDER BY created_at DESC LIMIT 10');
    const results = await Promise.all(active.map(async item => ({ item: item.name, ...await scanItem(item) })));
    return respond(res, 200, { results, truncated: active.length === 10 });
  }
  return respond(res, 404, { error: 'Rota não encontrada.' });
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  try {
    const url = new URL(req.url, 'https://vercel.invalid');
    const rawPath = url.searchParams.get('path') || url.pathname.replace(/^\/api\//, '');
    const route = decodeURIComponent(rawPath).replace(/^\/+|\/+$/g, '');
    return await dispatch(req, res, route, url);
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error('API request failed:', String(error?.message || 'Unknown error').slice(0, 180));
    const message = status === 500 ? 'Falha interna no serviço.' : String(error.message || 'Solicitação inválida.');
    return respond(res, status, { error: message });
  }
}
