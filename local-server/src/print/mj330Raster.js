import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

// Arial Narrow Regular body and Bold heading masks at native printer resolution. Each glyph row occupies three
// bytes for headings and two bytes for body/item text, most significant bit first.
const masks = gunzipSync(readFileSync(new URL('./mj330-arial-narrow.mask.gz', import.meta.url)));
const alphabet = Array.from({length: 95}, (_, i) => String.fromCharCode(32 + i)).join('') + '×—–';
const bodyHeight = 27, itemHeight = 38, headingHeight = 41;
const bytesPerRow = 72; // 576 dots, assuming 8 dots/mm over 72 mm.
const printableDots = bytesPerRow * 8;
const columns = 42; // Matches renderTicketText's 80 mm layout.

// Code 39 patterns for numeric reference tokens (alternating bar/space widths).
function referenceBarcode(token) {
  const patterns = ['111221211','211211112','112211112','212211111','111221112',
    '211221111','112221111','111211212','211211211','112211211'];
  const symbols = ['121121211', ...Array.from(token, digit => patterns[Number(digit)]), '121121211'];
  const modules = symbols.flatMap(pattern => [...pattern, '1'].map(Number));
  const width = modules.reduce((sum, n) => sum + n, 0) * 3;
  if (width + 60 > printableDots) return Buffer.alloc(0);
  const row = Buffer.alloc(bytesPerRow);
  let x = Math.floor((printableDots - width) / 2);
  for (const [index, n] of modules.entries()) {
    for (let k = 0; k < n * 3; k++, x++) {
      if (index % 2 === 0) row[x >> 3] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([Buffer.from([29,118,48,0,bytesPerRow,0,46,0]), ...Array(46).fill(row)]);
}

export function renderMj330Raster(text) {
  const bands = [];
  for (const [index, source] of text.replace(/\r\n/g, '\n').split('\n').entries()) {
    // The invoice metadata row pairs its order number with the order type.
    // Embolden only the right-hand label, preserving the existing body size.
    const orderTypeRow = /^Order \S+\s{2,}(\S.*)$/.exec(source);
    const orderTypeStart = orderTypeRow && !/\d+\.\d+$/.test(orderTypeRow[1])
      ? source.length - orderTypeRow[1].length : -1;
    const heading = index === 0 && source.trim() !== '' && !/^(INVOICE:|[-=]+$)/.test(source);
    const reference = /^Reference#\d+$/.test(source);
    const total = /^(TOTAL|Customer total)\s{2,}(.+)$/.exec(source);
    const largeTotal = total && total[1].length + total[2].length < 32;
    const orderTotal = orderTypeStart < 0 && /^(Order \d+)\s{2,}(.+)$/.exec(source);
    const prominent = heading || reference || largeTotal || Boolean(orderTotal);
    const line = orderTotal
      ? orderTotal[1] + orderTotal[2].padStart(Math.max(32 - orderTotal[1].length, orderTotal[2].length + 1))
      : largeTotal ? total[1] + total[2].padStart(32 - total[1].length)
      : prominent ? source.trim() : source;
    const item = /^\d+\s+(?:×\s|.*\s\d+\.\d{3}$)/.test(line);
    const pitch = prominent ? 18 : 13;
    const stride = prominent ? 3 : 2;
    const capacity = prominent ? Math.floor(printableDots / pitch) : columns;
    const lineHeight = prominent ? headingHeight : item ? itemHeight : bodyHeight;
    const atlasOffset = alphabet.length * 2 * (prominent ? bodyHeight + itemHeight : item ? bodyHeight : 0);
    for (let start = 0; start < Math.max(1, line.length); start += capacity) {
      // GS v 0, normal size. One short band keeps each command bounded.
      const header = Buffer.from([0x1d, 0x76, 0x30, 0, bytesPerRow, 0, lineHeight, 0]);
      const pixels = Buffer.alloc(bytesPerRow * lineHeight);
      const segment = line.slice(start, start + capacity);
      const left = prominent ? Math.floor((printableDots - segment.length * pitch) / 2) : 15;
      for (const [col, char] of Array.from(segment).entries()) {
        const glyph = alphabet.indexOf(char);
        if (glyph < 0) throw new Error('Unsupported MJ330 raster glyph: U+' + char.codePointAt(0).toString(16));
        const offset = atlasOffset + glyph * stride * lineHeight;
        for (let y = 0; y < lineHeight; y++) {
          for (let x = 0; x < pitch; x++) {
            if (masks[offset + y * stride + (x >> 3)] & (0x80 >> (x & 7))) {
              const dot = left + col * pitch + x;
              pixels[y * bytesPerRow + (dot >> 3)] |= 0x80 >> (dot & 7);
              if (orderTypeStart >= 0 && start + col >= orderTypeStart && dot + 1 < printableDots) {
                pixels[y * bytesPerRow + ((dot + 1) >> 3)] |= 0x80 >> ((dot + 1) & 7);
              }
            }
          }
        }
      }
      if (/^ {8}\S/.test(line) && !/^Reference# /.test(line.trim())) {
        for (let col = 0; col < segment.trimEnd().length; col++) {
          if (!segment[col].trim()) continue;
          for (let x = 0; x < pitch; x++) {
            const dot = left + col * pitch + x;
            pixels[(lineHeight - 2) * bytesPerRow + (dot >> 3)] |= 0x80 >> (dot & 7);
          }
        }
      }
      bands.push(header, pixels);
    }
    const token = /^Reference# (\d+)$/.exec(source.trim());
    if (token) bands.push(referenceBarcode(token[1]));
  }
  // GS V 65 0: feed to the cutter and request one full cut after the ticket.
  bands.push(Buffer.from([0x1d, 0x56, 65, 0]));
  return Buffer.concat(bands);
}
