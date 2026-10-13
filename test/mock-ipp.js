// Minimal IPP printer for tests: parses a Print-Job request (RFC 8011), stores the document
// as <outDir>/printed.pdf and the parsed request as <outDir>/job.json, and answers successful-ok.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');

function parseRequest(buf) {
  let o = 8; const attrs = {};
  for (;;) {
    const tag = buf[o];
    if (tag === 3) { o++; break; } // end-of-attributes
    if (tag < 0x10) { o++; continue; } // delimiter (group) tag
    const nameLen = buf.readUInt16BE(o + 1), name = buf.subarray(o + 3, o + 3 + nameLen).toString();
    const valLen = buf.readUInt16BE(o + 3 + nameLen), val = buf.subarray(o + 5 + nameLen, o + 5 + nameLen + valLen);
    attrs[name] = tag === 0x21 ? val.readInt32BE(0) : val.toString();
    o += 5 + nameLen + valLen;
  }
  return { version: buf[0] + '.' + buf[1], op: buf.readUInt16BE(2), requestId: buf.subarray(4, 8), attrs, doc: buf.subarray(o) };
}

function attr(tag, name, value) {
  const n = Buffer.from(name), v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const h = Buffer.alloc(3); h[0] = tag; h.writeUInt16BE(n.length, 1);
  const l = Buffer.alloc(2); l.writeUInt16BE(v.length, 0);
  return Buffer.concat([h, n, l, v]);
}

function createMockIpp(outDir) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (req.method !== 'POST' || buf.length < 9) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('mock IPP printer: POST an IPP Print-Job request here'); }
      let r;
      try { r = parseRequest(buf); } catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('malformed IPP request: ' + e.message); }
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'printed.pdf'), r.doc);
      fs.writeFileSync(path.join(outDir, 'job.json'), JSON.stringify({ ct: req.headers['content-type'], version: r.version, op: r.op, attrs: r.attrs, docBytes: r.doc.length }, null, 1));
      const bad = r.attrs['document-format'] !== 'application/pdf' || r.doc.subarray(0, 5).toString() !== '%PDF-';
      const jobId = Buffer.alloc(4); jobId.writeInt32BE(42, 0);
      res.writeHead(200, { 'Content-Type': 'application/ipp' });
      res.end(Buffer.concat([
        Buffer.from([2, 0, bad ? 0x04 : 0, bad ? 0x0a : 0]), r.requestId, // status: successful-ok or client-error-document-format-not-supported
        Buffer.from([1]), attr(0x47, 'attributes-charset', 'utf-8'), attr(0x48, 'attributes-natural-language', 'en'),
        Buffer.from([2]), attr(0x21, 'job-id', jobId), Buffer.from([3]),
      ]));
    });
  });
}

module.exports = { createMockIpp, parseRequest };

if (require.main === module) {
  const port = +process.env.MOCK_IPP_PORT || 6310, out = process.env.MOCK_IPP_OUT || 'test-results/ipp';
  createMockIpp(out).listen(port, '127.0.0.1', () => console.log('mock IPP printer on http://127.0.0.1:' + port + '/printers/Test  (output: ' + out + ')'));
}
