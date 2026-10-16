const status = document.getElementById('status');
const post = async (url, body) => {
  const response = await fetch(url.replace(/^\//, ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const request = async (url, body) => {
  const result = await post(url, body);
  if (result.status !== 200) throw new Error(result.body.code);
  return result.body;
};
const api = window.spike = { ready: false, post, request,
  assertion: options => window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options }),
  async register() {
    const options = await request('/registration/options', {});
    const response = await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options.options });
    return request('/registration/verify', { id: options.id, response });
  },
  async sign() {
    const options = await request('/authentication/options', {});
    const response = await api.assertion(options.options);
    return request('/authentication/verify', { id: options.id, response });
  },
};
try {
  const configResponse = await fetch('config');
  if (!configResponse.ok) throw new Error('Timing configuration unavailable');
  const config = await configResponse.json();
  const duration = seconds => seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
  document.getElementById('pairing-lifetime').textContent = duration(config.pairingTtlSeconds);
  for (const el of document.querySelectorAll('.session-lifetime')) el.textContent = duration(config.sessionTtlSeconds);
  const response = await fetch('fixture');
  if (!response.ok) throw new Error('Fixture unavailable');
  const example = api.fixture = await response.json();
  for (const [id, value] of Object.entries({ title: example.input.fields.title, content: example.input.fields.content, node: example.input.nodeId, payload: example.payloadUtf8, challenge: example.challengeHex })) document.getElementById(id).textContent = value;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(example.payloadUtf8));
  const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== example.challengeHex) throw new Error('Browser challenge differs from S0');
  api.ready = true;
  status.textContent = 'Payload digest matches S0. Register a local credential, then sign.';
  for (const [id, action] of [['register', () => api.register()], ['sign', () => api.sign()]]) {
    const button = document.getElementById(id); button.disabled = false;
    button.onclick = async () => {
      button.disabled = true;
      try { status.textContent = JSON.stringify({providerDeclared:provider.value,...await action()}, null, 2); }
      catch (error) { status.textContent = `Refused: ${error.message}`; }
      finally { button.disabled = false; }
    };
  }
} catch (error) { status.textContent = `Spike failed: ${error.message}`; }

const provider = document.getElementById('provider');
document.getElementById('pair').onclick = async () => {
  try { status.textContent = JSON.stringify(await request('/pairing/options',{}),null,2); }
  catch(e) { status.textContent = e.message; }
};
document.getElementById('join').onclick = async () => {
  try { status.textContent = JSON.stringify(await request('/pairing/join',{code:document.getElementById('pair-code').value.trim()})); }
  catch(e) { status.textContent = e.message; }
};
