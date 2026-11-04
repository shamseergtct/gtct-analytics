/** On-demand verified SQLite-safe backup of a sealed vault. No automatic backup/restore. */
import { backupSealedProductionVault } from '../production/sealedVault.js';
try {
  const { backupPath } = await backupSealedProductionVault();
  console.log(`PASS verified SEALED backup: ${backupPath}`);
} catch (err) { console.error(`REFUSED: ${err.message}`); process.exitCode = 1; }
