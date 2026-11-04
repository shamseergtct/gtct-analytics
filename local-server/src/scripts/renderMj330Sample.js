// Offline only. Writes a synthetic ticket to a new local file.
import { writeFileSync } from 'node:fs';
import { renderTicketText } from '../print/ticketFormat.js';
import { buildNetworkTcpPayload } from '../print/adapters/networkTcpAdapter.js';

const [type, output] = process.argv.slice(2);
if (!['KITCHEN', 'CASHIER'].includes(type) || !output) {
  throw new Error('Usage: node src/scripts/renderMj330Sample.js KITCHEN|CASHIER output.bin');
}
const text = renderTicketText(type, {
  shopDisplayName: 'GTCT TEST PRINT', stationName: 'Test kitchen',
  orderNumber: 'SAMPLE', ticketId: 'OFFLINE', createdAt: '2026-01-01T12:00:00Z',
  items: [{ name: 'Sample item', quantity: 1, lineTotalCents: 1250 }],
  currencyCode: 'BHD', currencyLabel: 'BHD', currencyDecimals: 3,
  goodsCents: 1250, totalCents: 1250,
}, { paperWidthMm: 80 });
writeFileSync(output, buildNetworkTcpPayload(text, 'MJ330_RASTER'), { flag: 'wx' });
