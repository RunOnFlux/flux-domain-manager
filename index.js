const http = require('http');
const config = require('config');
const app = require('./src/lib/server');
const log = require('./src/lib/log');

const domainService = require('./src/services/domainService');

const server = http.createServer(app);

let { port } = config.server;
if (config.manageCertificateOnly) {
  port += 1;
}

server.listen(port, () => {
  log.info(`FDM listening on port ${port}!`);

  domainService.start();
  log.info('FDM services starting...');
});
