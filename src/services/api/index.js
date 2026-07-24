const serviceHelper = require('../serviceHelper');
const log = require('../../lib/log');
const domainService = require('../domainService');
const { parseSocketAddress, unbracket } = require('../socketAddress');

async function pkiValidation(req, res) {
  try {
    let { id } = req.params;
    id = id || req.query.id;
    console.log(id);
    res.send('ca3-b1970edefd4c4eacb7a7b70c41fc433e');
  } catch (error) {
    res.status(404).send('Not found!');
  }
}

function getAppIpsAPI(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      const errMessage = serviceHelper.createErrorMessage('appname parameter is required', 'ValidationError', 400);
      return res.status(400).json(errMessage);
    }

    const appNameLower = appname.toLowerCase();
    const {
      activeActiveRouteConfigs, activeStandbyRouteConfigs, activeActiveAppsInitialized, activeStandbyAppsInitialized,
    } = domainService.getRouteConfigs();

    if (!activeActiveAppsInitialized || !activeStandbyAppsInitialized) {
      const errMessage = serviceHelper.createErrorMessage(
        'Service is starting up - initial application processing has not completed yet',
        'ServiceUnavailable',
        503,
      );
      return res.status(503).json(errMessage);
    }

    const allRouteConfigs = serviceHelper.concatIterables(activeActiveRouteConfigs, activeStandbyRouteConfigs);

    const matchingApps = allRouteConfigs.filter((routeConfig) => routeConfig.name.toLowerCase() === appNameLower);

    if (matchingApps.length === 0) {
      const errMessage = serviceHelper.createErrorMessage(`App '${appname}' not found in HAProxy configuration`, 'NotFoundError', 404);
      return res.status(404).json(errMessage);
    }

    // The route configs hold socket addresses; this endpoint reports the hosts. The
    // response field stays `ips` — FluxOS reads it to elect the active-standby master.
    const uniqueHosts = [...new Set(matchingApps.flatMap(
      (app) => app.ips.map((socketAddress) => unbracket(parseSocketAddress(socketAddress).host)),
    ))];

    const resMessage = serviceHelper.createDataMessage({
      appName: matchingApps[0].name,
      ips: uniqueHosts,
      count: uniqueHosts.length,
    });
    return res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
    return res.status(500).json(errMessage);
  }
}

module.exports = {
  pkiValidation,
  getAppIpsAPI,
};
