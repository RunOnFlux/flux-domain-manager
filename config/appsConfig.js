module.exports = {
  mandatoryApps: ['explorer', 'web', 'themok6', 'paoverview'],
  ownersApps: [], // Will retrieve only apps of owners specified here
  whiteListedApps: [], // If there's app in the array, blacklisting will be ignore
  blackListedApps: ['Kadena', 'Kadena2', 'PresearchNode*', 'BrokerNode*', 'Folding*', 'corsanywhere'],
  minecraftApps: ['mcf', '*minecraft*', '*Minecraft*'],
  // UDP/TCP game apps that should use direct DNS routing (bypass HAProxy for player traffic)
  // ONLY applies to G mode apps (apps with g: in containerData)
  // App names are matched case-insensitively with prefix matching
  // Games still appear in HAProxy for FluxOS primary/standby management
  udpGameApps: ['minecraft', 'palworld', 'enshrouded', 'rust', 'ark', 'valheim', 'terraria', 'satisfactory', 'conan', 'sevendays'],
};
