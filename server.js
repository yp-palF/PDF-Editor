// Tiny static file server for local use. It only serves files from this folder.
// It never receives your PDFs: all editing happens in the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT) || 8080;
const root = __dirname;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(root + path.sep) || file.includes(path.sep + 'node_modules' + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
})
  .on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`Port ${port} is already in use. Try another one, for example: PORT=8081 npm start`);
    process.exit(1);
  })
  .listen(port, () => console.log(`PDF Editor running at http://localhost:${port}`));
