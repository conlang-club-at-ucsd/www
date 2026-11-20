// posts the tlag word of the day to a discord webhook.

const WOTD_TZ = 'America/Los_Angeles';

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

export function pickForDate(entries, key) {
  return entries[hashStr('tlag-wotd:' + key, 0) % entries.length];
}

const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, '').trim();
const englishOf = (e) => (typeof e.enHtml === 'string' ? stripTags(e.enHtml) : e.en || '');

export function buildPayload(entry, key, siteUrl) {
  const meta = [entry.ipa, entry.pos && `*${entry.pos}*`, ...(entry.cats || [])].filter(Boolean).join(' · ');
  const lines = [meta, `**${englishOf(entry)}**`, entry.ety && `_${entry.ety}_`].filter(Boolean);

  for (const x of entry.ex || []) {
    lines.push('', `> ${x.tlag || ''}`);
    String(x.en || '').split('\n').filter(Boolean).forEach((l) => lines.push(`> ${l}`));
    if (x.gloss) lines.push(`> -# ${x.gloss}`);
  }

  return {
    username: 'Tlag Word of the Day',
    allowed_mentions: { parse: [] }, // never ping anyone (may change if wotd only role?)
    embeds: [{
      title: entry.t,
      url: `${siteUrl}?w=${encodeURIComponent(entry.t)}`,
      description: lines.join('\n').slice(0, 4000),
      footer: { text: `Word of the day · ${key}` },
      color: 0x8a6bd1,
    }],
  };
}

export async function postWotd(env, { force = false } = {}) {
  const { key, hour } = pacificParts();
  if (!force && hour !== Number(env.POST_HOUR)) return 'not posting hour';
  if (!env.DISCORD_WEBHOOK_URL) return 'DISCORD_WEBHOOK_URL is not set';

  const res = await env.ASSETS.fetch('https://assets.invalid/tlag/data/dictionary.json');
  if (!res.ok) throw new Error(`dictionary read failed: ${res.status}`);
  const dict = await res.json();

  const entry = pickForDate(dict.entries, key);
  const hook = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPayload(entry, key, env.SITE_URL)),
  });
  if (!hook.ok) throw new Error(`discord webhook failed: ${hook.status} ${await hook.text()}`);
  return `posted ${entry.t} for ${key}`;
}
