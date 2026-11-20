//  entry port

import { postWotd, wotdJson, sayToDiscord } from './wotd.js';
import { handleInteraction } from './discord.js';

const DISCORD_MAX = 2000;

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

// bearer token in the authorization header 
async function isAdmin(req, env) {
  if (!env.ADMIN_TOKEN) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.get('Authorization') || '');
  if (!m) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(m[1])),
    crypto.subtle.digest('SHA-256', enc.encode(env.ADMIN_TOKEN)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function readMessage(req) {
  if ((req.headers.get('Content-Type') || '').includes('application/json')) {
    const body = await req.json().catch(() => null);
    return typeof body?.content === 'string' ? body.content : '';
  }
  return await req.text();
}

async function handleAdmin(req, env, path) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!(await isAdmin(req, env))) return new Response('Unauthorized', { status: 401 });

  if (path === '/api/admin/say') {
    const content = (await readMessage(req)).trim();
    if (!content) return new Response('Empty message', { status: 400 });
    if (content.length > DISCORD_MAX) {
      return new Response(`Too long (${content.length}/${DISCORD_MAX})`, { status: 413 });
    }
    await sayToDiscord(env, content);
    return new Response('sent\n');
  }

  if (path === '/api/admin/post-wotd') { // re-posts today's stored word, ignoring the hour check
    return new Response((await postWotd(env, { force: true })) + '\n');
  }

  return new Response('Not found', { status: 404 });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(postWotd(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/api/wotd') {
      if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      try {
        return json(await wotdJson(env), 200, {
          'Cache-Control': 'public, max-age=60',
          'Access-Control-Allow-Origin': '*',
        });
      } catch (err) {
        console.error('[wotd]', err);
        return json({ error: 'wotd unavailable' }, 500);
      }
    }

    if (url.pathname === '/api/discord/interactions') { // slash commands, signed by discord
      return handleInteraction(req, env);
    }

    if (url.pathname.startsWith('/api/admin/')) {
      try {
        return await handleAdmin(req, env, url.pathname);
      } catch (err) {
        console.error('[admin]', err);
        return new Response(`Error: ${err.message}\n`, { status: 502 });
      }
    }

    if (url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404 });
    }
    return env.ASSETS.fetch(req);
  },
};
