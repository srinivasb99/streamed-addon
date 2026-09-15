'use strict';

const { createApp } = require('./index');
const { closeAll } = require('../streaming/hls-resolver');

const PORT = process.env.PORT || 7000;

const app = createApp();
const server = app.listen(PORT, () => {
  console.log(JSON.stringify({ msg: 'server_started', port: Number(PORT) }));
});

async function shutdown() {
  server.close();
  await closeAll();
  process.exit(0);
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
