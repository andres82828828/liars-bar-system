// =====================================================================
//  npm test
//  1) creates a temporary database (liars_bar_test) with the seed data
//  2) starts the server on TEST_PORT against that database
//  3) runs tests/api.test.js
//  4) stops the server and drops the temporary database
//  Your real database (liars_bar) is never touched.
// =====================================================================
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { config } = require('../db');

const TEST_DB = 'liars_bar_test';
const TEST_PORT = process.env.TEST_PORT || '3999';
const root = path.join(__dirname, '..');
const env = { ...process.env, DB_NAME: TEST_DB, PORT: TEST_PORT, TEST_PORT };

const run = (script, opts = {}) => spawn(process.execPath, [script], { cwd: root, env, stdio: opts.quiet ? 'pipe' : 'inherit' });
const finished = (child) => new Promise((resolve) => child.on('exit', (code) => resolve(code)));

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://localhost:${TEST_PORT}/api/me`); return; } catch (e) { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('The test server did not start.');
}

async function dropTestDb() {
  const admin = new Client({ ...config, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
}

(async () => {
  let server = null, code = 1;
  try {
    console.log(`• Creating temporary database "${TEST_DB}"…`);
    if (await finished(run('init-db.js')) !== 0) throw new Error('init-db failed');

    server = run('server.js', { quiet: true });
    server.stderr.on('data', (d) => process.stderr.write(d));
    await waitForServer();
    console.log(`• Test server running on port ${TEST_PORT}\n`);

    code = await finished(run(path.join('tests', 'api.test.js')));
  } catch (e) {
    console.error('✖', e.message);
  } finally {
    if (server) server.kill();
    await dropTestDb().catch((e) => console.error('Could not drop the test database:', e.message));
    console.log(`\n• Temporary database "${TEST_DB}" dropped`);
    process.exit(code);
  }
})();
