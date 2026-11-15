# Production readiness — remaining blockers

This build remains a **TEST PILOT**. Automatic physical printing is available under TEST with persistent Printer Settings. It does **not** enable PRODUCTION mode.

## Still required before real customer billing under PRODUCTION

1. Separate PRODUCTION SQLite identity and boot path (do not convert a TEST DB).
2. Production migrations/schema distinct from TEST `is_test` order rules.
3. First-run Admin/shop for PRODUCTION vault (sealed placeholder today has no sales tables).
4. FINANCIAL day-end, voids/refunds, and reporting signed off for PRODUCTION.
5. Backup/restore drills on the restaurant PC with verified RPO/RTO.
6. Windows x64 + ARM64 runtime sign-off after installer upgrade on target hardware.
7. Explicit go-live change control (env, print enablement, staff training).

Do not bypass TEST startup guards to force PRODUCTION.
