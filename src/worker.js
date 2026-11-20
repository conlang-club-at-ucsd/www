//  entry port

import { postWotd } from './wotd.js';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(postWotd(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/api/wotd-test' && req.method === 'POST'
        && env.TEST_TOKEN && url.searchParams.get('token') === env.TEST_TOKEN) {
      return new Response(await postWotd(env, { force: true }));
    }

    if (url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404 });
    }
    return env.ASSETS.fetch(req);
  },
};
