const placements = require('./placement');

function buildBucketBackend(bucket, ips) {
  return `backend ${bucket}_backend
  mode http
  http-request set-header X-Forwarded-Host %[req.hdr(Host)]
${ips}`;
}

function getServerString(bucket, servers) {
  let serverString = '';
  let i = 0;
  // eslint-disable-next-line
  for (const server of servers) {
    serverString += `  server ${bucket}_${i}_server ${server} ssl check verify none\n`;
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
  acl letsencrypt-acl path_beg /.well-known/acme-challenge/
  redirect scheme https if !letsencrypt-acl

${acls}
${usebackends}

frontend wwwhttps
  bind *:443 ssl crt /etc/ssl/fluxapps/ ciphers kEECDH+aRSA+AES:kRSA+AES:+AES256:RC4-SHA:!kEDH:!LOW:!EXP:!MD5:!aNULL:!eNULL no-sslv3 alpn h2,http/1.1
  http-request add-header X-Forwarded-Proto http
  http-request set-header X-Forwarded-Host %[req.hdr(Host)]
${acls}
${usebackends}
${getBucketBackends()}
`;
}

module.exports = { getHAProxyConfig };
