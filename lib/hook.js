// Shared secret for calls coming from n8n.
import crypto from 'node:crypto';
export function hookAllowed(req) {
  const want = process.env.PM_HOOK_SECRET || '';
  const got = String(req.headers['x-hook-secret'] || '');
  return want.length >= 16 && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
export const HOOK_ERROR = 'Bad or missing x-hook-secret (set PM_HOOK_SECRET in Vercel, at least 16 characters, and the same value in n8n)';

// Vercel's own scheduler: it sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set in Vercel
export function cronAllowed(req) {
  const want = process.env.CRON_SECRET || '';
  const got = String(req.headers.authorization || '');
  return want.length >= 16 && got === `Bearer ${want}`;
}
