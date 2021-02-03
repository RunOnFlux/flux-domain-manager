const http = require('http');
const config = require('config');
const app = require('./src/lib/server');
const log = require('./src/lib/log');

const server = http.createServer(app);

server.listen(config.server.port, () => {
  log.info(`FDM listening on port ${config.server.port}!`);
});
