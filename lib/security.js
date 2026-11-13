import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'promo_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;

function same(a, b) {
  const left = createHash('sha256').update(String(a)).digest();
  const right = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(left, right);
}

export function authConfigurationReady() {
  return Boolean(process.env.APP_PASSWORD && process.env.APP_PASSWORD.length >= 16 && process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32);
}

function cookieValue(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  const entry = cookies.map(value => value.trim()).find(value => value.startsWith(`${COOKIE_NAME}=`));
  return entry ? entry.slice(COOKIE_NAME.length + 1) : '';
}

export function isAuthenticated(req) {
  if (!authConfigurationReady()) return false;
  const [expires, signature, extra] = cookieValue(req).split('.');
  if (!expires || !signature || extra || !/^\d+$/.test(expires) || Number(expires) <= Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac('sha256', process.env.SESSION_SECRET).update(expires).digest('base64url');
  return same(signature, expected);
}

export function verifyPassword(password) {
  return authConfigurationReady() && same(password, process.env.APP_PASSWORD);
}

export function makeSessionCookie() {
  const expires = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  const signature = createHmac('sha256', process.env.SESSION_SECRET).update(expires).digest('base64url');
  return `${COOKIE_NAME}=${expires}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

export function validCronRequest(req) {
  const secret = process.env.CRON_SECRET;
  const authorization = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(secret && secret.length >= 32 && same(secret, authorization));
}
