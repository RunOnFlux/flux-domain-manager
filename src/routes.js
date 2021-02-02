const apicache = require('apicache');
const domainService = require('./services/domainService');

const cache = apicache.middleware;

module.exports = (app) => {
  // GET methods
  app.get('/getrecordsdb', cache('5 minutes'), (req, res) => {
    domainService.getAllRecordsDB(req, res);
  });
};
