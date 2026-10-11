/**
 * LinguaStudio - Cloudflare Worker Entrypoint
 * Handles User Auth (Google SSO) & Per-User Material CRUD with Cloudflare D1
 */

import defaultMaterials from './default-materials.json';

let schemaInitialized = false;

async function ensureSchema(db) {
  if (schemaInitialized) return;
  try {
    await db.batch([
      db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          name TEXT,
          picture TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS materials (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          title TEXT NOT NULL,
          title_en TEXT NOT NULL,
          tag TEXT NOT NULL,
          chinese TEXT NOT NULL,
          english TEXT NOT NULL,
          translation TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, id)
        );
      `),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_materials_user_id ON materials(user_id);`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);`)
    ]);
    schemaInitialized = true;
  } catch (err) {
    console.error('Failed to ensure schema:', err);
  }
}

async function seedUserMaterialsIfEmpty(db, userId) {
  const countRes = await db.prepare(
    'SELECT COUNT(*) as count FROM materials WHERE user_id = ?'
  ).bind(userId).first();

  if (countRes && countRes.count > 0) {
    return;
  }

  const now = new Date().toISOString().slice(0, 10);
  const statements = defaultMaterials.map(item => {
    return db.prepare(`
      INSERT OR IGNORE INTO materials (
        user_id, id, title, title_en, tag, chinese, english, translation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      item.id,
      item.title,
      item.titleEn || item.title,
      item.tag || '一般',
      item.chinese,
      item.english,
      item.translation || '',
      item.createdAt || now,
      now
    );
  });

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

function generateSessionToken() {
  const buffer = new Uint8Array(32);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, b => b.toString(16).padStart(2, '0')).join('');
}

function parseCookies(request) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return {};
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...val] = cookie.trim().split('=');
    if (name) {
      cookies[name] = decodeURIComponent(val.join('='));
    }
  });
  return cookies;
}

function createSessionCookie(token, maxAgeSeconds, isSecure) {
  let cookie = `ls_session=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax`;
  if (isSecure) {
    cookie += '; Secure';
  }
  return cookie;
}

async function getAuthenticatedUser(request, env) {
  const cookies = parseCookies(request);
  let token = cookies['ls_session'];

  if (!token) {
    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }
  }

  if (!token) return null;

  const now = Date.now();
  const session = await env.DB.prepare(`
    SELECT u.id, u.email, u.name, u.picture
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `).bind(token, now).first();

  return session || null;
}

async function verifyGoogleIdToken(idToken, env) {
  if (!idToken) {
    throw new Error('IDトークンが指定されていません');
  }

  const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
  const res = await fetch(verifyUrl);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Googleトークンの検証に失敗しました: ${errText}`);
  }

  const payload = await res.json();

  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw new Error('不正なトークン発行元です');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Number(payload.exp) < nowSec) {
    throw new Error('トークンの有効期限が切れています');
  }

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_ID.trim() !== '') {
    if (payload.aud !== env.GOOGLE_CLIENT_ID) {
      throw new Error('Client IDが一致しません');
    }
  }

  return {
    id: payload.sub,
    email: payload.email,
    name: payload.name || payload.email.split('@')[0],
    picture: payload.picture || '',
    emailVerified: payload.email_verified === 'true' || payload.email_verified === true
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Only intercept /api/ routes
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (!env.DB) {
      return jsonResponse({ error: 'Database binding (DB) is missing in worker configuration' }, 500);
    }

    await ensureSchema(env.DB);

    const isSecure = url.protocol === 'https:';

    try {
      // GET /api/auth/config
      if (url.pathname === '/api/auth/config' && request.method === 'GET') {
        return jsonResponse({
          googleClientId: env.GOOGLE_CLIENT_ID || '',
          devMode: env.DEV_MODE === 'true' || !env.GOOGLE_CLIENT_ID
        });
      }

      // GET /api/auth/me
      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        const user = await getAuthenticatedUser(request, env);
        return jsonResponse({ user });
      }

      // POST /api/auth/google
      if (url.pathname === '/api/auth/google' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (!body.credential) {
          return jsonResponse({ error: 'Credential is required' }, 400);
        }

        const profile = await verifyGoogleIdToken(body.credential, env);

        await env.DB.prepare(`
          INSERT INTO users (id, email, name, picture, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            email = excluded.email,
            name = excluded.name,
            picture = excluded.picture,
            updated_at = CURRENT_TIMESTAMP
        `).bind(profile.id, profile.email, profile.name, profile.picture).run();

        await seedUserMaterialsIfEmpty(env.DB, profile.id);

        const token = generateSessionToken();
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
        await env.DB.prepare(
          'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
        ).bind(token, profile.id, expiresAt).run();

        return jsonResponse(
          { user: { id: profile.id, email: profile.email, name: profile.name, picture: profile.picture } },
          200,
          { 'Set-Cookie': createSessionCookie(token, 30 * 24 * 60 * 60, isSecure) }
        );
      }

      // POST /api/auth/dev-login (active when DEV_MODE=true or GOOGLE_CLIENT_ID is empty)
      if (url.pathname === '/api/auth/dev-login' && request.method === 'POST') {
        const isDevAllowed = env.DEV_MODE === 'true' || !env.GOOGLE_CLIENT_ID;
        if (!isDevAllowed) {
          return jsonResponse({ error: 'Dev login not allowed in production' }, 403);
        }

        const body = await request.json().catch(() => ({}));
        const devUserId = body.id || 'dev-google-user-1';
        const devEmail = body.email || 'developer@lingua-studio.com';
        const devName = body.name || 'Google テストユーザー';
        const devPicture = body.picture || 'https://lh3.googleusercontent.com/a/default-user';

        await env.DB.prepare(`
          INSERT INTO users (id, email, name, picture, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            email = excluded.email,
            name = excluded.name,
            picture = excluded.picture,
            updated_at = CURRENT_TIMESTAMP
        `).bind(devUserId, devEmail, devName, devPicture).run();

        await seedUserMaterialsIfEmpty(env.DB, devUserId);

        const token = generateSessionToken();
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
        await env.DB.prepare(
          'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
        ).bind(token, devUserId, expiresAt).run();

        return jsonResponse(
          { user: { id: devUserId, email: devEmail, name: devName, picture: devPicture } },
          200,
          { 'Set-Cookie': createSessionCookie(token, 30 * 24 * 60 * 60, isSecure) }
        );
      }

      // POST /api/auth/logout
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        const cookies = parseCookies(request);
        const token = cookies['ls_session'];
        if (token) {
          await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
        }
        return jsonResponse(
          { success: true },
          200,
          { 'Set-Cookie': 'ls_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' }
        );
      }

      // --- Materials CRUD ---

      // GET /api/materials
      if (url.pathname === '/api/materials' && request.method === 'GET') {
        const user = await getAuthenticatedUser(request, env);
        if (!user) {
          return jsonResponse({ error: '認証が必要です' }, 401);
        }

        const { results } = await env.DB.prepare(`
          SELECT id, title, title_en as titleEn, tag, chinese, english, translation, created_at as createdAt, updated_at as updatedAt
          FROM materials
          WHERE user_id = ?
          ORDER BY created_at DESC, id DESC
        `).bind(user.id).all();

        return jsonResponse({ materials: results || [] });
      }

      // POST /api/materials
      if (url.pathname === '/api/materials' && request.method === 'POST') {
        const user = await getAuthenticatedUser(request, env);
        if (!user) {
          return jsonResponse({ error: '認証が必要です' }, 401);
        }

        const body = await request.json().catch(() => ({}));
        if (!body.chinese || !body.english) {
          return jsonResponse({ error: '中国語と英語の文章は必須です' }, 400);
        }

        const id = (body.id && typeof body.id === 'string' && body.id.trim())
          ? body.id.trim()
          : 'user-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
        const title = body.title?.trim() || '新規登録教材';
        const titleEn = body.titleEn?.trim() || title;
        const tag = body.tag?.trim() || '日常会話';
        const chinese = body.chinese.trim();
        const english = body.english.trim();
        const translation = body.translation?.trim() || '';
        const now = new Date().toISOString().slice(0, 10);

        await env.DB.prepare(`
          INSERT INTO materials (user_id, id, title, title_en, tag, chinese, english, translation, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(user.id, id, title, titleEn, tag, chinese, english, translation, now, now).run();

        return jsonResponse({
          material: {
            id,
            title,
            titleEn,
            tag,
            chinese,
            english,
            translation,
            createdAt: now,
            updatedAt: now
          }
        }, 201);
      }

      // PUT /api/materials/:id
      if (url.pathname.startsWith('/api/materials/') && request.method === 'PUT') {
        const user = await getAuthenticatedUser(request, env);
        if (!user) {
          return jsonResponse({ error: '認証が必要です' }, 401);
        }

        const materialId = decodeURIComponent(url.pathname.replace('/api/materials/', ''));
        const body = await request.json().catch(() => ({}));
        if (!body.chinese || !body.english) {
          return jsonResponse({ error: '中国語と英語の文章は必須です' }, 400);
        }

        const title = body.title?.trim() || '新規教材';
        const titleEn = body.titleEn?.trim() || title;
        const tag = body.tag?.trim() || '日常会話';
        const chinese = body.chinese.trim();
        const english = body.english.trim();
        const translation = body.translation?.trim() || '';
        const now = new Date().toISOString().slice(0, 10);

        const res = await env.DB.prepare(`
          UPDATE materials
          SET title = ?, title_en = ?, tag = ?, chinese = ?, english = ?, translation = ?, updated_at = ?
          WHERE user_id = ? AND id = ?
        `).bind(title, titleEn, tag, chinese, english, translation, now, user.id, materialId).run();

        if (!res.meta.changes) {
          return jsonResponse({ error: '教材が見つかりません' }, 404);
        }

        return jsonResponse({
          material: {
            id: materialId,
            title,
            titleEn,
            tag,
            chinese,
            english,
            translation,
            updatedAt: now
          }
        });
      }

      // DELETE /api/materials/:id
      if (url.pathname.startsWith('/api/materials/') && request.method === 'DELETE') {
        const user = await getAuthenticatedUser(request, env);
        if (!user) {
          return jsonResponse({ error: '認証が必要です' }, 401);
        }

        const materialId = decodeURIComponent(url.pathname.replace('/api/materials/', ''));
        const res = await env.DB.prepare(`
          DELETE FROM materials
          WHERE user_id = ? AND id = ?
        `).bind(user.id, materialId).run();

        if (!res.meta.changes) {
          return jsonResponse({ error: '教材が見つかりません' }, 404);
        }

        return jsonResponse({ success: true, id: materialId });
      }

      // POST /api/materials/restore-defaults
      if (url.pathname === '/api/materials/restore-defaults' && request.method === 'POST') {
        const user = await getAuthenticatedUser(request, env);
        if (!user) {
          return jsonResponse({ error: '認証が必要です' }, 401);
        }

        const now = new Date().toISOString().slice(0, 10);
        const statements = defaultMaterials.map(item => {
          return env.DB.prepare(`
            INSERT OR REPLACE INTO materials (
              user_id, id, title, title_en, tag, chinese, english, translation, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            user.id,
            item.id,
            item.title,
            item.titleEn || item.title,
            item.tag || '一般',
            item.chinese,
            item.english,
            item.translation || '',
            item.createdAt || now,
            now
          );
        });

        await env.DB.batch(statements);

        const { results } = await env.DB.prepare(`
          SELECT id, title, title_en as titleEn, tag, chinese, english, translation, created_at as createdAt, updated_at as updatedAt
          FROM materials
          WHERE user_id = ?
          ORDER BY created_at DESC, id DESC
        `).bind(user.id).all();

        return jsonResponse({ materials: results || [] });
      }

      return jsonResponse({ error: 'Not Found' }, 404);
    } catch (err) {
      console.error('API Error:', err);
      return jsonResponse({ error: err.message || 'サーバーエラーが発生しました' }, 500);
    }
  }
};
