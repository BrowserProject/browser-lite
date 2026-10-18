// Test certificates (needs openssl): a test CA, a server certificate signed by it for 127.0.0.1,
// and certificates the engine must reject (wrong name, expired, self-signed).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Creates the certificates in dir. Returns { ca (PEM), good, wrongName, expired, selfSigned },
 * each { key, cert } for https.createServer; expired is null when openssl cannot make one.
 */
export function makeCerts(dir) {
  mkdirSync(dir, { recursive: true });
  const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  const read = (name) => readFileSync(path.join(dir, name));
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=browser-lite Test CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  );
  // Signed by the test CA, with a name (SAN) and validity in days (negative: already expired)
  const signed = (name, san, days) => {
    openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      '/CN=browser-lite Test',
    );
    writeFileSync(
      path.join(dir, `${name}.cnf`),
      `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
    );
    openssl(
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      `${name}.pem`,
      '-days',
      String(days),
      '-extfile',
      `${name}.cnf`,
    );
    return { key: read(`${name}.key`), cert: read(`${name}.pem`) };
  };
  const good = signed('server', 'IP:127.0.0.1', 2);
  const wrongName = signed('wrong-name', 'DNS:localhost', 2);
  let expired = null;
  try {
    expired = signed('expired', 'IP:127.0.0.1', -1);
  } catch {
    console.log('Note: openssl cannot make an expired certificate, case skipped');
  }
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'self.key',
    '-out',
    'self.pem',
    '-days',
    '2',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  );
  const selfSigned = { key: read('self.key'), cert: read('self.pem') };
  return { ca: read('ca.pem').toString('utf8'), good, wrongName, expired, selfSigned };
}
