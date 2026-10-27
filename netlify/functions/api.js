const { EventEmitter } = require('node:events');
const { requestHandler } = require('../../server');

exports.handler = async function (event) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = event.httpMethod || 'GET';
    req.headers = event.headers || {};

    // Reconstruct original /api/... path + query string
    const rawPath = event.path || '/';
    const normalizedPath = rawPath.replace(/^\/\.netlify\/functions\/api/, '/api');
    const qs = event.rawQuery
      ? `?${event.rawQuery}`
      : event.queryStringParameters && Object.keys(event.queryStringParameters).length > 0
      ? '?' + new URLSearchParams(event.queryStringParameters).toString()
      : '';
    req.url = normalizedPath + qs;

    let statusCode = 200;
    const resHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
    const chunks = [];

    const res = {
      writeHead(code, headers = {}) {
        statusCode = code;
        Object.assign(resHeaders, headers);
      },
      setHeader(k, v) {
        resHeaders[k] = v;
      },
      write(chunk) {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
      },
      end(chunk) {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        resolve({
          statusCode,
          headers: resHeaders,
          body: Buffer.concat(chunks).toString('utf8')
        });
      }
    };

    Promise.resolve(requestHandler(req, res)).catch(err => {
      resolve({
        statusCode: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: err.message || 'Serverless function error' })
      });
    });

    // Emit request body for POST / PUT requests
    process.nextTick(() => {
      if (event.body) {
        const bodyStr = event.isBase64Encoded
          ? Buffer.from(event.body, 'base64').toString('utf8')
          : event.body;
        req.emit('data', Buffer.from(bodyStr, 'utf8'));
      }
      req.emit('end');
    });
  });
};
