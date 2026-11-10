// Run locally and place these values in the hosting environment, never in Git.
const { generateVAPIDKeys } = require('web-push');
const { publicKey, privateKey } = generateVAPIDKeys();
process.stdout.write(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\n`);
