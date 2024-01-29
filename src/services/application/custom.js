function getCustomConfigs(specifications) {
  const configs = [];
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

  if (specifications.name.toLowerCase().includes('wordpress')) {
    defaultConfig.headers = ['http-request add-header X-Forwarded-Proto https'];
    defaultConfig.healthcheck = ['option httpchk', 'http-check send meth GET uri /'];
  }

  if (specifications.name.toLowerCase().includes('bittensor')) {
    defaultConfig.mode = 'tcp';
  }
  if (specifications.name.toLowerCase().includes('palworld')) {
    defaultConfig.mode = 'tcp';
    defaultConfig.check = false;
  }
  if (specifications.name.toLowerCase().includes('enshrouded')) {
    defaultConfig.mode = 'tcp';
    defaultConfig.check = false;
  }

  const customConfigs = {
    '31350.kmdsapactapi.kmdsapactapi': {
      ssl: true,
      healthcheck: ['option httpchk', 'http-check send meth GET uri /health', 'http-check expect status 200'],
      serverConfig: 'port 31352 inter 30s fall 2 rise 2',
    },
    '31351.kmdsapactapi.kmdsapactapi': {
      timeout: 90000,
      loadBalance: '\n  balance roundrobin',
      healthcheck: ['option httpchk', 'http-check send meth GET uri /health', 'http-check expect status 200'],
      serverConfig: 'port 31352 inter 30s fall 2 rise 2',
    },
    '31352.kmdsapactapi.kmdsapactapi': {
      healthcheck: ['option httpchk', 'http-check send meth GET uri /health', 'http-check expect status 200'],
      serverConfig: 'inter 30s fall 2 rise 2',
    },
    '31350.KadefiPactAPI.KadefiMoneyPactAPI': {
      ssl: true,
      healthcheck: ['option httpchk', 'http-check send meth GET uri /health', 'http-check expect status 200'],
      serverConfig: 'port 31352 inter 30s fall 2 rise 2',
    },
    '31351.KadefiPactAPI.KadefiMoneyPactAPI': {
      timeout: 90000,
      loadBalance: '\n  balance roundrobin',
      healthcheck: ['option httpchk', 'http-check send meth GET uri /health', 'http-check expect status 200'],
      serverConfig: 'port 31352 inter 30s fall 2 rise 2',
    },
    '31352.KadenaChainWebData.Kadena3': {
      timeout: 90000,
      loadBalance: '\n  balance roundrobin',
    },
    '31352.KadefiPactAPI.KadefiMoneyPactAPI': {
      healthcheck: ['option httpchk', 'http-check send meth GET uri /health', 'http-check expect status 200'],
      serverConfig: 'inter 30s fall 2 rise 2',
    },
    '33952.wp.wordpressonflux': {
      headers: ['http-request add-header X-Forwarded-Proto https'],
    },
    '36117.KadefiMoneyUDFServer.KadefiMoneyUDFServer': {
      healthcheck: ['option httpchk', 'http-check send meth GET uri /health', 'http-check expect status 200'],
      serverConfig: 'inter 30s fall 2 rise 2',
    },
    '33016.kmdsaudfserver.kmdsaudfserver': {
      healthcheck: ['option httpchk', 'http-check send meth GET uri /health', 'http-check expect status 200'],
      serverConfig: 'inter 30s fall 2 rise 2',
    },
    '39185.insightfluxexplorer.explorer': {
      loadBalance: '\n  balance roundrobin',
    },
    '8332.btcnode.bitcoinnode': {
      mode: 'tcp',
    },
    '18332.btcnodetestnet.bitcoinnodetestnet': {
      mode: 'tcp',
    },
    '38332.btcnodesignet.bitcoinnodesignet': {
      mode: 'tcp',
    },
    '992.vpn.openvpn': {
      mode: 'tcp',
    },
    '5555.vpn.openvpn': {
      mode: 'tcp',
    },
    '1701.vpn.openvpn': {
      mode: 'tcp',
    },
    '31750.node.HavenNodeMainnet': {
      ssl: true,
    },
    '27015.Palworld.Palworld': {
      mode: 'tcp',
    },
    '8211.Palworld.Palworld': {
      mode: 'tcp',
    },
  };

  let mainPort = '';
  if (specifications.version <= 3) {
    for (let i = 0; i < specifications.ports.length; i += 1) {
      const portName = `${specifications.ports[i]}.${specifications.name}`;
      if (i === 0) {
        mainPort = portName;
      }
      const appCustomConfig = customConfigs[portName] ? ({ ...defaultConfig, ...customConfigs[portName] }) : defaultConfig;
      configs.push(appCustomConfig);
    }
  } else {
    // eslint-disable-next-line no-restricted-syntax
    for (const component of specifications.compose) {
      for (let i = 0; i < component.ports.length; i += 1) {
        const portName = `${component.ports[i]}.${component.name}.${specifications.name}`;
        const appCustomConfig = customConfigs[portName] ? ({ ...defaultConfig, ...customConfigs[portName] }) : defaultConfig;
        configs.push(appCustomConfig);
      }
    }
  }
  const appCustomConfig = customConfigs[mainPort] ? ({ ...defaultConfig, ...customConfigs[mainPort] }) : defaultConfig;
  configs.push(appCustomConfig);
  return configs;
}

module.exports = {
  getCustomConfigs,
};
