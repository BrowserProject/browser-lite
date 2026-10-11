// Prueft das Bild von basic.html: Farben an bekannten Stellen und dass Text da ist.
//   node tests/engine/check-basic.mjs <bild.ppm>
import { readFileSync } from 'node:fs';

const data = readFileSync(process.argv[2]);
const headerEnd = (() => {
  let newlines = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 10 && ++newlines === 3)
      return i + 1;
  }
  throw new Error('kein gueltiges PPM');
})();
const [, size] = data.subarray(0, headerEnd).toString().split('\n');
const [width] = size.split(' ').map(Number);
const pixel = (x, y) => {
  const i = headerEnd + (y * width + x) * 3;
  return [data[i], data[i + 1], data[i + 2]];
};
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 8);

let failed = 0;
const expect = (name, ok, info) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info || ''}`);
  if (!ok)
    failed++;
};

expect('roter Kasten', near(pixel(140, 90), [255, 0, 0]), JSON.stringify(pixel(140, 90)));
expect('blauer Kreis Mitte', near(pixel(350, 90), [0, 0, 255]), JSON.stringify(pixel(350, 90)));
expect('Kreis-Ecke ist Hintergrund', near(pixel(303, 43), [244, 244, 244]), JSON.stringify(pixel(303, 43)));
expect('Hintergrund', near(pixel(700, 500), [244, 244, 244]), JSON.stringify(pixel(700, 500)));

// Text: in der Zeile der Ueberschrift muss es dunkle Pixel geben
let dark = 0;
for (let x = 40; x < 600; x++) {
  for (let y = 185; y < 215; y++) {
    const [r, g, b] = pixel(x, y);
    if (r < 100 && g < 100 && b < 100)
      dark++;
  }
}
expect('Text gemalt', dark > 200, `${dark} dunkle Pixel`);
// "(JS ok)" macht die Zeile laenger: auch weiter rechts muss Text sein
let darkRight = 0;
for (let x = 380; x < 600; x++) {
  for (let y = 185; y < 215; y++) {
    const [r, g, b] = pixel(x, y);
    if (r < 100 && g < 100 && b < 100)
      darkRight++;
  }
}
expect('JavaScript hat Text geaendert', darkRight > 50, `${darkRight} dunkle Pixel rechts`);

process.exit(failed ? 1 : 0);
