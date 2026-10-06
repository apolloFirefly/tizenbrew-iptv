const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');

test('starts inside TizenBrew VM without __dirname or require.main', () => {
  let listening = false;
  const sandbox = {Buffer, console, process, module:{exports:{}}, require(name) {
    if (name === 'http') return {createServer() { return {listen(port, host) { assert.equal(host,'127.0.0.1'); listening=true; }}; }};
    return require(name);
  }};
  vm.runInNewContext(fs.readFileSync(require.resolve('./service'),'utf8'), sandbox);
  assert.equal(listening,true);
});

const { ServiceError, buildApiUrl, liveStreamUrl, normalizeConfig, publicConfig, rewriteManifest, server } = require('./service');

function listen(target) {
  return new Promise((resolve, reject) => {
    target.once('error', reject);
    target.listen(0, '127.0.0.1', () => resolve(target.address().port));
  });
}

function close(target) {
  return new Promise((resolve) => target.close(resolve));
}

test('normalizes valid Xtream configuration', () => {
  assert.deepEqual(normalizeConfig({
    baseUrl: 'https://iptv.example/path///',
    username: ' user ',
    password: 'secret'
  }), {
    baseUrl: 'https://iptv.example/path',
    username: 'user',
    password: 'secret'
  });
});

test('accepts a copied player_api.php URL as the Xtream server URL', () => {
  assert.equal(normalizeConfig({
    baseUrl: 'http://provider.example:8080/player_api.php', username: 'user', password: 'secret'
  }).baseUrl, 'http://provider.example:8080');
});

test('rejects unsafe protocols and missing credentials', () => {
  assert.throws(() => normalizeConfig({ baseUrl: 'file:///etc/passwd', username: 'u', password: 'p' }));
  assert.throws(() => normalizeConfig({ baseUrl: 'https://iptv.example', username: '', password: 'p' }));
});

test('uses safe user-facing errors for network failures', () => {
  const error = new ServiceError('NETWORK', 'La TV no puede conectarse al servidor Xtream. Revisa la URL, red y DNS.');
  assert.equal(error.code, 'NETWORK');
  assert.equal(error.message.includes('password'), false);
});

test('builds player_api URL and keeps password out of public config', () => {
  const config = { baseUrl: 'https://iptv.example:8443', username: 'name', password: 'p&ss' };
  const url = buildApiUrl(config, 'get_live_streams', { category_id: 12 });
  assert.equal(url.searchParams.get('username'), 'name');
  assert.equal(url.searchParams.get('password'), 'p&ss');
  assert.equal(url.searchParams.get('action'), 'get_live_streams');
  assert.equal(url.searchParams.get('category_id'), '12');
  assert.equal(Object.hasOwn(publicConfig(config), 'password'), false);
});

test('creates HLS and transport-stream live URLs', () => {
  const config = { baseUrl: 'https://iptv.example', username: 'name', password: 'secret' };
  assert.equal(liveStreamUrl(config, 42).pathname, '/live/name/secret/42.m3u8');
  assert.equal(liveStreamUrl(config, 42, 'ts').pathname, '/live/name/secret/42.ts');
});

test('rewrites HLS segments and URI attributes through the local proxy', () => {
  const manifest = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="keys/live.key"\nsegment-1.ts\n';
  const result = rewriteManifest(manifest, new URL('https://iptv.example/live/list.m3u8'), '42');
  assert.match(result, /resource\?token=[a-f0-9]+/);
  assert.equal(result.includes('iptv.example'), false);
  assert.match(result, /URI="http:\/\/localhost:8090\/api\/xtream\/stream\/42\/resource\?token=/);
});

test('serves status, categories, channels, and an HLS manifest end to end', async () => {
  const cdn = http.createServer((request, response) => {
    if (request.url === '/segment.ts') { response.end('cdn-segment-fixture'); return; }
    if (request.url === '/stream.ts') { response.end('cdn-transport-stream-fixture'); return; }
    response.writeHead(404).end();
  });
  const cdnPort = await listen(cdn);
  const upstream = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/player_api.php' && !url.searchParams.get('action')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ user_info: { auth: 1, status: 'Active' }, server_info: {} }));
      return;
    }
    if (url.searchParams.get('action') === 'get_live_categories') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([{ category_id: '7', category_name: 'News' }]));
      return;
    }
    if (url.searchParams.get('action') === 'get_live_streams') {
      assert.equal(url.searchParams.get('category_id'), '7');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([{ stream_id: 42, name: 'Test channel' }]));
      return;
    }
    if (url.pathname === '/live/user/pass/42.m3u8') {
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      response.end('#EXTM3U\nhttp://127.0.0.1:' + cdnPort + '/segment.ts\n');
      return;
    }
    if (url.pathname === '/live/user/pass/42.ts') {
      response.writeHead(302, { Location: 'http://127.0.0.1:' + cdnPort + '/stream.ts' }).end();
      return;
    }
    response.writeHead(404).end();
  });

  const upstreamPort = await listen(upstream);
  process.env.XTREAM_BASE_URL = 'http://127.0.0.1:' + upstreamPort;
  process.env.XTREAM_USERNAME = 'user';
  process.env.XTREAM_PASSWORD = 'pass';
  const servicePort = await listen(server);

  try {
    const base = 'http://127.0.0.1:' + servicePort;
    const status = await fetch(base + '/api/xtream/status').then((response) => response.json());
    assert.equal(status.connected, true);
    const categories = await fetch(base + '/api/xtream/categories').then((response) => response.json());
    assert.equal(categories[0].category_name, 'News');
    const channels = await fetch(base + '/api/xtream/channels?categoryId=7').then((response) => response.json());
    assert.equal(channels[0].stream_id, 42);
    const manifest = await fetch(base + '/api/xtream/stream/42').then((response) => response.text());
    assert.match(manifest, /\/api\/xtream\/stream\/42\/resource\?token=/);
    assert.equal(manifest.includes('/user/pass'), false);
    const resource = new URL(manifest.split('\n')[1]);
    assert.equal(await fetch(base + resource.pathname + resource.search).then(r => r.text()), 'cdn-segment-fixture');
    assert.equal((await fetch(base + '/health', {headers:{Origin:'https://untrusted.example'}})).status,403);
    assert.equal((await fetch(base + '/health', {headers:{Origin:'http://127.0.0.1:8081'}})).status,200);
    assert.equal((await fetch(base + '/api/xtream/stream/42/resource?token=bad')).status,400);
    assert.equal(await fetch(base + '/api/xtream/stream/42.ts').then(r => r.text()), 'cdn-transport-stream-fixture');
  } finally {
    delete process.env.XTREAM_BASE_URL;
    delete process.env.XTREAM_USERNAME;
    delete process.env.XTREAM_PASSWORD;
    await close(server);
    await close(upstream);
    await close(cdn);
  }
});
