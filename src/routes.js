const apicache = require('apicache');
const apiService = require('./services/api');
const CacheService = require('./lib/cache');

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

  app.get('/applications', (req, res) => {
    const applications = CacheService.getApplications();
    res.render('applications', { applications });
  });
  app.get('/applications/raw', (req, res) => {
    const applications = CacheService.getApplications();
    res.json(applications);
  });
};
