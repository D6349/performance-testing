export function buildOptions(manifest) {
  const thresholds = { ...manifest.profile.thresholds };
  const active = [...new Set([...manifest.suite.steps, ...(manifest.suite.cleanup || [])].map(step => step.endpoint))];
  for (const id of active) {
    const endpoint = manifest.api.endpoints[id];
    thresholds[`http_req_duration{endpoint:${id}}`] = endpoint.thresholds?.duration || thresholds.http_req_duration || ['p(95)<500'];
    thresholds[`http_req_failed{endpoint:${id}}`] = endpoint.thresholds?.failed || ['rate<0.01'];
    if (manifest.suite.mode === 'journey') thresholds[`workflow_requests{endpoint:${id}}`] = ['count>0'];
  }
  return {
    scenarios: { api: { ...manifest.profile.scenario, exec: 'default' } },
    thresholds,
    insecureSkipTLSVerify: false,
    maxRedirects: 0,
    discardResponseBodies: true,
    throw: false,
    noCookiesReset: false,
    systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    tags: { environment: manifest.environment.name, profile: manifest.profile.name, suite: manifest.suite.name },
    userAgent: 'api-performance-testing/1.0'
  };
}
