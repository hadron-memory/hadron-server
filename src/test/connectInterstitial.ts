/**
 * Drive the connect interstitial (#2908) the way a browser does: GET the confirmation page, read the hidden
 * nonce and token off its form, POST them back. Returns the POST's response (not followed), so a caller asserts the
 * 302 to the provider or a refusal.
 */
export async function confirmConnect(connectUrl: string): Promise<Response> {
  const page = await fetch(connectUrl, { redirect: 'manual' });
  if (page.status !== 200) return page;
  const html = await page.text();
  const binding = /hadron_connect_bind=([0-9a-f]{32})/.exec(page.headers.get('set-cookie') ?? '')?.[1];
  const field = (name: string): string => {
    const m = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`).exec(html);
    if (!m) throw new Error(`confirmation page has no ${name} field`);
    return m[1];
  };
  return fetch(new URL(connectUrl).origin + new URL(connectUrl).pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(binding ? { cookie: `hadron_connect_bind=${binding}` } : {}),
    },
    body: new URLSearchParams({ nonce: field('nonce'), token: field('token') }),
    redirect: 'manual',
  });
}
