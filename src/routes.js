const apicache = require('apicache');
const apiService = require('./services/api');

const cache = apicache.middleware;

module.exports = (app) => {
  // GET methods
  app.get('/.well-known/pki-validation/:id?', cache('5 minutes'), (req, res) => {
    apiService.pkiValidation(req, res);
  });
  app.get('/appips/:appname?', cache('20 seconds'), (req, res) => {
    apiService.getAppIpsAPI(req, res);
  });
};
