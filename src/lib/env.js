// Runtime configuration and OS control variables cannot double as API secrets.
const controlPrefixes = /^(?:K6_|PERF_|NODE_|LD_|DYLD_|CGO_|XDG_)/i;
const controlNames = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SSLKEYLOGFILE',
  'GODEBUG', 'GOMAXPROCS', 'GOMEMLIMIT', 'GOTRACEBACK', 'GOTMPDIR',
  'GOCACHE', 'GOPATH', 'GOROOT', 'GOFLAGS'
]);
export function isRuntimeControlEnvName(name) {
  return typeof name !== 'string' || controlPrefixes.test(name) || controlNames.has(name.toUpperCase());
}
