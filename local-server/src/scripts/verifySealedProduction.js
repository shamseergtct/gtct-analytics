/** Read-only verification of the isolated, still-SEALED production vault. */
import { getSealedPathOptions, verifySealedVault } from '../production/sealedVault.js';
try {
  const { dbPath } = getSealedPathOptions();
  const identity = verifySealedVault(dbPath);
  console.log(`PASS sealed production vault; no real transactions enabled. Installation: ${identity.installationId}`);
} catch (err) { console.error(`REFUSED: ${err.message}`); process.exitCode = 1; }
