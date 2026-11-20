// send an arbitrary message to the discord webhook through the worker.

const url = process.env.SAY_URL || 'https://conlangatucsd.com/api/admin/say';
const token = process.env.ADMIN_TOKEN;
if (!token) { console.error('set ADMIN_TOKEN in your environment'); process.exit(1); }

let message = process.argv.slice(2).join(' ');
if (!message && !process.stdin.isTTY) {
  message = '';
  for await (const chunk of process.stdin) message += chunk;
}
message = message.trim();
if (!message) { console.error('usage: npm run say -- "message"'); process.exit(1); }

const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: message }),
});
const text = (await res.text()).trim();
console.log(res.ok ? text : `${res.status} ${text}`);
process.exit(res.ok ? 0 : 1);
