// DNS of the replay network: every A query points at the replay server, all other types get an
// empty answer (NOERROR without data). dnsmasq without upstream answers AAAA with REFUSED, which
// makes getaddrinfo of musl fail for the whole name.
//   node dns.mjs <ipv4>
import dgram from 'node:dgram';

const target = (process.argv[2] ?? '').split('.').map(Number);
const socket = dgram.createSocket('udp4');
socket.on('message', (msg, rinfo) => {
  if (msg.length < 12) return;
  let offset = 12;
  while (offset < msg.length && msg[offset] !== 0) offset += msg[offset] + 1;
  const type = msg.readUInt16BE(offset + 1);
  const question = msg.subarray(12, offset + 5);
  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8180 | (msg.readUInt16BE(2) & 0x0100), 2);
  header.writeUInt16BE(1, 4);
  const parts = [header, question];
  if (type === 1) {
    header.writeUInt16BE(1, 6);
    parts.push(Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...target]));
  }
  socket.send(Buffer.concat(parts), rinfo.port, rinfo.address);
});
socket.bind(53, '0.0.0.0');
