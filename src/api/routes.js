const apicache = require('apicache');
const domainService = require('../services/domainService');
const app = require('./server');

const cache = apicache.middleware;

app.get('/listrecordsdb', cache('5 minutes'), (req, res) => {
  domainService.getAllRecordsDBAPI(req, res);
});
app.get('/listrecords', cache('5 minutes'), (req, res) => {
  domainService.listDNSRecordsAPI(req, res);
});
