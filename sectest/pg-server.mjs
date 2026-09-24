import EmbeddedPostgres from 'embedded-postgres';
const pg = new EmbeddedPostgres({ databaseDir: './sectest/pgdata', user: 'postgres', password: 'postgres', port: 5433, persistent: false });
await pg.initialise();
await pg.start();
try { await pg.createDatabase('app_db'); } catch {}
console.log('PG_READY on 5433/app_db');
process.on('SIGTERM', async () => { await pg.stop(); process.exit(0); });
process.on('SIGINT', async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
