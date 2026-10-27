import type { APIRoute } from 'astro';
import { isAdminRequest, sameOrigin } from '../../../lib/admin-auth';
import { getCloudflareBindings, hasNonEmptySecret } from '../../../lib/cloudflare-env';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Admin-API-Version': 'date-fix-2026-10-25-v3' } });
}

async function getContext(locals: App.Locals) {
  const env = getCloudflareBindings(locals);
  const secret = hasNonEmptySecret(env.ADMIN_PASSWORD) ? env.ADMIN_PASSWORD : undefined;
  const db = env.DB as any;
  return { secret, db };
}

async function authorized(request: Request, secret?: string) {
  return Boolean(secret && await isAdminRequest(request, secret));
}

export const GET: APIRoute = async ({ request, locals }) => {
  const { secret, db } = await getContext(locals);
  if (!(await authorized(request, secret))) return json({ error: 'Authentification requise.' }, 401);
  if (!db) return json({ error: 'Base de données indisponible.' }, 503);
  try {
    const { results } = await db.prepare(`SELECT id, title, description, content_type, source_url, thumbnail_url, published_at, created_at FROM publications ORDER BY published_at DESC, id DESC`).all();
    return json(results);
  } catch {
    return json({ error: 'Impossible de lire les publications.' }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const { secret, db } = await getContext(locals);
  if (!sameOrigin(request)) return json({ error: 'Origine non autorisée.' }, 403);
  if (!(await authorized(request, secret))) return json({ error: 'Authentification requise.' }, 401);
  if (!db) return json({ error: 'Base de données indisponible.' }, 503);

  let item: any;
  try { item = await request.json(); } catch { return json({ error: 'Données invalides.' }, 400); }
  const validation = validate(item);
  if (validation) return json({ error: validation }, 400);

  try {
    const publishedAt = normalizePublishedAt(item.published_at) || currentDatabaseDateTime();
    const result = await db.prepare(`INSERT INTO publications (title, description, content_type, source_url, thumbnail_url, published_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(item.title.trim(), item.description.trim(), item.content_type, item.source_url.trim(), item.thumbnail_url.trim(), publishedAt).run();
    return json({ ok: true, id: result.meta?.last_row_id }, 201);
  } catch {
    return json({ error: 'Impossible d’enregistrer la publication.' }, 500);
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const { secret, db } = await getContext(locals);
  if (!sameOrigin(request)) return json({ error: 'Origine non autorisée.' }, 403);
  if (!(await authorized(request, secret))) return json({ error: 'Authentification requise.' }, 401);
  if (!db) return json({ error: 'Base de données indisponible.' }, 503);

  let item: any;
  try { item = await request.json(); } catch { return json({ error: 'Données invalides.' }, 400); }
  if (!Number.isInteger(item.id) || item.id < 1) return json({ error: 'Identifiant invalide.' }, 400);
  const validation = validate(item);
  if (validation) return json({ error: validation }, 400);

  try {
    const publishedAt = normalizePublishedAt(item.published_at) || currentDatabaseDateTime();
    const result = await db.prepare(`UPDATE publications SET title = ?, description = ?, content_type = ?, source_url = ?, thumbnail_url = ?, published_at = ? WHERE id = ?`)
      .bind(item.title.trim(), item.description.trim(), item.content_type, item.source_url.trim(), item.thumbnail_url.trim(), publishedAt, item.id).run();
    if (!result.meta?.changes) return json({ error: 'Publication introuvable.' }, 404);
    return json({ ok: true });
  } catch {
    return json({ error: 'Impossible de modifier la publication.' }, 500);
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const { secret, db } = await getContext(locals);
  if (!sameOrigin(request)) return json({ error: 'Origine non autorisée.' }, 403);
  if (!(await authorized(request, secret))) return json({ error: 'Authentification requise.' }, 401);
  if (!db) return json({ error: 'Base de données indisponible.' }, 503);
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Données invalides.' }, 400); }
  if (!Number.isInteger(body.id) || body.id < 1) return json({ error: 'Identifiant invalide.' }, 400);
  try {
    const result = await db.prepare('DELETE FROM publications WHERE id = ?').bind(body.id).run();
    if (!result.meta?.changes) return json({ error: 'Publication introuvable.' }, 404);
    return json({ ok: true });
  } catch {
    return json({ error: 'Impossible de supprimer la publication.' }, 500);
  }
};

function validate(item: any): string | null {
  if (!item || typeof item !== 'object') return 'Données invalides.';
  if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200) return 'Le titre est obligatoire (200 caractères maximum).';
  if (typeof item.description !== 'string' || item.description.length > 2000) return 'Description trop longue (2 000 caractères maximum).';
  if (!['image', 'video', 'article'].includes(item.content_type)) return 'Type de contenu invalide.';
  if (typeof item.source_url !== 'string' || !validHttpUrl(item.source_url)) return 'L’URL source doit être une adresse HTTP ou HTTPS valide.';
  if (typeof item.thumbnail_url !== 'string' || (item.thumbnail_url.trim() && !validHttpUrl(item.thumbnail_url))) return 'L’URL de miniature doit être vide ou une adresse HTTP(S) valide.';
  if (item.published_at !== undefined && item.published_at !== null && item.published_at !== '' && !normalizePublishedAt(item.published_at)) {
    // Temporary diagnostic identifies the exact value rejected by the deployed API.
    const received = typeof item.published_at === 'string' ? item.published_at.slice(0, 80) : String(item.published_at);
    return `Date invalide (API date-fix-2026-10-25-v3 ; valeur reçue : ${JSON.stringify(received)}).`;
  }
  return null;
}

/**
 * Accepts browser datetime-local values (YYYY-MM-DDTHH:mm), SQLite-style
 * values (YYYY-MM-DD HH:mm:ss), and optional seconds/fractional seconds.
 * The stored format is always YYYY-MM-DD HH:mm:ss for consistent D1 sorting.
 */
function normalizePublishedAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/.exec(raw);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? '0');
  const minute = Number(match[5] ?? '0');
  const second = Number(match[6] ?? '0');

  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;

  return `${match[1]}-${match[2]}-${match[3]} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function currentDatabaseDateTime(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function validHttpUrl(value: string): boolean {
  try { const url = new URL(value.trim()); return (url.protocol === 'https:' || url.protocol === 'http:') && value.trim().length <= 2048; }
  catch { return false; }
}
