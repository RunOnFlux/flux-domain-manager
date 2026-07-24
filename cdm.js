// The certificate role. Runs from its own checkout, as its own pm2 process, alongside
// FDM on the renewal primary — see deployment/fdm_setup.yml.
//
// It serves no HTTP. haproxy's pki-validation and API backends both target the routing
// process on config.server.port, ufw admits only 80/443/8787 from outside the box, and
// the two endpoints this role could answer are meaningless here: /appips reports routing
// state it never builds. Certificate work is driven entirely by its own timers.
const log = require('./src/lib/log');

const domainService = require('./src/services/domainService');

log.info('CDM services starting...');
domainService.startCertificates();
