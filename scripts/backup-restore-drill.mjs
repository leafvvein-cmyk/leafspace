import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import JSZip from 'jszip';
import { createPool } from '../apps/api/src/db.js';
import { migrate } from '../apps/api/src/migrate.js';

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeRoot = join(workspace, '.runtime');
const reportPath = join(workspace, 'artifacts', 'backup-restore-drill-report.json');
const drillId = randomUUID().replaceAll('-', '');
const sourceDatabase = `diary_drill_source_${drillId}`;
const restoredDatabase = `diary_drill_restored_${drillId}`;
const dumpName = `diary-drill-${drillId}.dump`;
const containerDump = `/tmp/${dumpName}`;
const connection = (database) => `postgresql://diary:diary_local_development_only@127.0.0.1:54329/${database}`;

function dockerCompose(...args) {
  return execFileSync('docker', ['compose', ...args], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function postgresTool(tool, ...args) {
  return dockerCompose('exec', '-T', 'postgres', tool, '--username', 'diary', ...args);
}

async function filesUnder(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
      else throw new Error(`Unsupported storage entry: ${path}`);
    }
  }
  await visit(root);
  return result.sort();
}

async function checksumManifest(root) {
  const manifest = {};
  for (const path of await filesUnder(root)) {
    const name = relative(root, path).replaceAll('\\', '/');
    manifest[name] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return manifest;
}

async function seed(pool, assetRoot, exportRoot) {
  const userId = randomUUID(), generation = randomUUID(), entryId = randomUUID(), tagId = randomUUID();
  const assetId = randomUUID(), assetToken = randomUUID(), exportId = randomUUID(), exportToken = randomUUID();
  const sourceKey = `source/${assetId}.bin`;
  const originalKey = `original/${assetId}_${assetToken}.webp`;
  const thumbnailKey = `thumbnail/${assetId}_${assetToken}.webp`;
  const exportKey = `${exportId}_${exportToken}.zip`;
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '恢复演练正文' }] }] };

  await pool.query('INSERT INTO users(id,username_normalized,display_name,password_hash) VALUES($1,$2,$3,$4)', [userId, `drill_${drillId.slice(0, 12)}`, '备份恢复演练', 'not-used-by-drill']);
  await pool.query('INSERT INTO sync_state(user_id,generation) VALUES($1,$2)', [userId, generation]);
  await pool.query(`INSERT INTO entries(id,user_id,kind,entry_date,timezone,title,content_schema_version,content,plain_text,mood,sort_at)
    VALUES($1,$2,'daily','2026-09-09','Asia/Shanghai',$3,1,$4,$5,5,'2026-09-09T08:00:00+08:00')`, [entryId, userId, '恢复演练日记', content, '恢复演练正文']);
  await pool.query('INSERT INTO tags(id,user_id,name,normalized_name) VALUES($1,$2,$3,$4)', [tagId, userId, '备份', '备份']);
  await pool.query('INSERT INTO entry_tags(user_id,entry_id,tag_id) VALUES($1,$2,$3)', [userId, entryId, tagId]);
  const sourceBytes = Buffer.from('diary-source-backup-drill', 'utf8');
  await pool.query(`INSERT INTO assets(id,user_id,mime_type,source_size,source_sha256,status,source_key,original_key,thumbnail_key,width,height)
    VALUES($1,$2,'image/webp',$3,$4,'ready',$5,$6,$7,2,2)`, [assetId, userId, sourceBytes.length, createHash('sha256').update(sourceBytes).digest('hex'), sourceKey, originalKey, thumbnailKey]);
  await pool.query('INSERT INTO entry_assets(user_id,entry_id,asset_id) VALUES($1,$2,$3)', [userId, entryId, assetId]);
  await pool.query(`INSERT INTO export_jobs(id,user_id,request_id,options,status,progress,snapshot_at,expires_at,record_count,output_key)
    VALUES($1,$2,$3,'{}','ready',100,now(),now()+interval '1 day',1,$4)`, [exportId, userId, randomUUID(), exportKey]);

  for (const key of [sourceKey, originalKey, thumbnailKey]) {
    const target = join(assetRoot, ...key.split('/'));
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, key === sourceKey ? sourceBytes : Buffer.from(`webp-fixture:${key}`, 'utf8'));
  }
  await mkdir(exportRoot, { recursive: true });
  const zip = new JSZip();
  zip.file('diary.txt', '恢复演练日记\n恢复演练正文\n');
  await writeFile(join(exportRoot, exportKey), await zip.generateAsync({ type: 'nodebuffer' }));
  return { userId, entryId, tagId, assetId, exportId, sourceKey, originalKey, thumbnailKey, exportKey, content };
}

async function verify(pool, expected, storageRoot, expectedManifest) {
  const { rows: [row] } = await pool.query(`SELECT u.display_name,e.title,e.content,e.plain_text,t.name AS tag_name,a.source_key,a.original_key,a.thumbnail_key,j.output_key
    FROM users u JOIN entries e ON e.user_id=u.id JOIN entry_tags et ON et.entry_id=e.id AND et.user_id=u.id
    JOIN tags t ON t.id=et.tag_id AND t.user_id=u.id JOIN entry_assets ea ON ea.entry_id=e.id AND ea.user_id=u.id
    JOIN assets a ON a.id=ea.asset_id AND a.user_id=u.id JOIN export_jobs j ON j.user_id=u.id
    WHERE u.id=$1`, [expected.userId]);
  const { rows: [migrationCount] } = await pool.query('SELECT count(*)::integer AS count FROM _diary_migrations');
  if (!row || row.title !== '恢复演练日记' || row.plain_text !== '恢复演练正文' || row.tag_name !== '备份') throw new Error('Restored diary records do not match the source fixture');
  if (!isDeepStrictEqual(row.content, expected.content)) throw new Error('Restored structured diary content changed');
  if (row.source_key !== expected.sourceKey || row.original_key !== expected.originalKey || row.thumbnail_key !== expected.thumbnailKey || row.output_key !== expected.exportKey) throw new Error('Restored storage references changed');
  const actualManifest = await checksumManifest(storageRoot);
  if (JSON.stringify(actualManifest) !== JSON.stringify(expectedManifest)) throw new Error('Restored private files failed checksum verification');
  return { migrationCount: migrationCount.count, recordChecks: 9, fileChecks: Object.keys(actualManifest).length };
}

await mkdir(runtimeRoot, { recursive: true });
await mkdir(resolve(reportPath, '..'), { recursive: true });
const workRoot = await mkdtemp(join(runtimeRoot, 'backup-restore-drill-'));
const sourceStorage = join(workRoot, 'source-storage');
const backupRoot = join(workRoot, 'backup');
const restoredStorage = join(workRoot, 'restored-storage');
const sourceAssetRoot = join(sourceStorage, 'assets'), sourceExportRoot = join(sourceStorage, 'exports');
const backupStorage = join(backupRoot, 'storage'), restoredAssetRoot = join(restoredStorage, 'assets'), restoredExportRoot = join(restoredStorage, 'exports');
let sourceCreated = false, restoredCreated = false;
let sourcePool, restoredPool;

try {
  postgresTool('createdb', '--template', 'template0', sourceDatabase); sourceCreated = true;
  sourcePool = createPool(connection(sourceDatabase));
  await migrate(sourcePool);
  const expected = await seed(sourcePool, sourceAssetRoot, sourceExportRoot);
  const sourceManifest = await checksumManifest(sourceStorage);

  postgresTool('pg_dump', '--format', 'custom', '--no-owner', '--no-privileges', '--file', containerDump, sourceDatabase);
  await mkdir(backupRoot, { recursive: true });
  execFileSync('docker', ['cp', `${dockerCompose('ps', '-q', 'postgres')}:${containerDump}`, join(backupRoot, 'database.dump')], { cwd: workspace, stdio: 'pipe' });
  await cp(sourceStorage, backupStorage, { recursive: true, errorOnExist: true });
  const backupManifest = await checksumManifest(backupStorage);
  if (JSON.stringify(backupManifest) !== JSON.stringify(sourceManifest)) throw new Error('Backup private files failed checksum verification');

  await sourcePool.end(); sourcePool = undefined;
  postgresTool('dropdb', '--force', sourceDatabase); sourceCreated = false;
  await rm(sourceStorage, { recursive: true });

  postgresTool('createdb', '--template', 'template0', restoredDatabase); restoredCreated = true;
  const restoredContainerDump = `/tmp/restored-${dumpName}`;
  execFileSync('docker', ['cp', join(backupRoot, 'database.dump'), `${dockerCompose('ps', '-q', 'postgres')}:${restoredContainerDump}`], { cwd: workspace, stdio: 'pipe' });
  postgresTool('pg_restore', '--no-owner', '--no-privileges', '--dbname', restoredDatabase, restoredContainerDump);
  await cp(join(backupStorage, 'assets'), restoredAssetRoot, { recursive: true, errorOnExist: true });
  await cp(join(backupStorage, 'exports'), restoredExportRoot, { recursive: true, errorOnExist: true });
  restoredPool = createPool(connection(restoredDatabase));
  const checks = await verify(restoredPool, expected, restoredStorage, backupManifest);
  const dumpHash = createHash('sha256').update(await readFile(join(backupRoot, 'database.dump'))).digest('hex');
  const report = {
    status: 'passed',
    completedAt: new Date().toISOString(),
    scope: 'isolated local PostgreSQL plus private image and export storage',
    safety: 'temporary databases and generated runtime directories only; diary_dev was not modified',
    ...checks,
    dumpSha256: dumpHash,
    restoredFileSha256: backupManifest,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await sourcePool?.end().catch(() => {});
  await restoredPool?.end().catch(() => {});
  if (sourceCreated) { try { postgresTool('dropdb', '--force', sourceDatabase); } catch {} }
  if (restoredCreated) { try { postgresTool('dropdb', '--force', restoredDatabase); } catch {} }
  try { dockerCompose('exec', '-T', 'postgres', 'rm', '-f', containerDump, `/tmp/restored-${dumpName}`); } catch {}
  await rm(workRoot, { recursive: true, force: true });
}
