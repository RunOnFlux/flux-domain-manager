const axios = require('axios');

async function getPolkaNetworkHeight() {
  try {
    const max = 1000000;
    const min = 1;

    const data = {
      jsonrpc: '2.0',
      method: 'system_syncState',
      params: [],
      id: Math.floor(Math.random() * (max - min + 1)) + min,
    };
    const AConfig = {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 3456,
    };
    const rosettaData = await axios.post('https://ksm.runonflux.io', data, AConfig);
    console.log(rosettaData.data.result);
  } catch (e) {
    console.log(e);
  }
}

getPolkaNetworkHeight();
