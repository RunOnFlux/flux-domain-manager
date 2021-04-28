/* eslint-disable no-useless-escape */
/* eslint-disable no-restricted-syntax */
const haproxyPrefix = `
global
  log /dev/log    local0
  log /dev/log    local1 notice
  chroot /var/lib/haproxy
  stats socket /run/haproxy/admin.sock mode 660 level admin expose-fd listeners
  stats timeout 30s
  user haproxy
  group haproxy
  daemon

  # Default SSL material locations
  ca-base /etc/ssl/certs
  crt-base /etc/ssl/private

  # Default ciphers to use on SSL-enabled listening sockets.
  # For more onlinermation, see ciphers(1SSL). This list is from:
  #  https://hynek.me/articles/hardening-your-web-servers-ssl-ciphers/
  ssl-default-bind-ciphers ECDH+AESGCM:DH+AESGCM:ECDH+AES256:DH+AES256:ECDH+AES128:DH+AES:ECDH+3DES:DH+3DES:RSA+AESGCM:RSA+AES:RSA+3DES:!aNULL:!MD5:!DSS
  ssl-default-bind-options no-sslv3

defaults
  log     global
  mode    http
  option  httplog
  option  dontlognull
  timeout connect 5000
  timeout client  50000
  timeout server  50000
  errorfile 400 /etc/haproxy/errors/400.http
  errorfile 403 /etc/haproxy/errors/403.http
  errorfile 408 /etc/haproxy/errors/408.http
  errorfile 500 /etc/haproxy/errors/500.http
  errorfile 502 /etc/haproxy/errors/502.http
  errorfile 503 /etc/haproxy/errors/503.http
  errorfile 504 /etc/haproxy/errors/504.http

frontend wwwhttp
  bind *:80
  option forwardfor except 127.0.0.0/8
  reqadd X-Forwarded-Proto:\\ http

  acl letsencrypt-acl path_beg /.well-known/acme-challenge/
  redirect scheme https if !letsencrypt-acl
  use_backend letsencrypt-backend if letsencrypt-acl
`;

const httpsPrefix = `
frontend wwwhttps
  option httplog
  option http-server-close
  option forwardfor except 127.0.0.0/8

  # stats in /fluxstatistics publicly available
  stats enable
  stats hide-version
  stats uri     /fluxstatistics
  stats realm   Flux\\ Statistics

  # The SSL CRT file is a combination of the public certificate and the private key
`;

const certificatePrefix = '  bind *:443 ssl ';

const certificatesSuffix = 'ciphers kEECDH+aRSA+AES:kRSA+AES:+AES256:RC4-SHA:!kEDH:!LOW:!EXP:!MD5:!aNULL:!eNULL no-sslv3';

const letsEncryptBackend = `
backend letsencrypt-backend
  server letsencrypt 127.0.0.1:8787
`;

function createCertificatesPaths(urls) {
  let path = '';
  urls.forEach((url) => {
    path += `crt /etc/ssl/${url}/${url}.pem `;
  });
  return path;
}

function generateHaproxyConfig(acls, usebackends, urls, backends, redirects) {
  return `${haproxyPrefix}\n\n${acls}\n${usebackends}\n${redirects}\n${httpsPrefix}${certificatePrefix}${createCertificatesPaths(urls)}${certificatesSuffix}\n\n${acls}\n${usebackends}\n${redirects}\n\n${backends}\n${letsEncryptBackend}`;
}

function removeDots( str ) {
	return str.replace( /\./g, '' );
}

function normalizeIP( sparseIP ){
	const leadingZeros = (str) => {
		while ( str.length < 3 ) str = '0' + str;
		return str;
	};

	if ( !sparseIP ){
		console.error( 'normalizeIP: invalid or missing ip!');
		return sparseIP;
	}

	const fields = sparseIP.split('.');
	return fields.map( (field) => leadingZeros(field) ).join('');	// CHECK: shouldn't this be joined with a '.'?
}

function createBackendString( backend, time = '1h' ){
	return `backend ${backend}backend
	mode http
	balance source
	hash-type consistent
	stick-table type ip size 1m expire ${time}
	stick on src`;
}

function createMainHaproxyConfig(ui, api, fluxIPs) {
  const uiB = removeDots( ui );
  const uiPort = 16126;
  let uiBackend = createBackendString( uiB, '8h' );
  for (const ip of fluxIPs) {
	  const normalizedIP = normalizeIP( ip );
	  uiBackend += `\n  server ${normalizedIP} ${ip}:${uiPort} check`;
  }

  // console.log(uiBackend);
  const apiB = removeDots( api );
  const apiPort = 16127;
  let apiBackend = createBackendString( apiB, '8h' );
  for (const ip of fluxIPs) {
	  const normalizedIP = normalizeIP( ip );
	  apiBackend += `\n  server ${normalizedIP} ${ip}:${apiPort} check`;
  }
  // console.log(apiBackend);

  const redirects = `  http-request redirect code 301 location https://home.runonflux.io/dashboard if { hdr(host) -i dashboard.zel.network }\n
  http-request redirect code 307 location https://zel.network%[capture.req.uri] if mainAcl\n\n`;
  const uiAcl = `  acl ${uiB} hdr(host) ${ui}\n`;
  const apiAcl = `  acl ${apiB} hdr(host) ${api}\n`;
  const mainAcl = '  acl mainAcl hdr(host) runonflux.io\n';
  const uiBackendUse = `  use_backend ${uiB}backend if ${uiB}\n`;
  const apiBackendUse = `  use_backend ${apiB}backend if ${apiB}\n`;

  const acls = uiAcl + apiAcl + mainAcl;
  const usebackends = uiBackendUse + apiBackendUse;

  const backends = `${uiBackend}\n\n${apiBackend}`;
  const urls = [ui, api, 'runonflux.io', 'dashboard.zel.network'];

  return generateHaproxyConfig(acls, usebackends, urls, backends, redirects);
}

function createMainAppHaproxyConfig(domainA, domainB, fluxIPs, portA, portB) {
  const domainAused = removeDots( domainA );
  let domainAbackend = createBackendString( domainAused, '1h' );
  for (const ip of fluxIPs) {
	  const normalizedIP = normalizeIP( ip );
	  domainAbackend += `\n  server ${normalizedIP} ${ip}:${portA} check`;
  }
  // console.log(domainAbackend);

  const domainBused = removeDots( domainB );
  let apiBackend = createBackendString( domainBused, '1h' );
  for (const ip of fluxIPs) {
	  const normalizedIP = normalizeIP( ip );
	  apiBackend += `\n  server ${normalizedIP} ${ip}:${portB} check`;
  }
  // console.log(apiBackend);

  const redirects = '';
  const domainAAcl = `  acl ${domainAused} hdr(host) ${domainA}\n`;
  const domainBAcl = `  acl ${domainBused} hdr(host) ${domainB}\n`;
  const domainABackendUse = `  use_backend ${domainAused}backend if ${domainAused}\n`;
  const domainBBackendUse = `  use_backend ${domainBused}backend if ${domainBused}\n`;

  const acls = domainAAcl + domainBAcl;
  const usebackends = domainABackendUse + domainBBackendUse;

  const backends = `${domainAbackend}\n\n${apiBackend}`;
  const urls = [domainA, domainB];

  return generateHaproxyConfig(acls, usebackends, urls, backends, redirects);
}

function createMainAppKadenaHaproxyConfig(domainA, domainB, fluxIPs, portA, portB) {
  const domainAused = removeDots( domainA );
  let domainAbackend = createBackendString( domainAused, '1h' );
  for (const ip of fluxIPs) {
	const normalizedIP = normalizeIP( ip );
   domainAbackend += `\n  server ${normalizedIP} ${ip}:${portA} check ssl verify none`;
  }
  // console.log(domainAbackend);

  const domainBused = removeDots( domainB );
  let apiBackend = createBackendString( domainBused, '1h' );
  for (const ip of fluxIPs) {
	  const normalizedIP = normalizeIP( ip );
	  apiBackend += `\n  server ${normalizedIP} ${ip}:${portB} check`;
  }
  // console.log(apiBackend);

  const redirects = '';
  const domainAAcl = `  acl ${domainAused} hdr(host) ${domainA}\n`;
  const domainBAcl = `  acl ${domainBused} hdr(host) ${domainB}\n`;
  const chainwebAcl = '  acl chainweb path_beg /chainweb/0.0/mainnet01/cut\n';
  const defaultBackend = `  default_backend ${domainBused}backend\n`;
  const domainABackendUse = `  use_backend ${domainAused}backend if ${domainAused}\n`;
  const domainBBackendUse = `  use_backend ${domainBused}backend if ${domainBused}\n`;
  const chainwebBackendUse = `  use_backend ${domainAused}backend if chainweb\n`;

  const acls = domainAAcl + domainBAcl + chainwebAcl;
  const usebackends = defaultBackend + domainABackendUse + domainBBackendUse + chainwebBackendUse;

  const backends = `${domainAbackend}\n\n${apiBackend}`;
  const urls = [domainA, domainB, 'kadena.app.runonflux.io', 'kadenachainwebnode.app.runonflux.io'];

  return generateHaproxyConfig(acls, usebackends, urls, backends, redirects);
}

module.exports = {
  createMainHaproxyConfig,
  createMainAppHaproxyConfig,
  createMainAppKadenaHaproxyConfig,
};
