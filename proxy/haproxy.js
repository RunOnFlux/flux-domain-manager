const placements = require('./placement');

function buildBucketBackend(bucket, ips) {
  return `backend ${bucket}_backend
  mode http
${ips}`;
}

function getServerString(bucket, servers) {
  let serverString = '';
  let i = 0;
  // eslint-disable-next-line
  for (const server of servers) {
    serverString += `  server ${bucket}_${i}_server ${server} check\n`;
    i += 1;
  }
  return serverString;
}

function getBucketBackends() {
  const { config } = placements;
  let backends = '';
  // eslint-disable-next-line
  for (const bucket of Object.keys(config)) {
    const servers = getServerString(bucket, config[bucket]);
    backends += `${buildBucketBackend(bucket, servers)}\n`;
  }
  return backends;
}

function getHAProxyConfig(acls, usebackends) {
  return `
global
  maxconn 50000
  log /dev/log    local0
  log /dev/log    local1 notice
  chroot /var/lib/haproxy
  stats socket /run/haproxy/admin.sock mode 660 level admin expose-fd listeners
  stats timeout 30s
  user haproxy
  group haproxy
  daemon

defaults
  log     global
  mode    http
  option  httplog
  option  dontlognull
  timeout connect 5000
  timeout client  50000
  timeout server  50000
  maxconn 50000

frontend wwwhttp
  bind *:80
  option forwardfor except 127.0.0.0/8
  http-request add-header X-Forwarded-Proto http
  http-request set-header X-Forwarded-Host %[req.hdr(Host)]

${acls}
${usebackends}

frontend wwwhttps
  bind *:443
  http-request add-header X-Forwarded-Proto http
  http-request set-header X-Forwarded-Host %[req.hdr(Host)]
${acls}
${usebackends}
${getBucketBackends()}
`;
}

module.exports = { getHAProxyConfig };
