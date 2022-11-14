const http = require('http');
const config = require('config');
const app = require('./src/api/server');
const log = require('./src/lib/log');

const domainService = require('./src/services/domainService');

const server = http.createServer(app);

server.listen(config.server.port, () => {
  log.info(`FDM listening on port ${config.server.port}!`);

  domainService.start();
  log.info('FDM services starting...');
});
