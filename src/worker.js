/**
 * LinguaStudio - Cloudflare Worker Entrypoint
 * Handles User Auth (Google SSO) & Per-User Material CRUD with Cloudflare D1
 * Includes automatic in-memory fallback for preview environments where D1 binding is not yet attached.
 */

import defaultMaterials from './default-materials.js';

// In-memory fallback database for preview/dev deployments before D1 database is bound
class MemoryDb {
  constructor() {
    this.users = new Map();
    this.sessions = new Map();
    this.materials = new Map();
  }

  prepare(query) {
    const self = this;
    return {
      _query: query,
      _args: [],
      bind(...args) {
        this._args = args;
        return this;
      },
      async first() {
        const q = this._query.replace(/\s+/g, ' ').trim();
        const args = this._args;

        if (q.includes('COUNT(*) as count FROM materials WHERE user_id = ?')) {
          const userId = args[0];
          let count = 0;
          for (const m of self.materials.values()) {
            if (m.user_id === userId) count++;
          }
          return { count };
        }

        if (q.includes('FROM sessions s') && q.includes('JOIN users u')) {
          const token = args[0];
          const now = args[1];
          const session = self.sessions.get(token);
          if (session && session.expires_at > now) {
            const user = self.users.get(session.user_id);
            if (user) {
              return { id: user.id, email: user.email, name: user.name, picture: user.picture };
            }
          }
          return null;
        }

        return null;
      },
      async all() {
        const q = this._query.replace(/\s+/g, ' ').trim();
        const args = this._args;

        if (q.includes('FROM materials') && q.includes('WHERE user_id = ?')) {
          const userId = args[0];
          const list = [];
          for (const m of self.materials.values()) {
            if (m.user_id === userId) {
              list.push({
                id: m.id,
                title: m.title,
                titleEn: m.title_en,
                tag: m.tag,
                chinese: m.chinese,
                english: m.english,
                translation: m.translation,
                createdAt: m.created_at,
                updatedAt: m.updated_at
              });
            }
          }
          list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || (b.id || '').localeCompare(a.id || ''));
          return { results: list };
        }

        return { results: [] };
      },
      async run() {
        const q = this._query.replace(/\s+/g, ' ').trim();
        const args = this._args;

        if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) {
          return { meta: { changes: 0 } };
        }

        if (q.includes('INSERT INTO users')) {
          const [id, email, name, picture] = args;
          const existing = self.users.get(id);
          self.users.set(id, {
            id,
            email,
            name: name || existing?.name || email.split('@')[0],
            picture: picture || existing?.picture || '',
            created_at: existing?.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString()
          });
          return { meta: { changes: 1 } };
        }

        if (q.includes('INSERT INTO sessions')) {
          const [token, user_id, expires_at] = args;
          self.sessions.set(token, {
            token,
            user_id,
            expires_at,
            created_at: new Date().toISOString()
          });
          return { meta: { changes: 1 } };
        }

        if (q.includes('DELETE FROM sessions WHERE token = ?')) {
          const token = args[0];
          const deleted = self.sessions.delete(token);
          return { meta: { changes: deleted ? 1 : 0 } };
        }

        if (q.includes('INSERT OR IGNORE INTO materials') || q.includes('INSERT OR REPLACE INTO materials') || q.includes('INSERT INTO materials')) {
          const [user_id, id, title, title_en, tag, chinese, english, translation, created_at, updated_at] = args;
          const key = `${user_id}:${id}`;
          if (q.includes('OR IGNORE') && self.materials.has(key)) {
            return { meta: { changes: 0 } };
          }
          self.materials.set(key, {
            user_id,
            id,
            title,
            title_en,
            tag,
            chinese,
            english,
            translation,
            created_at,
            updated_at
          });
          return { meta: { changes: 1 } };
        }

        if (q.includes('UPDATE materials')) {
          const [title, title_en, tag, chinese, english, translation, updated_at, user_id, id] = args;
          const key = `${user_id}:${id}`;
          const existing = self.materials.get(key);
          if (!existing) {
            return { meta: { changes: 0 } };
          }
          self.materials.set(key, {
            ...existing,
            title,
            title_en,
            tag,
            chinese,
            english,
            translation,
            updated_at
          });
          return { meta: { changes: 1 } };
        }

        if (q.includes('DELETE FROM materials')) {
          const [user_id, id] = args;
          const key = `${user_id}:${id}`;
          const deleted = self.materials.delete(key);
          return { meta: { changes: deleted ? 1 : 0 } };
        }

        return { meta: { changes: 0 } };
      }
    };
  }

  async batch(statements) {
    const results = [];
    for (const stmt of statements) {
      results.push(await stmt.run());
    }
    return results;
  }
}

const memoryDbInstance = new MemoryDb();

function getDb(env) {
  if (env && env.DB) {
    return env.DB;
  }
  console.warn('env.DB binding is missing; falling back to in-memory store for preview/dev mode.');
  return memoryDbInstance;
}

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

function base64UrlEncodeBytes(uint8Array) {
  let binary = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncode(str) {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function base64UrlDecodeBytes(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function getHmacKey(secret) {
  const enc = new TextEncoder();
  return await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signSessionToken(payload, secret) {
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(payloadStr);
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const sigB64 = base64UrlEncodeBytes(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

async function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const key = await getHmacKey(secret);
    const sigBytes = base64UrlDecodeBytes(sigB64);
    const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payloadB64));
    if (!isValid) return null;

    const payload = JSON.parse(base64UrlDecode(payloadB64));
    if (!payload || !payload.exp || payload.exp < Date.now()) {
      return null;
    }
    return payload;
  } catch (err) {
    return null;
  }
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

async function getAuthenticatedUser(request, db, env) {
  const cookies = parseCookies(request);
  let token = cookies['ls_session'];

  if (!token) {
    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }
  }

  if (!token) return null;

  // 1. Verify stateless signed session token across all isolates
  const secret = (env && env.SESSION_SECRET) || 'lingua-studio-auth-secret-v1';
  const verified = await verifySessionToken(token, secret);
  if (verified && verified.id) {
    return {
      id: verified.id,
      email: verified.email,
      name: verified.name,
      picture: verified.picture || ''
    };
  }

  // 2. Check DB sessions table for legacy or DB-persisted tokens
  const now = Date.now();
  try {
    const session = await db.prepare(`
      SELECT u.id, u.email, u.name, u.picture
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND s.expires_at > ?
    `).bind(token, now).first();

    return session || null;
  } catch (err) {
    console.warn('Session DB lookup failed:', err);
    return null;
  }
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

    const db = getDb(env);

    await ensureSchema(db);

    const isSecure = url.protocol === 'https:';

    try {
      // GET /api/auth/config
      if (url.pathname === '/api/auth/config' && request.method === 'GET') {
        return jsonResponse({
          googleClientId: env.GOOGLE_CLIENT_ID || '',
          devMode: env.DEV_MODE === 'true' || !env.GOOGLE_CLIENT_ID,
          isD1Bound: Boolean(env && env.DB)
        });
      }

      // GET /api/auth/me
      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        const user = await getAuthenticatedUser(request, db, env);
        return jsonResponse({ user });
      }

      // POST /api/auth/google
      if (url.pathname === '/api/auth/google' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (!body.credential) {
          return jsonResponse({ error: 'Credential is required' }, 400);
        }

        const profile = await verifyGoogleIdToken(body.credential, env);

        await db.prepare(`
          INSERT INTO users (id, email, name, picture, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            email = excluded.email,
            name = excluded.name,
            picture = excluded.picture,
            updated_at = CURRENT_TIMESTAMP
        `).bind(profile.id, profile.email, profile.name, profile.picture).run();

        await seedUserMaterialsIfEmpty(db, profile.id);

        const secret = (env && env.SESSION_SECRET) || 'lingua-studio-auth-secret-v1';
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
        const token = await signSessionToken({
          id: profile.id,
          email: profile.email,
          name: profile.name,
          picture: profile.picture,
          exp: expiresAt
        }, secret);

        try {
          await db.prepare(
            'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
          ).bind(token, profile.id, expiresAt).run();
        } catch (e) {
          console.warn('Session DB insert warning:', e);
        }

        return jsonResponse(
          {
            user: { id: profile.id, email: profile.email, name: profile.name, picture: profile.picture },
            token
          },
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

        await db.prepare(`
          INSERT INTO users (id, email, name, picture, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            email = excluded.email,
            name = excluded.name,
            picture = excluded.picture,
            updated_at = CURRENT_TIMESTAMP
        `).bind(devUserId, devEmail, devName, devPicture).run();

        await seedUserMaterialsIfEmpty(db, devUserId);

        const secret = (env && env.SESSION_SECRET) || 'lingua-studio-auth-secret-v1';
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
        const token = await signSessionToken({
          id: devUserId,
          email: devEmail,
          name: devName,
          picture: devPicture,
          exp: expiresAt
        }, secret);

        try {
          await db.prepare(
            'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
          ).bind(token, devUserId, expiresAt).run();
        } catch (e) {
          console.warn('Session DB insert warning:', e);
        }

        return jsonResponse(
          {
            user: { id: devUserId, email: devEmail, name: devName, picture: devPicture },
            token
          },
          200,
          { 'Set-Cookie': createSessionCookie(token, 30 * 24 * 60 * 60, isSecure) }
        );
      }

      // POST /api/auth/logout
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        const cookies = parseCookies(request);
        let token = cookies['ls_session'];
        if (!token) {
          const authHeader = request.headers.get('Authorization');
          if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.slice(7).trim();
          }
        }
        if (token) {
          try {
            await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
          } catch (e) {
            console.warn('Session delete warning:', e);
          }
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
        const user = await getAuthenticatedUser(request, db, env);
        if (!user) {
          return jsonResponse({ error: '認証が必要です' }, 401);
        }

        const { results } = await db.prepare(`
          SELECT id, title, title_en as titleEn, tag, chinese, english, translation, created_at as createdAt, updated_at as updatedAt
          FROM materials
          WHERE user_id = ?
          ORDER BY created_at DESC, id DESC
        `).bind(user.id).all();

        return jsonResponse({ materials: results || [] });
      }

      // POST /api/materials
      if (url.pathname === '/api/materials' && request.method === 'POST') {
        const user = await getAuthenticatedUser(request, db, env);
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

        await db.prepare(`
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
        const user = await getAuthenticatedUser(request, db, env);
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

        const res = await db.prepare(`
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
        const user = await getAuthenticatedUser(request, db, env);
        if (!user) {
          return jsonResponse({ error: '認証が必要です' }, 401);
        }

        const materialId = decodeURIComponent(url.pathname.replace('/api/materials/', ''));
        const res = await db.prepare(`
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
        const user = await getAuthenticatedUser(request, db, env);
        if (!user) {
          return jsonResponse({ error: '認証が必要です' }, 401);
        }

        const now = new Date().toISOString().slice(0, 10);
        const statements = defaultMaterials.map(item => {
          return db.prepare(`
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

        await db.batch(statements);

        const { results } = await db.prepare(`
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
