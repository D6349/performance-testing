import { renderTemplate } from './template.js';

const secretHeaders = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i;

function requireEnv(env, name) {
  if (!name || typeof env[name] !== 'string' || !env[name].length) throw new Error('Required authentication environment variable is missing');
  return env[name];
}

function base64(value) {
  const bytes = [];
  for (const char of encodeURIComponent(value).replace(/%([A-F\d]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))) bytes.push(char.charCodeAt(0));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    result += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63] + (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : '=') + (i + 2 < bytes.length ? alphabet[n & 63] : '=');
  }
  return result;
}

export function validateRequestPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\s?#\u0000-\u001f\u007f]/.test(path)) throw new Error('Endpoint path must be relative to the configured base URL without query, fragment, or whitespace');
  for (const segment of path.split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw new Error('Invalid path encoding'); }
    if (decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/.test(decoded)) throw new Error('Unsafe endpoint path segment');
  }
  return path;
}

function putHeader(headers, name, value) {
  if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\r\n\u0000]/.test(String(value))) throw new Error('Invalid request header');
  if (['host', 'content-length', 'proxy-authorization'].includes(name.toLowerCase())) throw new Error('Header is managed by the HTTP client');
  const existing = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
  if (existing) delete headers[existing];
  headers[name] = String(value);
}

function encodePairs(value) {
  const pairs = [];
  for (const [key, item] of Object.entries(value || {})) {
    for (const scalar of Array.isArray(item) ? item : [item]) {
      if (scalar === undefined || scalar === null) continue;
      if (typeof scalar === 'object') throw new Error('Query and form fields must be scalar values');
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(scalar))}`);
    }
  }
  return pairs.join('&');
}

export function buildRequest(endpoint, environment, context) {
  const path = validateRequestPath(renderTemplate(endpoint.path, context, { encode: true }));
  const query = encodePairs(renderTemplate(endpoint.query || {}, context));
  const url = environment.baseUrl.replace(/\/$/, '') + path + (query ? `?${query}` : '');
  const headers = {};
  const auth = endpoint.auth || environment.auth || { type: 'none' };
  for (const layer of [environment.headers || {}, endpoint.headers || {}]) {
    for (const [key, value] of Object.entries(renderTemplate(layer, context))) {
      if (layer === environment.headers && endpoint.auth?.type === 'none' && secretHeaders.test(key)) continue;
      putHeader(headers, key, value);
    }
  }
  if (auth.type === 'none') {
  } else if (auth.type === 'bearer') {
    putHeader(headers, 'Authorization', `Bearer ${requireEnv(context.env, auth.tokenEnv)}`);
  } else if (auth.type === 'api-key') {
    putHeader(headers, auth.header || 'X-API-Key', requireEnv(context.env, auth.keyEnv));
  } else if (auth.type === 'basic') {
    const username = requireEnv(context.env, auth.usernameEnv);
    if (username.includes(':')) throw new Error('Basic authentication username cannot contain a colon');
    putHeader(headers, 'Authorization', `Basic ${base64(`${username}:${requireEnv(context.env, auth.passwordEnv)}`)}`);
  } else throw new Error('Unsupported authentication type');
  let body = null;
  if (endpoint.body !== undefined) {
    const rendered = renderTemplate(endpoint.body, context);
    const type = endpoint.bodyType || 'json';
    if (type === 'json') {
      body = JSON.stringify(rendered);
      if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) putHeader(headers, 'Content-Type', 'application/json');
    } else if (type === 'form') {
      body = encodePairs(rendered);
      putHeader(headers, 'Content-Type', 'application/x-www-form-urlencoded');
    } else if (type === 'text') {
      if (typeof rendered !== 'string') throw new Error('Text body must be a string');
      body = rendered;
      if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) putHeader(headers, 'Content-Type', 'text/plain');
    } else throw new Error('Unsupported request body type');
  }
  const retainBody = Boolean(endpoint.extract && Object.keys(endpoint.extract).length) || Boolean(endpoint.expect?.json?.length);
  return {
    method: endpoint.method,
    url,
    body,
    params: { headers, timeout: endpoint.timeout || environment.timeout || '10s', redirects: 0, tags: { name: context.endpointId, endpoint: context.endpointId }, responseType: retainBody ? 'text' : 'none' },
    expectedStatuses: endpoint.expect.statuses
  };
}
