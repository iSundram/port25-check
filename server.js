'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 8000;

const SMTP_TARGETS = (
  process.env.SMTP_TARGETS ||
  'gmail-smtp-in.l.google.com,alt1.gmail-smtp-in.l.google.com,alt2.gmail-smtp-in.l.google.com'
)
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

const CONTROL_HOST = process.env.CONTROL_HOST || 'www.google.com';

const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

function probe(host, port, readBanner) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    let bannerTimer = null;

    function finish(open, detail) {
      if (settled) return;
      settled = true;
      if (bannerTimer) clearTimeout(bannerTimer);
      socket.destroy();
      resolve({ host, port, open, ms: Date.now() - startedAt, detail });
    }

    socket.setTimeout(PROBE_TIMEOUT_MS);

    socket.once('connect', () => {
      if (!readBanner) {
        finish(true, 'TCP connection established');
        return;
      }
      bannerTimer = setTimeout(() => finish(true, 'TCP connection established'), 2000);
      socket.once('data', (chunk) => {
        const banner = chunk.toString('utf8').split(/\r?\n/)[0].trim().slice(0, 160);
        finish(true, banner || 'TCP connection established');
      });
    });

    socket.once('timeout', () => {
      finish(false, `timed out after ${PROBE_TIMEOUT_MS} ms (typical of a firewall drop)`);
    });

    socket.once('error', (err) => {
      const code = err.code || 'ERROR';
      const detail = code === 'ECONNREFUSED' ? 'connection refused' : err.message || code;
      finish(false, detail);
    });
  });
}

async function runChecks() {
  const startedAt = Date.now();
  const [checks, control] = await Promise.all([
    Promise.all(SMTP_TARGETS.map((host) => probe(host, 25, true))),
    probe(CONTROL_HOST, 443, false),
  ]);

  const reachable = checks.filter((check) => check.open).length;
  let verdict = 'inconclusive';
  if (reachable > 0) {
    verdict = 'open';
  } else if (control.open) {
    verdict = 'blocked';
  }

  return {
    verdict,
    port25Open: verdict === 'open' ? true : verdict === 'blocked' ? false : null,
    reachable,
    total: checks.length,
    checks,
    control,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/api/check') {
    const report = await runChecks();
    send(res, 200, 'application/json; charset=utf-8', JSON.stringify(report, null, 2));
    return;
  }

  if (pathname === '/healthz') {
    send(res, 200, 'text/plain; charset=utf-8', 'ok');
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    send(res, 200, 'text/html; charset=utf-8', PAGE);
    return;
  }

  send(res, 404, 'text/plain; charset=utf-8', 'Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on 0.0.0.0:${PORT}`);
});
