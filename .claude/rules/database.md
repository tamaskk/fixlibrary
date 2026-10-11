---
paths:
  - 'src/main/db/**'
  - 'drizzle.config.*'
---

# Database (SQLite, better-sqlite3 + Drizzle)

- Schema changes (new table, removed or renamed column, index change) need approval: docs/ARCHITECTURE.md §08.
- One connection, opened at startup in WAL mode, owned by `src/main/db/`. Never open the database anywhere else, and never from the renderer.
- Queries live in `src/main/db/` functions. Pipeline code calls them; IPC handlers and services do not build queries.
- Migrations are generated with `drizzle-kit generate` and run by `migrate()` at startup. Never edit an applied migration; every change is a new one. Destructive migrations need explicit approval.
- Use Drizzle's query builder with bound parameters. No string-built SQL.
- Writes that must succeed together run in one transaction. Bulk inserts (a 3000-track scan) are batched inside a transaction.
- better-sqlite3 is synchronous: keep queries short, paginate lists, add an index for every hot-path filter or sort.
- JSON columns are validated with Zod when read.
- Secrets are stored only as `safeStorage`-encrypted values.
- Tests use a temporary database file and run the real migrations.
