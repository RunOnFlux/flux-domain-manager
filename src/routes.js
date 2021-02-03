const apicache = require('apicache');
const domainService = require('./services/domainService');

const cache = apicache.middleware;

module.exports = (app) => {
  // GET methods
  app.get('/listrecordsdb', cache('5 minutes'), (req, res) => {
    domainService.getAllRecordsDBAPI(req, res);
  });
  app.get('/listrecords', cache('5 minutes'), (req, res) => {
    domainService.listDNSRecordsAPI(req, res);
  });
};
