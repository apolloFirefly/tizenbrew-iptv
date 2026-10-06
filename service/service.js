const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const URL = require('url').URL;
const inTizenBrew = typeof __dirname === 'undefined';

const PORT = Number(process.env.PORT || 8090);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:8080';
const CONFIG_PATH = process.env.XTREAM_CONFIG_PATH || (inTizenBrew
  ? path.join(require('os').homedir(), '.tizenbrew-iptv.json')
  : path.join(__dirname, 'config.local.json'));
const resourceKey = crypto.randomBytes(32);
const allowedOrigins = [FRONTEND_ORIGIN, 'http://127.0.0.1:8081', 'http://localhost:8081', 'http://127.0.0.1:8090', 'http://localhost:8090'];
allowedOrigins.push('http://localhost:' + PORT, 'http://127.0.0.1:' + PORT);
const REQUEST_TIMEOUT_MS = 15000;
const MAX_JSON_BYTES = 10 * 1024 * 1024;

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function normalizeConfig(value) {
  if (!value || typeof value !== 'object') throw new Error('Configuration must be an object');
  const baseUrl = String(value.baseUrl || '').trim().replace(/\/+$/, '');
  const username = String(value.username || '').trim();
  const password = String(value.password || '');
  let parsedUrl;

  try {
    parsedUrl = new URL(baseUrl);
  } catch (_error) {
    throw new Error('Server URL is invalid');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Server URL must use HTTP or HTTPS');
  }
  if (!username || !password) throw new Error('Username and password are required');
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error('Use only the server base URL, without credentials or query parameters');
  }
  return { baseUrl, username, password };
}

function readConfig() {
  const fromEnvironment = {
    baseUrl: process.env.XTREAM_BASE_URL,
    username: process.env.XTREAM_USERNAME,
    password: process.env.XTREAM_PASSWORD
  };
  if (fromEnvironment.baseUrl || fromEnvironment.username || fromEnvironment.password) {
    return normalizeConfig(fromEnvironment);
  }
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
}

function saveConfig(config) {
  const normalized = normalizeConfig(config);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch (_error) {
    // Some TV filesystems do not implement Unix permissions.
  }
  return normalized;
}

function publicConfig(config) {
  if (!config) return { configured: false };
  const server = new URL(config.baseUrl);
  return {
    configured: true,
    server: server.origin + server.pathname.replace(/\/$/, ''),
    username: config.username
  };
}

function buildApiUrl(config, action, query = {}) {
  const url = new URL(config.baseUrl + '/player_api.php');
  url.searchParams.set('username', config.username);
  url.searchParams.set('password', config.password);
  if (action) url.searchParams.set('action', action);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return url;
}

function requestUpstream(url, options = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const upstreamRequest = transport.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, resolve);
    upstreamRequest.setTimeout(REQUEST_TIMEOUT_MS, () => {
      upstreamRequest.destroy(new Error('Xtream request timed out'));
    });
    upstreamRequest.on('error', reject);
    upstreamRequest.end();
  });
}

async function fetchJson(url) {
  const upstream = await requestUpstream(url, { headers: { Accept: 'application/json' } });
  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    upstream.resume();
    throw new Error('Xtream returned HTTP ' + upstream.statusCode);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of upstream) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      upstream.destroy();
      throw new Error('Xtream response is too large');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_error) {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function requireConfig(response) {
  try {
    const config = readConfig();
    if (!config) {
      sendJson(response, 409, { error: 'Xtream is not configured' });
      return null;
    }
    return config;
  } catch (error) {
    sendJson(response, 500, { error: 'Saved configuration could not be loaded' });
    return null;
  }
}

async function getConnectionStatus(config) {
  const data = await fetchJson(buildApiUrl(config));
  const authenticated = String(data && data.user_info && data.user_info.auth) === '1' &&
    (!data.user_info.status || data.user_info.status === 'Active');
  return {
    connected: authenticated,
    status: data && data.user_info ? data.user_info.status || null : null,
    expiresAt: data && data.user_info ? data.user_info.exp_date || null : null,
    serverTime: data && data.server_info ? data.server_info.timestamp_now || null : null
  };
}

function liveStreamUrl(config, streamId) {
  return new URL(config.baseUrl + '/live/' + encodeURIComponent(config.username) + '/' +
    encodeURIComponent(config.password) + '/' + encodeURIComponent(streamId) + '.m3u8');
}

function rewriteManifest(text, upstreamUrl, streamId) {
  function localUrl(value) {
    const target = new URL(value, upstreamUrl);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', resourceKey, iv);
    const encrypted = Buffer.concat([cipher.update(target.toString(), 'utf8'), cipher.final()]);
    const token = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('hex');
    return 'http://localhost:' + PORT + '/api/xtream/stream/' + encodeURIComponent(streamId) +
      '/resource?token=' + token;
  }

  return text.split(/\r?\n/).map((line) => {
    if (!line) return line;
    if (!line.startsWith('#')) return localUrl(line);
    return line.replace(/URI="([^"]+)"/g, (_match, value) => 'URI="' + localUrl(value) + '"');
  }).join('\n');
}

function isAllowedStreamResource(config, target) {
  const server = new URL(config.baseUrl);
  return target.protocol === server.protocol && target.host === server.host;
}

async function proxyStream(request, response, config, target, streamId, redirects = 0) {
  if (!isAllowedStreamResource(config, target)) {
    sendJson(response, 400, { error: 'Stream resource host is not allowed' });
    return;
  }
  const headers = {};
  if (request.headers.range) headers.Range = request.headers.range;
  const upstream = await requestUpstream(target, { headers });
  if (upstream.statusCode >= 300 && upstream.statusCode < 400) {
    upstream.resume();
    if (!upstream.headers.location || redirects >= 4) throw new Error('Too many stream redirects');
    const next = new URL(upstream.headers.location, target);
    return proxyStream(request, response, config, next, streamId, redirects + 1);
  }
  if (upstream.statusCode >= 400) {
    upstream.resume();
    throw new Error('Provider refused this stream');
  }
  const contentType = String(upstream.headers['content-type'] || 'application/octet-stream');
  const isManifest = contentType.includes('mpegurl') || target.pathname.endsWith('.m3u8');

  if (isManifest) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of upstream) {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) { upstream.destroy(); throw new Error('Manifest too large'); }
      chunks.push(chunk);
    }
    response.writeHead(upstream.statusCode || 502, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end(rewriteManifest(Buffer.concat(chunks).toString('utf8'), target, streamId));
    return;
  }
  const passthroughHeaders = { 'Content-Type': contentType };
  ['content-length', 'content-range', 'accept-ranges'].forEach((name) => {
    if (upstream.headers[name]) passthroughHeaders[name] = upstream.headers[name];
  });
  response.writeHead(upstream.statusCode || 502, passthroughHeaders);
  upstream.pipe(response);
  upstream.on('error', () => response.destroy());
  response.on('close', () => upstream.destroy());
}

async function handleRequest(request, response) {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.indexOf(origin) < 0) {
    sendJson(response, 403, { error: 'Origin not allowed' });
    return;
  }
  response.setHeader('Access-Control-Allow-Origin', origin || FRONTEND_ORIGIN);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, 'http://localhost:' + PORT);
  if (request.method === 'GET' && !inTizenBrew) {
    const files = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/vendor/hls.min.js': 'vendor/hls.min.js' };
    if (files[url.pathname]) {
      const file = path.join(__dirname, '../app', files[url.pathname]);
      if (!fs.existsSync(file)) { sendJson(response, 404, { error: 'Asset missing' }); return; }
      response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
      fs.createReadStream(file).pipe(response);
      return;
    }
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/xtream/config') {
    try {
      sendJson(response, 200, publicConfig(readConfig()));
    } catch (error) {
      sendJson(response, 500, { configured: false, error: 'Saved configuration could not be loaded' });
    }
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/xtream/config') {
    const config = normalizeConfig(await readJsonBody(request));
    const status = await getConnectionStatus(config);
    if (!status.connected) {
      sendJson(response, 401, { error: 'Xtream rejected these credentials' });
      return;
    }
    saveConfig(config);
    sendJson(response, 200, { ...publicConfig(config), ...status });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/xtream/status') {
    const config = requireConfig(response);
    if (!config) return;
    sendJson(response, 200, await getConnectionStatus(config));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/xtream/categories') {
    const config = requireConfig(response);
    if (!config) return;
    const categories = await fetchJson(buildApiUrl(config, 'get_live_categories'));
    if (!Array.isArray(categories)) throw new Error('Invalid category response');
    sendJson(response, 200, categories.map(c => ({category_id:String(c.category_id), category_name:String(c.category_name || 'Categoría')})));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/xtream/channels') {
    const config = requireConfig(response);
    if (!config) return;
    const channels = await fetchJson(buildApiUrl(config, 'get_live_streams', {
      category_id: url.searchParams.get('categoryId')
    }));
    if (!Array.isArray(channels)) throw new Error('Invalid channel response');
    sendJson(response, 200, channels.map(c => ({stream_id:c.stream_id, name:String(c.name || 'Canal')})));
    return;
  }

  const streamMatch = url.pathname.match(/^\/api\/xtream\/stream\/(\d+)(?:\/(resource))?$/);
  if (request.method === 'GET' && streamMatch) {
    const config = requireConfig(response);
    if (!config) return;
    const streamId = streamMatch[1];
    let target;
    try {
      if (streamMatch[2]) {
        const token = url.searchParams.get('token') || '';
        if (!/^[a-f0-9]{58,16384}$/.test(token)) throw new Error('Invalid token');
        const sealed = Buffer.from(token, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', resourceKey, sealed.slice(0, 12));
        decipher.setAuthTag(sealed.slice(12, 28));
        target = new URL(Buffer.concat([decipher.update(sealed.slice(28)), decipher.final()]).toString('utf8'));
      } else target = liveStreamUrl(config, streamId);
    } catch (_error) {
      sendJson(response, 400, { error: 'Stream resource URL is invalid' });
      return;
    }
    await proxyStream(request, response, config, target, streamId);
    return;
  }
  sendJson(response, 404, { error: 'Not found' });
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error('IPTV request failed');
    if (!response.headersSent) sendJson(response, 502, { error: 'No se pudo completar la solicitud. Comprueba el servidor y la conexión.' });
    else response.destroy(error);
  });
});

if (inTizenBrew || require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log('TizenBrew IPTV service listening on http://127.0.0.1:' + PORT);
  });
}

module.exports = { buildApiUrl, normalizeConfig, publicConfig, rewriteManifest, server };
