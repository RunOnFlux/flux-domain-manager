const apicache = require('apicache');
const apiService = require('./services/api');

const cache = apicache.middleware;

module.exports = (app) => {
  // GET methods
  app.get('/listrecordsdb', cache('5 minutes'), (req, res) => {
    apiService.getAllRecordsDBAPI(req, res);
  });
  app.get('/listrecords', cache('5 minutes'), (req, res) => {
    apiService.listDNSRecordsAPI(req, res);
  });
  app.get('/.well-known/pki-validation/:id?', cache('5 minutes'), (req, res) => {
    apiService.pkiValidation(req, res);
  });
};
