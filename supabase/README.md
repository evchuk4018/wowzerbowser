# Historical migration archive

The files in this directory are retained as historical migration provenance for
older development snapshots and source-level compatibility tests. They are not
part of the runtime or deployment migration path.

Production and clean-install deployments apply only the ordered SQL files in
`database/migrations` through `scripts/migrate.mjs`. Do not apply these archived
files to the local PostgreSQL database.
