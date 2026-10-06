const status = document.getElementById('status');
try {
  const response = await fetch('/fixture');
  if (!response.ok) throw new Error('Fixture unavailable');
  const example = await response.json();
  for (const [id, value] of Object.entries({title: example.input.fields.title, content: example.input.fields.content, node: example.input.nodeId, payload: example.payloadUtf8, challenge: example.challengeHex})) {
    document.getElementById(id).textContent = value;
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(example.payloadUtf8));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== example.challengeHex) throw new Error('Browser challenge differs from S0');
  status.textContent = 'Payload digest matches S0. Passkey ceremony is not yet available.';
} catch (error) {
  status.textContent = `Preview failed: ${error.message}`;
}
