#!/usr/bin/env python3
"""Monitor de Promoções 2.0 - backend local, sem dependências externas."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from email.message import EmailMessage
import smtplib, sqlite3, json, os, threading, time, uuid, re, html, xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
DB = BASE / 'data' / 'monitor.db'
DB.parent.mkdir(exist_ok=True)
CONFIG = BASE / 'config.json'
DEFAULT_CONFIG = {
  'host':'127.0.0.1','port':8765,'scan_interval_seconds':60,
  'telegram_bot_token':'','telegram_chat_id':'',
  'smtp_host':'','smtp_port':587,'smtp_user':'','smtp_password':'','smtp_from':'','smtp_starttls':True,
  'whatsapp_token':'','whatsapp_phone_number_id':'','whatsapp_api_version':'v23.0',
  'amazon_paapi_access_key':'','amazon_paapi_secret_key':'','amazon_paapi_partner_tag':'','amazon_paapi_marketplace':'www.amazon.com.br',
  'rss_feeds':[]
}

def load_config():
    if not CONFIG.exists(): CONFIG.write_text(json.dumps(DEFAULT_CONFIG, indent=2, ensure_ascii=False), encoding='utf-8')
    try:
        c=json.loads(CONFIG.read_text(encoding='utf-8'))
        return {**DEFAULT_CONFIG, **c}
    except Exception: return DEFAULT_CONFIG.copy()
config=load_config()

def db():
    c=sqlite3.connect(DB, timeout=15); c.row_factory=sqlite3.Row
    c.execute('''CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,name TEXT NOT NULL,category TEXT DEFAULT 'Outro',target_price REAL, min_discount REAL, sources TEXT NOT NULL, channels TEXT NOT NULL, destination TEXT DEFAULT '', frequency TEXT DEFAULT 'A cada hora', active INTEGER DEFAULT 1, created_at TEXT, next_check REAL DEFAULT 0, last_checked TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS offers(id INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT,name TEXT,store TEXT,kind TEXT,currency TEXT,original_price REAL,price REAL,discount REAL,url TEXT,checked_at TEXT,UNIQUE(item_id,store,url,price))''')
    c.execute('''CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT,name TEXT,store TEXT,kind TEXT,currency TEXT,original_price REAL,price REAL,discount REAL,url TEXT,created_at TEXT,notified TEXT DEFAULT '')''')
    c.commit(); return c

def now(): return datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
def http_json(url, headers=None, timeout=15):
    req=Request(url,headers={'User-Agent':'PromoMonitor/2.0 (personal price tracker)','Accept':'application/json',**(headers or {})})
    with urlopen(req,timeout=timeout) as r: return json.loads(r.read().decode('utf-8','replace'))
def clean_url(u):
    if not isinstance(u,str) or not u.startswith(('https://','http://')): return ''
    return u[:2000]
def frequency_seconds(v):
    return {'A cada 15 min':900,'A cada hora':3600,'A cada 6 horas':21600,'Uma vez por dia':86400}.get(v,3600)

def steam_search(term):
    out=[]
    data=http_json('https://store.steampowered.com/api/storesearch/?term='+__import__('urllib.parse').parse.quote(term)+'&cc=br&l=brazilian')
    for app in data.get('items',[])[:8]:
        appid=app.get('id')
        if not appid: continue
        try:
            d=http_json(f'https://store.steampowered.com/api/appdetails?appids={appid}&cc=br&l=brazilian')
            entry=d.get(str(appid),{}).get('data',{})
            if not entry or not entry.get('price_overview'): continue
            p=entry['price_overview']; cents=p.get('final',0); orig=p.get('initial',cents)
            out.append({'name':entry.get('name',app.get('name',term)),'store':'Steam','kind':'Loja oficial','currency':'BRL','price':cents/100,'original_price':orig/100,'discount':float(p.get('discount_percent',0)),'url':clean_url(entry.get('store_url') or f'https://store.steampowered.com/app/{appid}/')})
        except Exception: continue
    return out

def cheapshark_search(term):
    out=[]
    data=http_json('https://www.cheapshark.com/api/1.0/deals?title='+__import__('urllib.parse').parse.quote(term)+'&pageSize=10&sortBy=Price')
    for d in data if isinstance(data,list) else []:
        try:
            out.append({'name':d.get('title',term),'store':'CheapShark / '+str(d.get('storeID','loja')),'kind':'Revendedor','currency':'USD','price':float(d.get('salePrice',0)),'original_price':float(d.get('normalPrice',0)),'discount':float(d.get('savings',0)),'url':clean_url('https://www.cheapshark.com/redirect?dealID='+str(d.get('dealID','')))})
        except Exception: pass
    return out

def rss_search(term, feeds):
    out=[]
    for feed in feeds:
        url=clean_url(feed.get('url',''))
        if not url: continue
        try:
            req=Request(url,headers={'User-Agent':'PromoMonitor/2.0 RSS reader'})
            root=ET.fromstring(urlopen(req,timeout=12).read())
            for node in root.findall('.//item'):
                title=node.findtext('title') or ''
                if term.casefold() not in title.casefold(): continue
                link=node.findtext('link') or ''
                desc=html.unescape(re.sub('<[^>]+>',' ',node.findtext('description') or ''))
                # RSS sem preço estruturado não é convertido em oferta/preço inventado.
                price_match=re.search(r'(?:R\$|BRL)\s*([\d.,]+)',title+' '+desc,re.I)
                if not price_match: continue
                raw=price_match.group(1).replace('.','').replace(',','.')
                try: price=float(raw)
                except ValueError: continue
                out.append({'name':title[:180],'store':feed.get('name','RSS'),'kind':'RSS','currency':'BRL','price':price,'original_price':price,'discount':0,'url':clean_url(link)})
        except Exception as e: print('RSS:',url,str(e)[:180])
    return out

def search_sources(item):
    found=[]; errors=[]
    sources=json.loads(item['sources'])
    for source in sources:
        try:
            if source=='Steam': found += steam_search(item['name'])
            elif source=='CheapShark': found += cheapshark_search(item['name'])
            elif source=='RSS': found += rss_search(item['name'],config.get('rss_feeds',[]))
            else: errors.append(source+': integração não configurada (use RSS ou API oficial).')
        except Exception as e: errors.append(source+': '+str(e)[:180])
    return found,errors

def qualifies(item, offer):
    # Só compara valores na mesma moeda; não mistura USD com BRL.
    price_ok=item['target_price'] is not None and offer['currency']=='BRL' and offer['price'] <= item['target_price']
    discount_ok=item['min_discount'] is not None and offer['discount'] >= item['min_discount']
    return (price_ok or discount_ok) if (item['target_price'] is not None or item['min_discount'] is not None) else False

VALID_FREQUENCIES = {'A cada 15 min', 'A cada hora', 'A cada 6 horas', 'Uma vez por dia'}
VALID_SOURCES = {'Steam', 'CheapShark', 'RSS', 'Epic Games', 'GOG', 'Nuuvem', 'Amazon'}
VALID_CHANNELS = {'E-mail', 'Telegram', 'WhatsApp'}

def notify(item, offer):
    channels=json.loads(item['channels']); results=[]
    try: destinations=json.loads(item.get('destination') or '{}')
    except Exception: destinations={}
    if not isinstance(destinations,dict): destinations={}
    message=(f"Promoção encontrada: {offer['name']}\nLoja: {offer['store']}\nPreço: {offer['currency']} {offer['price']:.2f}\nDesconto: {offer['discount']:.0f}%\n{offer['url']}")
    if 'Telegram' in channels:
        token=config.get('telegram_bot_token'); chat=destinations.get('Telegram') or config.get('telegram_chat_id')
        if token and chat:
            try:
                body=json.dumps({'chat_id':chat,'text':message}).encode(); req=Request(f'https://api.telegram.org/bot{token}/sendMessage',data=body,headers={'Content-Type':'application/json'})
                urlopen(req,timeout=15).read(); results.append('Telegram')
            except Exception as e: print('Telegram:',e)
    if 'E-mail' in channels:
        to=destinations.get('E-mail','')
        if config.get('smtp_host') and to and '@' in to:
            try:
                msg=EmailMessage(); msg['Subject']='Promoção encontrada: '+offer['name']; msg['From']=config.get('smtp_from') or config.get('smtp_user'); msg['To']=to; msg.set_content(message)
                with smtplib.SMTP(config['smtp_host'],int(config.get('smtp_port',587)),timeout=20) as s:
                    if config.get('smtp_starttls',True): s.starttls()
                    if config.get('smtp_user'): s.login(config['smtp_user'],config.get('smtp_password',''))
                    s.send_message(msg)
                results.append('E-mail')
            except Exception as e: print('SMTP:',e)
    if 'WhatsApp' in channels:
        token=config.get('whatsapp_token'); pid=config.get('whatsapp_phone_number_id'); to=destinations.get('WhatsApp','')
        if token and pid and to:
            try:
                body=json.dumps({'messaging_product':'whatsapp','to':to,'type':'text','text':{'body':message}}).encode()
                req=Request(f"https://graph.facebook.com/{config.get('whatsapp_api_version','v23.0')}/{pid}/messages",data=body,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
                urlopen(req,timeout=20).read(); results.append('WhatsApp')
            except Exception as e: print('WhatsApp:',e)
    return ','.join(results)

def scan_item(item):
    offers,errors=search_sources(item); c=db(); added=0; triggered=0
    for o in offers:
        if not o['url'] or o['price']<0: continue
        # Só dispara alertas quando a regra configurada é satisfeita.
        cur=c.execute('INSERT OR IGNORE INTO offers(item_id,name,store,kind,currency,original_price,price,discount,url,checked_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          (item['id'],o['name'],o['store'],o['kind'],o['currency'],o['original_price'],o['price'],o['discount'],o['url'],now()))
        if cur.rowcount == 1: added+=1
        if qualifies(item,o):
            exists=c.execute('SELECT id FROM alerts WHERE item_id=? AND url=? AND price=? AND created_at>?',(item['id'],o['url'],o['price'],datetime.now().astimezone().replace(hour=0,minute=0,second=0,microsecond=0).isoformat())).fetchone()
            if not exists:
                c.execute('INSERT INTO alerts(item_id,name,store,kind,currency,original_price,price,discount,url,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',(item['id'],o['name'],o['store'],o['kind'],o['currency'],o['original_price'],o['price'],o['discount'],o['url'],now()))
                c.commit(); notified=notify(item,o); c.execute('UPDATE alerts SET notified=? WHERE id=last_insert_rowid()',(notified,)); triggered+=1
    c.execute('UPDATE items SET last_checked=?,next_check=? WHERE id=?',(now(),time.time()+frequency_seconds(item['frequency']),item['id'])); c.commit(); c.close()
    return {'offers_found':len(offers),'alerts_created':triggered,'errors':errors}

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*a,**kw): super().__init__(*a,directory=str(BASE/'web'),**kw)
    def log_message(self,fmt,*args): print('[HTTP]',fmt%args)
    def send_json(self,obj,status=200):
        b=json.dumps(obj,ensure_ascii=False).encode(); self.send_response(status); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Content-Length',str(len(b))); self.send_header('Cache-Control','no-store'); self.end_headers(); self.wfile.write(b)
    def body(self):
        n=int(self.headers.get('Content-Length',0)); return json.loads(self.rfile.read(n) or b'{}')
    def do_GET(self):
        p=urlparse(self.path); c=db()
        if p.path=='/api/items':
            rows=[dict(x) for x in c.execute('SELECT * FROM items ORDER BY created_at DESC')]
            for x in rows: x['sources']=json.loads(x['sources']); x['channels']=json.loads(x['channels'])
            self.send_json(rows)
        elif p.path=='/api/alerts': self.send_json([dict(x) for x in c.execute('SELECT * FROM alerts ORDER BY id DESC LIMIT 300')])
        elif p.path.startswith('/api/offers/'):
            iid=p.path.rsplit('/',1)[-1]; self.send_json([dict(x) for x in c.execute('SELECT * FROM offers WHERE item_id=? ORDER BY checked_at DESC LIMIT 300',(iid,))])
        elif p.path=='/api/config':
            safe={k:('••••••••' if v else '') if any(z in k for z in ['password','token','secret','access_key']) else v for k,v in config.items()}
            self.send_json(safe)
        elif p.path=='/api/health': self.send_json({'ok':True,'database':str(DB.name),'time':now()})
        else: super().do_GET()
        c.close()
    def do_POST(self):
        p=urlparse(self.path)
        try: data=self.body()
        except Exception: return self.send_json({'error':'JSON inválido'},400)
        c=db()
        if p.path=='/api/items':
            name=str(data.get('name','')).strip(); sources=data.get('sources',[]); channels=data.get('channels',[])
            target=data.get('target_price'); discount=data.get('min_discount')
            frequency=str(data.get('frequency','A cada hora')); destinations=data.get('destinations',{})
            if (not name or not isinstance(sources,list) or not sources or any(not isinstance(s,str) or s not in VALID_SOURCES for s in sources)
                or not isinstance(channels,list) or not channels or any(not isinstance(ch,str) or ch not in VALID_CHANNELS for ch in channels)
                or not isinstance(destinations,dict) or (target in (None,'') and discount in (None,''))):
                c.close(); return self.send_json({'error':'Informe nome, regra de preço/desconto, fontes e canais válidos.'},400)
            if frequency not in VALID_FREQUENCIES:
                c.close(); return self.send_json({'error':'Frequência inválida.'},400)
            try:
                target=float(target) if target not in (None,'') else None; discount=float(discount) if discount not in (None,'') else None
                if target is not None and target<=0 or discount is not None and not 0<=discount<=100: raise ValueError()
            except Exception:
                c.close(); return self.send_json({'error':'Preço deve ser positivo e desconto entre 0 e 100.'},400)
            iid=str(uuid.uuid4()); c.execute('INSERT INTO items(id,name,category,target_price,min_discount,sources,channels,destination,frequency,active,created_at,next_check) VALUES(?,?,?,?,?,?,?,?,?,1,?,0)',(iid,name,str(data.get('category','Outro')),target,discount,json.dumps(sources),json.dumps(channels),json.dumps(destinations),frequency,now())); c.commit(); c.close(); return self.send_json({'id':iid,'saved':True},201)
        elif p.path=='/api/scan':
            rows=[dict(x) for x in c.execute('SELECT * FROM items WHERE active=1')]; c.close(); results=[]
            for item in rows: results.append({'item':item['name'],**scan_item(item)})
            return self.send_json({'results':results})
        elif p.path=='/api/config':
            global config
            for k in DEFAULT_CONFIG:
                if k in data and data[k] != '••••••••': config[k]=data[k]
            CONFIG.write_text(json.dumps(config,indent=2,ensure_ascii=False),encoding='utf-8'); c.close(); return self.send_json({'saved':True})
        else: c.close(); return self.send_json({'error':'Rota não encontrada'},404)
    def do_PATCH(self):
        p=urlparse(self.path); iid=p.path.rsplit('/',1)[-1]
        try: d=self.body()
        except Exception: return self.send_json({'error':'JSON inválido'},400)
        c=db()
        if 'active' in d: c.execute('UPDATE items SET active=? WHERE id=?',(1 if d['active'] else 0,iid))
        if 'frequency' in d:
            if d['frequency'] not in VALID_FREQUENCIES:
                c.close(); return self.send_json({'error':'Frequência inválida.'},400)
            c.execute('UPDATE items SET frequency=? WHERE id=?',(d['frequency'],iid))
        c.commit(); c.close(); self.send_json({'updated':True})
    def do_DELETE(self):
        iid=urlparse(self.path).path.rsplit('/',1)[-1]; c=db(); c.execute('DELETE FROM alerts WHERE item_id=?',(iid,)); c.execute('DELETE FROM offers WHERE item_id=?',(iid,)); c.execute('DELETE FROM items WHERE id=?',(iid,)); c.commit(); c.close(); self.send_json({'deleted':True})


def scheduler():
    while True:
        try:
            c=db(); rows=[dict(x) for x in c.execute('SELECT * FROM items WHERE active=1 AND next_check<=?',(time.time(),))]; c.close()
            for item in rows:
                try: print('[SCAN]',item['name'],scan_item(item))
                except Exception as e: print('[SCAN ERROR]',item['name'],e)
        except Exception as e: print('[SCHEDULER]',e)
        time.sleep(max(20,int(config.get('scan_interval_seconds',60))))

if __name__=='__main__':
    db().close(); threading.Thread(target=scheduler,daemon=True).start()
    host=config.get('host','127.0.0.1'); port=int(config.get('port',8765))
    print(f'Monitor de Promoções 2.0 em http://{host}:{port}')
    ThreadingHTTPServer((host,port),Handler).serve_forever()
