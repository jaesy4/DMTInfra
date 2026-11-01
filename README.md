# Document Tracker (DMTS)

Offline, portable Windows app to register documents (mostly PDFs), track **who has each
document now** (e.g. "For Approval – Mr. Sabanal" → "Approved – Accounting"), keep a full
movement history, flag documents past their due-back date, manage revisions, and print/export.

- **Tech:** Tauri 2 (Rust) + SQLite. Screens are plain HTML/CSS/JS in `ui/`.
- **Data:** `DMTSData/` next to the .exe (`dmts.db` + `vault/` of SHA-256-named files).
- **Sync-ready:** UUID ids, `updated_at`, `device_id`, soft deletes – a server can be added later.

## Get the .exe
Every push to `main` builds it: **Actions → Build Windows EXE → latest run → Artifacts → DocumentTracker-windows**.

## Layout
```
ui/                     screens
src-tauri/src/main.rs   database, file vault, open/save copy, backup, Excel export
src-tauri/src/schema.sql
docs/HOW-TO-USE.txt
tests/                  browser click-through test (dev only)
```
