import { neon } from '@neondatabase/serverless';

let client;
let schemaReady;

function getClient() {
  if (!process.env.DATABASE_URL) {
    const error = new Error('Banco de dados não configurado. Conecte o Neon e defina DATABASE_URL na Vercel.');
    error.statusCode = 503;
    throw error;
  }
  if (!client) client = neon(process.env.DATABASE_URL);
  return client;
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getClient();
      await sql.query(`CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Outro',
        target_price NUMERIC,
        min_discount NUMERIC,
        sources JSONB NOT NULL,
        channels JSONB NOT NULL,
        destination JSONB NOT NULL DEFAULT '{}'::jsonb,
        frequency TEXT NOT NULL DEFAULT 'A cada hora',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        next_check TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_checked TIMESTAMPTZ
      )`);
      await sql.query(`CREATE TABLE IF NOT EXISTS offers (
        id BIGSERIAL PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        store TEXT NOT NULL,
        kind TEXT NOT NULL,
        currency TEXT NOT NULL,
        original_price NUMERIC NOT NULL,
        price NUMERIC NOT NULL,
        discount NUMERIC NOT NULL DEFAULT 0,
        url TEXT NOT NULL,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await sql.query(`CREATE TABLE IF NOT EXISTS alerts (
        id BIGSERIAL PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        store TEXT NOT NULL,
        kind TEXT NOT NULL,
        currency TEXT NOT NULL,
        original_price NUMERIC NOT NULL,
        price NUMERIC NOT NULL,
        discount NUMERIC NOT NULL DEFAULT 0,
        url TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_day DATE NOT NULL DEFAULT CURRENT_DATE,
        notified TEXT NOT NULL DEFAULT ''
      )`);
      await sql.query('ALTER TABLE alerts ADD COLUMN IF NOT EXISTS created_day DATE');
      await sql.query('UPDATE alerts SET created_day=created_at::date WHERE created_day IS NULL');
      await sql.query('ALTER TABLE alerts ALTER COLUMN created_day SET DEFAULT CURRENT_DATE');
      await sql.query('ALTER TABLE alerts ALTER COLUMN created_day SET NOT NULL');
      await sql.query('CREATE INDEX IF NOT EXISTS items_due_idx ON items(active, next_check)');
      await sql.query('CREATE INDEX IF NOT EXISTS offers_item_checked_idx ON offers(item_id, checked_at DESC)');
      await sql.query('CREATE INDEX IF NOT EXISTS alerts_item_created_idx ON alerts(item_id, created_at DESC)');
    })().catch(error => {
      schemaReady = undefined;
      throw error;
    });
  }
  await schemaReady;
}

export async function query(text, params = []) {
  await ensureSchema();
  return getClient().query(text, params);
}

export async function pingDatabase() {
  await ensureSchema();
  await getClient().query('SELECT 1');
}
