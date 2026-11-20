import { COMMANDS } from '../src/commands.js';

const { DISCORD_APP_ID: app, DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guild } = process.env;
if (!app || !token) {
  console.error('set DISCORD_APP_ID and DISCORD_BOT_TOKEN in your environment');
  process.exit(1);
}

const url = `https://discord.com/api/v10/applications/${app}` + (guild ? `/guilds/${guild}` : '') + '/commands';

// PUT replaces the whole command list, so removing a command from commands.js removes it from discord too
const res = await fetch(url, {
  method: 'PUT',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(COMMANDS),
});
const text = await res.text();
if (!res.ok) { console.error(`${res.status} ${text}`); process.exit(1); }
console.log(`registered ${JSON.parse(text).map((c) => '/' + c.name).join(', ')} ${guild ? `in guild ${guild}` : 'globally'}`);
