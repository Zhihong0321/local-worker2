// A local contact-form site for tests: 127.0.0.1 only, so no real company is contacted.
import http from 'node:http';

export const FORM = `<!doctype html><html><head><title>Contact</title></head><body><h1>Contact us</h1>
<form action="/send" method="post">
  <label for="n">Your name</label><input id="n" type="text" name="name" required>
  <label for="e">Email address</label><input id="e" type="email" name="email" required>
  <label for="m">Message</label><textarea id="m" name="message" required></textarea>
  <button type="submit">Send message</button>
</form></body></html>`;

/** Serves the form on GET /, records each POST /send body and answers with a thank-you page. */
export function startSite() {
  const posts = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/send') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        posts.push(body);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body><p>Thank you for contacting us. We will get back to you.</p></body></html>');
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FORM);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not here');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, posts, url: `http://127.0.0.1:${server.address().port}/`,
  })));
}
