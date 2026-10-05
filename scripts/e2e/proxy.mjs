import { createForwarder } from './forwarder.mjs';
// Disposable fixture convenience: this hop makes requests loopback-local to
// dev-login. In Incus it also admits peers on the private QA bridge. Never
// use this proxy in a deployed environment or with real user data.
createForwarder('127.0.0.1', 4000).listen(4100, '0.0.0.0');
