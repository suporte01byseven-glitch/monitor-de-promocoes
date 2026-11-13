const USER_AGENT = 'PromoMonitor/3.0 (personal price tracker)';

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal') return '';
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return '';
    const ipv4 = host.match(/^172\.(\d+)\./);
    if (ipv4 && Number(ipv4[1]) >= 16 && Number(ipv4[1]) <= 31) return '';
    if (host === '::' || host === '::1' || host.startsWith('::ffff:') || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return '';
    return url.toString().slice(0, 2000);
  } catch { return ''; }
}

async function fetchText(url, timeout = 12000, redirects = 0) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json, application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(timeout),
    redirect: 'manual'
  });
  if (response.status >= 300 && response.status < 400) {
    if (redirects >= 3) throw new Error('A fonte excedeu o limite de redirecionamentos.');
    const location = response.headers.get('location');
    if (!location) throw new Error('A fonte retornou um redirecionamento inválido.');
    const target = safeUrl(new URL(location, url).toString());
    if (!target) throw new Error('A fonte tentou redirecionar para um endereço não permitido.');
    return fetchText(target, timeout, redirects + 1);
  }
  if (!response.ok) throw new Error(`Fonte respondeu HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('Resposta da fonte excede o limite de 2 MB.');
  return text;
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function steamSearch(term) {
  const search = await fetchJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=br&l=brazilian`);
  const apps = (search.items || []).filter(app => app.id).slice(0, 5);
  const details = await Promise.all(apps.map(async app => {
    try {
      const data = await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(app.id)}&cc=br&l=brazilian`);
      const entry = data[String(app.id)]?.data;
      const price = entry?.price_overview;
      if (!entry || !price) return null;
      return {
        name: entry.name || app.name || term,
        store: 'Steam', kind: 'Loja oficial', currency: 'BRL',
        price: Number(price.final) / 100,
        original_price: Number(price.initial ?? price.final) / 100,
        discount: Number(price.discount_percent || 0),
        url: safeUrl(entry.store_url || `https://store.steampowered.com/app/${app.id}/`)
      };
    } catch { return null; }
  }));
  return details.filter(Boolean);
}

async function cheapsharkSearch(term) {
  const data = await fetchJson(`https://www.cheapshark.com/api/1.0/deals?title=${encodeURIComponent(term)}&pageSize=10&sortBy=Price`);
  return (Array.isArray(data) ? data : []).map(deal => ({
    name: deal.title || term,
    store: `CheapShark / ${String(deal.storeID || 'loja')}`,
    kind: 'Revendedor', currency: 'USD',
    price: Number(deal.salePrice || 0), original_price: Number(deal.normalPrice || 0),
    discount: Number(deal.savings || 0),
    url: safeUrl(`https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(deal.dealID || '')}`)
  })).filter(deal => deal.url && Number.isFinite(deal.price));
}

function decodeXml(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function xmlTag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

async function rssSearch(term) {
  let feeds = [];
  try { feeds = JSON.parse(process.env.RSS_FEEDS || '[]'); } catch { throw new Error('RSS_FEEDS precisa conter um JSON array válido.'); }
  if (!Array.isArray(feeds)) throw new Error('RSS_FEEDS precisa ser um JSON array.');
  const selectedFeeds = feeds.slice(0, 5);
  const results = await Promise.all(selectedFeeds.map(async feed => {
    const url = safeUrl(feed?.url);
    if (!url) return [];
    try {
      const xml = await fetchText(url, 10000);
      const feedOffers = [];
      for (const block of xml.match(/<item\b[\s\S]*?<\/item\s*>/gi) || []) {
        const title = xmlTag(block, 'title');
        if (!title.toLocaleLowerCase('pt-BR').includes(term.toLocaleLowerCase('pt-BR'))) continue;
        const description = xmlTag(block, 'description');
        const priceMatch = `${title} ${description}`.match(/(?:R\$|BRL)\s*([\d.]+(?:,\d{1,2})?|\d+(?:\.\d{1,2})?)/i);
        if (!priceMatch) continue;
        const raw = priceMatch[1];
        const price = Number(raw.includes(',')
          ? raw.replace(/\./g, '').replace(',', '.')
          : (/^\d{1,3}(?:\.\d{3})+$/.test(raw) ? raw.replace(/\./g, '') : raw));
        const offerUrl = safeUrl(xmlTag(block, 'link'));
        if (!offerUrl || !Number.isFinite(price) || price < 0) continue;
        feedOffers.push({ name: title.slice(0, 180), store: String(feed.name || 'RSS').slice(0, 80), kind: 'RSS', currency: 'BRL', price, original_price: price, discount: 0, url: offerUrl });
      }
      return feedOffers;
    } catch (error) {
      console.error('RSS feed failed:', String(error?.message || 'request error').slice(0, 120));
      return [];
    }
  }));
  return results.flat();
}

export async function searchSources(item) {
  const offers = [];
  const errors = [];
  for (const source of item.sources || []) {
    try {
      if (source === 'Steam') offers.push(...await steamSearch(item.name));
      else if (source === 'CheapShark') offers.push(...await cheapsharkSearch(item.name));
      else if (source === 'RSS') offers.push(...await rssSearch(item.name));
      else errors.push(`${source}: integração não configurada (use RSS ou uma API oficial).`);
    } catch (error) {
      errors.push(`${source}: ${String(error?.message || 'falha na consulta').slice(0, 180)}`);
    }
  }
  return { offers, errors };
}

export { safeUrl };
