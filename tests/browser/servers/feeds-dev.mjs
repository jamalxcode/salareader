// Feeds for t16: /eng gives the same 5 stories with new guids on every fetch; /same-link has 3 episodes on one page.
import http from 'node:http';
let n = 0;
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/rss+xml', 'access-control-allow-origin': '*' });
  if (req.url.startsWith('/same-link')) {
    return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Comic</title><link>http://localhost:8767/</link>${[1, 2, 3].map((i) => `<item><title>Episode ${i}</title><link>http://localhost:8767/comic</link><guid>ep-${i}</guid><pubDate>Mon, 0${i} Nov 2026 08:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`);
  }
  n++;
  res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Engadget-like</title><link>http://localhost:8767/</link>${[1, 2, 3, 4, 5].map((i) => `<item><title>Story ${i}</title><link>http://localhost:8767/story/${i}</link><guid isPermaLink="false">g-${n}-${i}</guid><pubDate>Sun, 01 Nov 2026 0${i}:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`);
}).listen(8767);
