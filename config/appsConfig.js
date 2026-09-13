module.exports = {
  // Canaries. Each must be a long-lived app; one that expires or is cancelled
  // is skipped with an error log, not fatal. themok6 was a test app, cancelled 2026-09-12.
  mandatoryApps: ['explorer', 'web', 'paoverview'],
  ownersApps: [], // Will retrieve only apps of owners specified here
  whiteListedApps: [], // If there's app in the array, blacklisting will be ignore
  blackListedApps: ['Kadena', 'Kadena2', 'PresearchNode*', 'BrokerNode*', 'Folding*', 'corsanywhere'],
  minecraftApps: ['mcf', '*minecraft*', '*Minecraft*'],
};
