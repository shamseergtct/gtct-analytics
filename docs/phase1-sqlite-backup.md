# Phase 1 — SQLite Backup & Recovery

## Database location

| Platform | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\GTCT\RestaurantLocalServer\gtct-local.sqlite` |
| Dev (non-Windows) | `local-server/data/gtct-local.sqlite` |

Related files (WAL mode):

- `gtct-local.sqlite` — main database
- `gtct-local.sqlite-wal` — write-ahead log
- `gtct-local.sqlite-shm` — shared memory index

**Never** place the live database in temp folders, browser cache, Vite `dist/`, or a network share.

## Safe backup (WAL-aware)

### Preferred: SQLite Online Backup API / `.backup`

With the server stopped **or** using SQLite's backup API:

```bash
# Example with sqlite3 CLI (install separately on the host)
sqlite3 "PATH/TO/gtct-local.sqlite" ".backup 'PATH/TO/backups/gtct-local-YYYYMMDD.sqlite'"
```

The `.backup` command produces a consistent snapshot even if WAL files exist.

### Alternate: stop server, copy all three files

1. Stop the local server process gracefully (`SIGINT` / service stop).
2. Copy **all** of:
   - `gtct-local.sqlite`
   - `gtct-local.sqlite-wal` (if present)
   - `gtct-local.sqlite-shm` (if present)
3. Store copies on a separate disk or backup volume.
4. Restart the server.

Copying only the main `.sqlite` file while the server is running (or while a WAL exists) can produce a corrupt or incomplete backup.

### Do not

- Delete `-wal` / `-shm` to “clean up” while the server is running
- Reset or delete the database on startup (Phase 1 never does this)
- Host the SQLite file on SMB/NFS for multi-writer access

## Restore

1. Stop the local server.
2. Move aside the current database files (keep them until restore is verified).
3. Restore the backup `.sqlite` file into the data directory with the expected name `gtct-local.sqlite`.
4. Remove stale `-wal` / `-shm` only if restoring a self-contained backup produced by `.backup` (those backups are typically a single file).
5. Start the server and check `GET /health` plus a print-job listing.

## Print output files

MOCK tickets under `print-output/mock/` are inspection artifacts, not the system of record. The durable source of truth is the `print_jobs` table (and events).
