import { createForwarder } from './forwarder.mjs';
const [port, address] = process.argv.slice(2);
createForwarder(address, Number(port)).listen(Number(port), '127.0.0.1');
