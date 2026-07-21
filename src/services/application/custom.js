// Per-app HAProxy tuning. buildDefaultConfig carries the name-driven overrides
// (protocol, TLS, health checks); the per-route rules — keyed
// {hostPort}.{component}.{app} — live in config (config/customConfigs.json).
// resolveCustomConfig is version-blind: it keys off resolved names and host ports,
// so legacy and v9 routes look up the same rules (legacy specs simply match none
// and fall to the default).
const config = require('config');

function buildDefaultConfig(name, isActiveStandby) {
  const defaultConfig = {
    ssl: false,
    timeout: false,
    headers: false,
    loadBalance: false,
    healthcheck: [],
    serverConfig: '',
    enableH2: false,
    mode: 'http',
    check: true,
  };

  const lower = name.toLowerCase();

  if (lower.includes('wordpress')) {
    defaultConfig.headers = ['http-request add-header X-Forwarded-Proto https'];
    defaultConfig.healthcheck = ['option httpchk', 'http-check send meth GET uri /'];
  }
  if (lower.includes('bittensor')) {
    defaultConfig.mode = 'tcp';
  }
  if (lower.includes('trilium')) {
    defaultConfig.ssl = true;
  }
  if (lower.includes('whooglessl')) {
    defaultConfig.ssl = true;
  }
  if (lower.startsWith('kaspanode') || lower.startsWith('kaspatestnet')) {
    defaultConfig.mode = 'tcp';
  }
  if (lower.includes('devstack')) {
    defaultConfig.mode = 'tcp';
  }
  if (isActiveStandby) {
    defaultConfig.mode = 'tcp';
    defaultConfig.check = false;
  }

  return defaultConfig;
}

// The tuning for one route, keyed {hostPort}.{component}.{app}: the name-driven
// default with any matching per-route rule merged on top.
function resolveCustomConfig(name, componentName, port, isActiveStandby) {
  const defaultConfig = buildDefaultConfig(name, isActiveStandby);
  const rule = config.customConfigs[`${port}.${componentName}.${name}`];
  return rule ? { ...defaultConfig, ...rule } : defaultConfig;
}

// Legacy positional projection — one config per port in compose order, plus a
// trailing main-domain config. Kept for the characterization net; the routing
// path uses resolveCustomConfig directly.
function getCustomConfigs(specifications, isActiveStandby) {
  const configs = [];
  let mainPort = '';
  const merge = (key) => {
    const rule = config.customConfigs[key];
    const defaultConfig = buildDefaultConfig(specifications.name, isActiveStandby);
    return rule ? { ...defaultConfig, ...rule } : defaultConfig;
  };

  if (specifications.version <= 3) {
    for (let i = 0; i < specifications.ports.length; i += 1) {
      const portName = `${specifications.ports[i]}.${specifications.name}`;
      if (i === 0) {
        mainPort = portName;
      }
      configs.push(merge(portName));
    }
  } else {
    // eslint-disable-next-line no-restricted-syntax
    for (const component of specifications.compose) {
      for (let i = 0; i < component.ports.length; i += 1) {
        configs.push(resolveCustomConfig(specifications.name, component.name, component.ports[i], isActiveStandby));
      }
    }
  }
  configs.push(merge(mainPort));
  return configs;
}

module.exports = {
  getCustomConfigs,
  resolveCustomConfig,
  buildDefaultConfig,
};
