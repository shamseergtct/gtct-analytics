/** P2-C1: TEST database backup/verify/restore. Never overwrites active SQLite. */
import { createTestBackup, verifyTestBackup, restoreTestBackupToNewDirectory } from '../backup/testBackup.js';

const mode = process.argv[2];
const file = process.env.GTCT_TEST_BACKUP_FILE;
try {
  if (mode === 'create') {
    const result = await createTestBackup();
    console.log(`TEST backup verified: ${result.backupPath}`);
    console.log(`Manifest: ${result.manifestPath}`);
  } else if (mode === 'verify') {
    const result = verifyTestBackup(file);
    console.log(`TEST backup integrity verified: ${result.backupPath}`);
  } else if (mode === 'restore-new') {
    const result = await restoreTestBackupToNewDirectory(file);
    console.log(`TEST restored into NEW directory only: ${result.restoredDbPath}`);
    console.log('Original application database has NOT been changed.');
  } else {
    throw new Error('Use npm run backup:test, backup:test-verify, or backup:test-restore-new.');
  }
} catch (err) {
  console.error(`TEST backup operation refused/failed: ${err.message}`);
  process.exitCode = 1;
}
