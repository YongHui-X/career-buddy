import http from 'node:http';
import { isMainModule } from '../lib/is-main-module.mjs';

const form = (scenario, body, action = '/receipt') => `<!doctype html><html><head><title>Acme - Software Engineer</title></head><body data-scenario="${scenario}"><h1>Software Engineer at Acme</h1><form method="post" action="${action}">${body}<button type="submit">Submit application</button></form></body></html>`;
const baseFields = '<label>Full name <input name="name" required></label><label>Email <input type="email" name="email" required></label><label>Resume <input type="file" name="resume" required></label>';

export function fixtureHtml(pathname) {
  if (['/greenhouse', '/lever', '/ashby', '/workable'].includes(pathname)) return form(pathname.slice(1), baseFields);
  if (pathname === '/workday') return form('workday', `<section id="step1">${baseFields}<button type="button" id="next">Next</button></section><section id="step2" hidden><label>Motivation <textarea required></textarea></label></section><script>next.onclick=()=>{step1.hidden=true;step2.hidden=false}</script>`);
  if (pathname === '/captcha') return form('captcha', `${baseFields}<div class="g-recaptcha">Verify you are human</div>`);
  if (pathname === '/mfa') return '<h1>Verification code</h1><input autocomplete="one-time-code">';
  if (pathname === '/login') return '<h1>Sign in</h1><input type="password">';
  if (pathname === '/attestation') return form('attestation', `${baseFields}<label><input type="checkbox" required>I certify that this information is true</label>`);
  if (pathname === '/unknown-required') return form('unknown-required', `${baseFields}<label>Unfamiliar required response <input required></label>`);
  if (pathname === '/failed-upload') return form('failed-upload', '<label>Resume <input type="file" required disabled></label>');
  if (pathname === '/validation') return form('validation', `${baseFields}<div role="alert">This field is required</div>`);
  if (pathname === '/ambiguous') return form('ambiguous', baseFields, '/ambiguous-result');
  if (pathname === '/receipt') return '<title>Application submitted</title><h1>Thank you for your application</h1>';
  if (pathname === '/ambiguous-result') return '<title>Acme careers</title><p>Your profile was saved.</p>';
  return null;
}

export async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://fixture').pathname;
    if (pathname === '/redirect') { res.writeHead(302, { location: '/greenhouse' }); res.end(); return; }
    const html = fixtureHtml(pathname);
    if (!html) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

// Hand-rolled `file://${process.argv[1]}` comparisons silently no-op through a
// symlinked checkout (#3170), which is why tests/main-guard-convention.test.mjs
// forbids them. Use the shared helper.
if (isMainModule(import.meta.url)) {
  const { baseUrl } = await startFixtureServer();
  console.log(`automation fixture server: ${baseUrl}`);
}
