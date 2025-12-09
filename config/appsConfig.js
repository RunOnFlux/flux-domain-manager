module.exports = {
  mandatoryApps: ['explorer', 'web', 'themok6', 'paoverview'],
  ownersApps: [], // Will retrieve only apps of owners specified here
  whiteListedApps: [], // If there's app in the array, blacklisting will be ignore
  blackListedApps: ['Kadena', 'Kadena2', 'PresearchNode*', 'BrokerNode*', 'Folding*', 'corsanywhere'],
  minecraftApps: ['mcf', '*minecraft*', '*Minecraft*'],
  // Game apps that should use direct DNS routing (bypass HAProxy for player traffic)
  // ONLY applies to G mode apps (apps with g: in containerData)
  // App names are matched case-insensitively with prefix matching
  // Games still appear in HAProxy for FluxOS primary/standby management

  /**
   *   Apps Matched by directDNSGameApps Configuration

  16 Apps Would Be Matched (based on current API data):

  Minecraft-related (8 apps):

  - Minecraft (v7)
  - MinecraftBedrock (v3)
  - minecraftflux (v7)
  - MinecraftPurePwnage (v5)
  - MinecraftServer1761055063053 (v8)
  - MinecraftServer1761414403629 (v8)
  - MinecraftServer1764070373039 (v8)

  Rust-related (5 apps):

  - Rust (v7)
  - RustDeskTestServer (v7) ⚠️ Not a game - remote
  desktop
  - rustpad (v4) ⚠️ Not a game - collaborative code
  editor
  - rustserver (v7)
  - rustserverNA (v7)

  Terraria-related (2 apps):

  - terraria (v6)
  - terrariaflux (v7)

  Other games (1 app):

  - ark (v6)
  - Valheim (v6)

  Not Found (4 game prefixes):

  - palworld - No apps starting with this prefix
  - enshrouded - No apps starting with this prefix
  - satisfactory - No apps starting with this prefix
  - conan - No apps starting with this prefix
  - sevendays - No apps starting with this prefix
   */

  // This is dangerous. Yes, it's gapps only - we should not be matching on app names though. It will have unindended
  // consequences.
  directDNSGameApps: ['minecraft', 'palworld', 'enshrouded', 'rust', 'ark', 'valheim', 'terraria', 'satisfactory', 'conan', 'sevendays'],
};
