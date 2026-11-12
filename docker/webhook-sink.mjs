import { createServer } from 'node:http';

const port = 8080;

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => {
    chunks.push(chunk);
  });
  request.on('end', () => {
    process.stdout.write(`${Buffer.concat(chunks).toString('utf8')}\n`);
    response.writeHead(204);
    response.end();
  });
});

server.listen(port, '0.0.0.0');
