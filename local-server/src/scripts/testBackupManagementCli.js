/** P2-C3: explicit TEST backup health and reviewed retention. */
import { getTestBackupHealth, planTestBackupRetention, applyTestBackupRetention } from '../backup/testBackupManagement.js';

try {
  const mode = process.argv[2];
  if (mode === 'status') {
    const health = getTestBackupHealth();
    console.log(`TEST backup status: ${health.state} — ${health.message}`);
    console.log(`Snapshots: ${health.snapshotCount}; auto backup enabled: ${health.autoEnabled}`);
    if (health.latestBackup) console.log(`Last verified: ${health.latestBackup.createdAt} (${health.latestBackup.filename})`);
    if (health.lastFailureAt) console.log(`Last recorded failure: ${health.lastFailureAt}`);
    if (health.state === 'ERROR' || health.state === 'STALE' || health.state === 'CONFIG_ERROR') process.exitCode = 2;
  } else if (mode === 'retention-plan') {
    const plan = planTestBackupRetention();
    console.log(`TEST retention preview — older than ${plan.days} days; protect latest ${plan.keep} verified backups.`);
    console.log(`Snapshots: ${plan.snapshotCount}; eligible for deletion: ${plan.eligible.length}; unverified/skipped: ${plan.skipped.length}`);
    for (const entry of plan.eligible) console.log(`  REVIEW DELETE: ${entry.name}`);
    for (const name of plan.skipped) console.log(`  SKIPPED (unverified): ${name}`);
    console.log(`Plan ID: ${plan.planId}`);
    console.log('DRY RUN ONLY. No files deleted. Keep an independent off-device backup before any cleanup.');
  } else if (mode === 'retention-apply') {
    const applied = applyTestBackupRetention();
    console.log(`EXPLICIT TEST retention complete: ${applied.deleted} verified backup pair(s) deleted.`);
    console.log('Active restaurant database, production vault and latest protected backups unchanged.');
  } else {
    throw new Error('Use backup:status, backup:retention-plan or backup:retention-apply.');
  }
} catch (error) {
  console.error(`TEST backup management refused/failed: ${error.message}`);
  process.exitCode = 1;
}
