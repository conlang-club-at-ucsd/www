// discord slash commands over discord's "interactions endpoint": 

import { englishOf, entryEmbed, ensureToday, loadDictionary } from './wotd.js';

// interaction + response type numbers
const PING = 1, COMMAND = 2, AUTOCOMPLETE = 4;
const PONG = 1, MESSAGE = 4, AUTOCOMPLETE_RESULT = 8;
const EPHEMERAL = 64; // only the person who ran the command sees it

const MAX_SKEW_SECONDS = 300;
const enc = new TextEncoder();

const reply = (data) => ({ type: MESSAGE, data: { allowed_mentions: { parse: [] }, ...data } });
const privateReply = (content) => reply({ content, flags: EPHEMERAL });
const choices = (list) => ({ type: AUTOCOMPLETE_RESULT, data: { choices: list } });
const jsonResponse = (obj) =>
  new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });

//signature check

function fromHex(s) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(s || '')) return null;
  return Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16));
}

async function isFromDiscord(req, env, body) {
  const sig = fromHex(req.headers.get('X-Signature-Ed25519'));
  const ts = req.headers.get('X-Signature-Timestamp') || '';
  const pub = fromHex(env.DISCORD_PUBLIC_KEY);
  if (!sig || !pub || !ts) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_SECONDS) return false; // replayed or stale
  try {
    const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, sig, enc.encode(ts + body));
  } catch {
    return false;
  }
}

//dict index

// lowercase + strip accents
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

let indexPromise;
function getIndex(env) {
  indexPromise ??= loadDictionary(env)
    .then((dict) => {
      const items = dict.entries.map((entry) => ({ entry, t: norm(entry.t), en: norm(englishOf(entry)) }));
      const cats = new Map();
      for (const { entry } of items) for (const c of entry.cats || []) cats.set(c, (cats.get(c) || 0) + 1);
      return { items, cats };
    })
    .catch((err) => { indexPromise = undefined; throw err; }); // don't cache a failure
  return indexPromise;
}

function score(item, q) {
  if (item.t === q) return 0;
  if (item.t.startsWith(q)) return 1;
  if (item.en === q || item.en.split(/[^\p{L}\p{N}]+/u).includes(q)) return 2;
  if (item.en.startsWith(q)) return 3;
  if (item.t.includes(q)) return 4;
  if (item.en.includes(q)) return 5;
  return null;
}

function search(index, rawQuery, limit) {
  const q = norm(rawQuery);
  if (!q) return [];
  return index.items
    .map((item) => ({ item, s: score(item, q) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => a.s - b.s || a.item.t.length - b.item.t.length || (a.item.t < b.item.t ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.item);
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const label = (entry) => clip(`${entry.t} — ${englishOf(entry)}`, 100);
const quote = (s) => '`' + String(s).replace(/`/g, "'").slice(0, 80) + '`';

//commands

async function define(env, query) {
  const index = await getIndex(env);
  const q = norm(query);
  const exact = index.items.filter((i) => i.t === q).slice(0, 3); // a few headwords are homographs

  if (exact.length) {
    const many = exact.length > 1; // discord caps a message's embeds at 6000 characters total
    const embeds = exact.map(({ entry }) => {
      const e = entryEmbed(entry, env.SITE_URL, many ? null : 'Tlag dictionary');
      if (many) e.description = e.description.slice(0, 1800);
      return e;
    });
    return reply({ embeds });
  }

  const near = search(index, query, 8);
  if (!near.length) return privateReply(`No Tlag word or English meaning matches ${quote(query)}.`);
  return privateReply(
    `No Tlag word spelled ${quote(query)}. Closest matches:\n` +
      near.map(({ entry }) => `• **${entry.t}** - ${englishOf(entry)}`).join('\n') +
      '\n-# Run /define with one of these.',
  );
}

async function random(env, category) {
  const index = await getIndex(env);
  const pool = category
    ? index.items.filter(({ entry }) => (entry.cats || []).some((c) => norm(c) === norm(category)))
    : index.items;
  if (!pool.length) return privateReply(`No words in the category ${quote(category)}.`);
  const { entry } = pool[Math.floor(Math.random() * pool.length)];
  return reply({ embeds: [entryEmbed(entry, env.SITE_URL, category ? `Random · ${category}` : 'Random word')] });
}

async function wotd(env) {
  const { key, entry } = await ensureToday(env);
  return reply({ embeds: [entryEmbed(entry, env.SITE_URL, `Word of the day · ${key}`)] });
}

async function autocomplete(env, name, typed) {
  const index = await getIndex(env);
  if (name === 'word') {
    return choices(search(index, typed, 25).map(({ entry }) => ({ name: label(entry), value: clip(entry.t, 100) })));
  }
  if (name === 'category') {
    const q = norm(typed);
    return choices(
      [...index.cats]
        .filter(([c]) => norm(c).includes(q))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([c, n]) => ({ name: clip(`${c} (${n})`, 100), value: clip(c, 100) })),
    );
  }
  return choices([]);
}

// entrypoint

export async function handleInteraction(req, env) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body = await req.text();
  if (!(await isFromDiscord(req, env, body))) return new Response('Bad signature', { status: 401 });

  let i;
  try { i = JSON.parse(body); } catch { return new Response('Bad request', { status: 400 }); }

  if (i.type === PING) return jsonResponse({ type: PONG });

  const opts = Object.fromEntries((i.data?.options || []).map((o) => [o.name, o]));

  try {
    if (i.type === AUTOCOMPLETE) {
      const focused = (i.data?.options || []).find((o) => o.focused);
      return jsonResponse(await autocomplete(env, focused?.name, String(focused?.value ?? '')));
    }
    if (i.type === COMMAND) {
      switch (i.data?.name) {
        case 'define': return jsonResponse(await define(env, String(opts.word?.value ?? '')));
        case 'random': return jsonResponse(await random(env, opts.category?.value));
        case 'wotd': return jsonResponse(await wotd(env));
      }
      return jsonResponse(privateReply('Unknown command.'));
    }
  } catch (err) {
    console.error('[discord]', err);
    return jsonResponse(i.type === AUTOCOMPLETE ? choices([]) : privateReply('Something went wrong, try again in a moment.'));
  }
  return new Response('Unsupported interaction', { status: 400 });
}
