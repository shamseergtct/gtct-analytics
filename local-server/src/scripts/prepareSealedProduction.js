/** Prepare a new EMPTY SEALED production vault; this does not enable Real Mode. */
import { prepareSealedProductionVault } from '../production/sealedVault.js';
if (process.argv.length !== 3 || process.argv[2] !== '--confirm-sealed-only') {
  console.error('Refusing creation. Use --confirm-sealed-only and explicit GTCT_PRODUCTION_DATA_DIR. No live sales are enabled.');
  process.exitCode = 1;
} else {
  try {
    const result = prepareSealedProductionVault();
    console.log('SEALED production vault initialized (NO orders or real sale capability).');
    console.log(`Database: ${result.dbPath}`);
    console.log(`Installation ID: ${result.identity.installationId}`);
  } catch (err) { console.error(`REFUSED: ${err.message}`); process.exitCode = 1; }
}
