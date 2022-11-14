const config = require('config');
const serviceHelper = require('./serviceHelper');
const ipService = require('./ipService');
const log = require('../lib/log');

class DomainService {
  constructor(dnsClients, configGeneratorFunc) {
    this.myIP = null;
    this.myFDMnameORip = null;
    this.db = null;
    this.mandatoryApps = ['explorer', 'KDLaunch', 'website', 'Kadena3', 'Kadena4'];
    this.dnsClients = [];
    this.configGeneratorFunc = configGeneratorFunc;
  }

  async initializeServices() {
    this.myIP = await ipService.localIP();
    console.log(this.myIP);
    if (config.domainAppType === 'CNAME') {
      this.myFDMnameORip = config.fdmAppDomain;
    } else {
      this.myFDMnameORip = this.myIP;
    }
    if (this.myIP) {
      if (config.mainDomain !== config.pDNS.domain && config.mainDomain !== config.cloudflare.domain) {
        log.info('CUSTOM DOMAIN SERVICE UNAVAILABLE');
        return;
      }
      if (!config.cloudflare.manageapp) {
        generateAndReplaceMainHaproxyConfig();
        log.info('Flux Main Node Domain Service initiated.');
      } else {
        // only runs on main FDM handles X.APP.runonflux.io
        generateAndReplaceMainApplicationHaproxyConfig();
        log.info('Flux Main Application Domain Service initiated.');
      }
    } else {
      log.warn('Awaiting FDM IP address...');
      setTimeout(() => {
        initializeServices();
      }, 5 * 1000);
    }
  }
}

module.exports = DomainService;
