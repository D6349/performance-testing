const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const tokenPattern = /\{\{\s*([a-zA-Z][\w]*(?:\.[\w-]+|\[\d+\])*)\s*\}\}/g;

export function getPath(value, path) {
  if (path === '$' || path === '') return value;
  if (typeof path !== 'string') return undefined;
  const normalized = path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1');
  if (!/^[\w-]+(?:\.[\w-]+)*$/.test(normalized)) return undefined;
  for (const part of normalized.split('.')) {
    if (forbidden.has(part) || value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function resolve(path, context) {
  if (!/^(env|vars|data|runtime)\./.test(path)) throw new Error('Template must use env, vars, data, or runtime');
  const value = getPath(context, path);
  if (value === undefined || value === null) throw new Error(`Missing template value: ${path}`);
  return value;
}

export function renderTemplate(value, context, { encode = false } = {}) {
  if (Array.isArray(value)) return value.map(item => renderTemplate(item, context, { encode }));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (forbidden.has(key)) throw new Error('Unsafe object key');
      result[key] = renderTemplate(item, context, { encode });
    }
    return result;
  }
  if (typeof value !== 'string') return value;
  const token = new RegExp(tokenPattern.source, 'g');
  const matches = [...value.matchAll(token)];
  token.lastIndex = 0;
  if (!matches.length) {
    if (value.includes('{{') || value.includes('}}')) throw new Error('Malformed template');
    return value;
  }
  if (!encode && matches.length === 1 && matches[0][0] === value) return resolve(matches[0][1], context);
  const rendered = value.replace(token, (_, path) => {
    const resolved = resolve(path, context);
    if (typeof resolved === 'object') throw new Error(`Template interpolation requires a scalar: ${path}`);
    return encode ? encodeURIComponent(String(resolved)) : String(resolved);
  });
  if (value.replace(token, '').includes('{{') || value.replace(token, '').includes('}}')) throw new Error('Malformed template');
  return rendered;
}

export function collectEnvNames(value, names = new Set()) {
  if (typeof value === 'string') {
    const token = new RegExp(tokenPattern.source, 'g');
    for (const match of value.matchAll(token)) if (match[1].startsWith('env.')) names.add(match[1].slice(4));
  } else if (Array.isArray(value)) {
    value.forEach(item => collectEnvNames(item, names));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(item => collectEnvNames(item, names));
  }
  return names;
}
