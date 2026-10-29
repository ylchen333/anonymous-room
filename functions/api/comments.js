const MAX_MESSAGE_LENGTH = 1600;
const MAX_AUTHOR_LENGTH = 80;
const MAX_SCOPE_ID_LENGTH = 160;
const VALID_SCOPE_TYPES = new Set(['scene', 'segment', 'highlight']);

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (error) {
    console.error('comments GET failed', error);
    return json({ error: `Database error: ${error.message}` }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (error) {
    console.error('comments POST failed', error);
    return json({ error: `Database error: ${error.message}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: 'D1 binding DB is not configured.' }, 500);

  const url = new URL(request.url);
  const scene = cleanString(url.searchParams.get('scene'), 120);
  const scopeType = cleanString(url.searchParams.get('scope_type'), 32);
  const scopeId = cleanString(url.searchParams.get('scope_id'), MAX_SCOPE_ID_LENGTH);

  if (!scene) {
    return json({ error: 'scene is required.' }, 400);
  }

  // scope_type/scope_id are optional: omit both to list every comment in the scene.
  const scoped = Boolean(scopeType || scopeId);
  if (scoped && (!VALID_SCOPE_TYPES.has(scopeType) || !scopeId)) {
    return json({ error: 'scope_type and scope_id must be provided together.' }, 400);
  }

  const columns = `id, scene, scope_type AS scopeType, scope_id AS scopeId, author, message,
           highlight_json AS highlightJson, created_at AS createdAt`;
  const statement = scoped
    ? db.prepare(`SELECT ${columns} FROM comments
        WHERE scene = ? AND scope_type = ? AND scope_id = ?
        ORDER BY created_at ASC LIMIT 200`).bind(scene, scopeType, scopeId)
    : db.prepare(`SELECT ${columns} FROM comments
        WHERE scene = ?
        ORDER BY created_at ASC LIMIT 2000`).bind(scene);
  const { results } = await statement.all();

  return json({
    comments: (results ?? []).map(row => ({
      id: row.id,
      scene: row.scene,
      scope: { type: row.scopeType, id: row.scopeId },
      author: row.author,
      message: row.message,
      highlight: parseJson(row.highlightJson),
      createdAt: row.createdAt,
    })),
  });
}

async function handlePost({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: 'D1 binding DB is not configured.' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Request body must be JSON.' }, 400);
  }

  const scene = cleanString(body.scene, 120);
  const scopeType = cleanString(body.scope?.type, 32);
  const scopeId = cleanString(body.scope?.id, MAX_SCOPE_ID_LENGTH);
  const author = cleanString(body.author || 'anonymous', MAX_AUTHOR_LENGTH) || 'anonymous';
  const message = cleanString(body.message, MAX_MESSAGE_LENGTH);
  const highlightJson = body.highlight ? JSON.stringify(body.highlight).slice(0, 12000) : null;

  if (!scene || !VALID_SCOPE_TYPES.has(scopeType) || !scopeId) {
    return json({ error: 'Valid scene and scope are required.' }, 400);
  }
  if (!message) {
    return json({ error: 'Comment message is required.' }, 400);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  await db.prepare(`
    INSERT INTO comments (id, scene, scope_type, scope_id, author, message, highlight_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, scene, scopeType, scopeId, author, message, highlightJson, createdAt).run();

  return json({
    comment: {
      id,
      scene,
      scope: { type: scopeType, id: scopeId },
      author,
      message,
      highlight: body.highlight ?? null,
      createdAt,
    },
  }, 201);
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: jsonHeaders });
}

function getDb(env) {
  return env.DB ?? env.COMMENTS_DB ?? null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
