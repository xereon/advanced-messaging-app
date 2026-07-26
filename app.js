// app.js — startup file for cPanel's "Setup Node.js App" (Phusion Passenger).
//
// Passenger looks for a single entry file at the application root and sets
// PORT for the app to listen on. Everything else lives in server/; this file
// only starts it and makes a failure visible in the app's stderr log rather
// than as a bare 503.
//
// Running locally, `npm start` and `node app.js` are equivalent.

import { start } from './server/index.js';

start().catch((err) => {
  console.error('[relay] failed to start:', err);
  process.exit(1);
});
