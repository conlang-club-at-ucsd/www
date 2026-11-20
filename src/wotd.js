// tlag word of the day: picks, stores (workers kv), and posts to a discord webhook.
//
// history lives in a single kv key as an ascending array of { date, entry }, where
// `entry` is a snapshot of the dictionary entry as it was on that day. snapshots mean
// later dictionary edits/additions/removals can never rewrite or break past days.
// at most one write a day (when the day's word is first needed) and one read per use.

const WOTD_TZ = 'America/Los_Angeles';
const HISTORY_KEY = 'wotd:history';
export const MAX_HISTORY = 200;

function pacificParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WOTD_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { key: `${get('year')}-${get('month')}-${get('day')}`, hour: +get('hour') };
}

function hashStr(str, seed) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, '').trim();
export const englishOf = (e) => (typeof e.enHtml === 'string' ? stripTags(e.enHtml) : e.en || '');

// the dictionary has a few homographs, so identify an entry by more than its headword
const entryId = (e) => JSON.stringify([e.t, englishOf(e), e.pos || '']);

// deterministic for a given (date, history, dictionary), so two requests racing to create
// the same day's word both land on the same answer. words used recently are skipped.
export function pickForDate(entries, key, history = []) {
  const n = Math.min(history.length, Math.floor(entries.length / 2));
  const recent = new Set((n > 0 ? history.slice(-n) : []).map((h) => entryId(h.entry)));
  let pool = entries.filter((e) => !recent.has(entryId(e)));
  if (!pool.length) pool = entries;
  return pool[hashStr('tlag-wotd:' + key, 0) % pool.length];
}

async function loadHistory(env) {
  const h = await env.WOTD_KV.get(HISTORY_KEY, 'json');
  return Array.isArray(h) ? h : [];
}

export async function loadDictionary(env) {
  const res = await env.ASSETS.fetch('https://assets.invalid/tlag/data/dictionary.json');
  if (!res.ok) throw new Error(`dictionary read failed: ${res.status}`);
  const dict = await res.json();
  if (!dict.entries?.length) throw new Error('dictionary has no entries');
  return dict;
}

// returns today's stored word, choosing and saving one if this is the first ask of the day.
export async function ensureToday(env, key = pacificParts().key) {
  const history = await loadHistory(env);
  const existing = history.find((h) => h.date === key);
  if (existing) return { key, entry: existing.entry, history, created: false };

  const dict = await loadDictionary(env);
  const entry = pickForDate(dict.entries, key, history);
  history.push({ date: key, entry });
  history.sort((a, b) => (a.date < b.date ? -1 : 1));
  while (history.length > MAX_HISTORY) history.shift();
  await env.WOTD_KV.put(HISTORY_KEY, JSON.stringify(history));
  return { key, entry, history, created: true };
}

// what the website fetches: GET /api/wotd
export async function wotdJson(env) {
  const { key, history } = await ensureToday(env);
  return { today: key, history };
}

// one dictionary entry as a discord embed. shared by the daily post and the slash commands.
export function entryEmbed(entry, siteUrl, footerText) {
  const meta = [entry.ipa, entry.pos && `*${entry.pos}*`, ...(entry.cats || [])].filter(Boolean).join(' · ');
  const lines = [meta, `**${englishOf(entry)}**`, entry.ety && `_${entry.ety}_`].filter(Boolean);

  for (const x of entry.ex || []) {
    lines.push('', `> ${x.tlag || ''}`);
    String(x.en || '').split('\n').filter(Boolean).forEach((l) => lines.push(`> ${l}`));
    if (x.gloss) lines.push(`> -# ${x.gloss}`);
  }

  const embed = {
    title: entry.t,
    url: `${siteUrl}?w=${encodeURIComponent(entry.t)}`,
    description: lines.join('\n').slice(0, 4000),
    color: 0x8a6bd1,
  };
  if (footerText) embed.footer = { text: footerText };
  return embed;
}

export function buildPayload(entry, key, siteUrl) {
  return {
    username: 'Tlag Word of the Day',
    allowed_mentions: { parse: [] }, // never ping anyone (may change if wotd only role?)
    embeds: [entryEmbed(entry, siteUrl, `Word of the day · ${key}`)],
  };
}

async function sendToDiscord(env, payload) {
  const hook = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!hook.ok) throw new Error(`discord webhook failed: ${hook.status} ${await hook.text()}`);
}

export async function postWotd(env, { force = false } = {}) {
  const { key, hour } = pacificParts();
  if (!force && hour !== Number(env.POST_HOUR)) return 'not posting hour';
  if (!env.DISCORD_WEBHOOK_URL) return 'DISCORD_WEBHOOK_URL is not set';

  // normally already stored by an earlier visitor; otherwise this creates it
  const { entry } = await ensureToday(env, key);
  await sendToDiscord(env, buildPayload(entry, key, env.SITE_URL));
  return `posted ${entry.t} for ${key}`;
}

// admin: send an arbitrary message through the same webhook. never pings anyone.
export async function sayToDiscord(env, content) {
  if (!env.DISCORD_WEBHOOK_URL) throw new Error('DISCORD_WEBHOOK_URL is not set');
  await sendToDiscord(env, {
    username: 'Tlag Word of the Day',
    content,
    allowed_mentions: { parse: [] },
  });
}
