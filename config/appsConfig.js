module.exports = {
  // Canaries for the app balancers' config pass. Each must be a long-lived app;
  // one that is not registered on the network is skipped with an error log.
  mandatoryApps: ['explorer', 'paoverview'],
  ownersApps: [], // Will retrieve only apps of owners specified here
  whiteListedApps: [], // If there's app in the array, blacklisting will be ignore
  blackListedApps: ['Kadena', 'Kadena2', 'PresearchNode*', 'BrokerNode*', 'Folding*', 'corsanywhere'],
  minecraftApps: ['mcf', '*minecraft*', '*Minecraft*'],
};
