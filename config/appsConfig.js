module.exports = {
  mandatoryApps: ['explorer', 'web', 'themok6', 'paoverview', 'eckodexswap'],
  ownersApps: [], // Will retrieve only apps of owners specified here
  whiteListedApps: [], // If there's app in the array, blacklisting will be ignore
  blackListedApps: ['Kadena', 'Kadena2', 'PresearchNode*', 'BrokerNode*', 'Folding*'],
  minecraftApps: ['mcf', '*minecraft*', 'Minecraft*', 'privateminecraft*'],
};
