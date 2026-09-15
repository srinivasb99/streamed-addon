'use strict';

const { createApp } = require('./index');

const PORT = process.env.PORT || 7000;

const app = createApp();
app.listen(PORT, () => {
  console.log(JSON.stringify({ msg: 'server_started', port: Number(PORT) }));
});
