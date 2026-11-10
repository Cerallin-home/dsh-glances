/**
 * disks 的 fstype / readOnly：纯本地解析，不依赖 glances。
 * fixture 照着真机 /proc/self/mounts 的样子写（含 ro、vfat、overlay、tmpfs、\040 转义）。
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  annotateDisks,
  evaluateAlerts,
  parseMounts,
  readMounts,
  renderStatus,
  MOUNTS_FILE,
} from '../lib/glances.js';

const FIXTURE = [
  'tmpfs /run tmpfs rw,nosuid,nodev,size=1623636k,nr_inodes=819200,mode=755,inode64 0 0',
  '/dev/nvme0n1p2 / ext4 rw,relatime,discard 0 0',
  'devtmpfs /dev devtmpfs rw,nosuid,size=3998628k,nr_inodes=999657,mode=755,inode64 0 0',
  'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
  '/dev/nvme0n1p1 /boot/firmware vfat ro,relatime,fmask=0022,dmask=0022,codepage=437,iocharset=ascii,shortname=mixed,errors=remount-ro 0 0',
  'overlay /var/lib/docker/overlay2/abc/merged overlay ro,relatime,lowerdir=/x,upperdir=/y 0 0',
  '/dev/sda1 /mnt/my\\040disk ext4 ro,relatime 0 0',
  '',
].join('\n');

test('parseMounts 认 fstype 与 ro/rw', () => {
  const t = parseMounts(FIXTURE);
  assert.deepEqual(t.get('/boot/firmware'), { fstype: 'vfat', readOnly: true });
  assert.deepEqual(t.get('/'), { fstype: 'ext4', readOnly: false });
  assert.equal(t.get('/run').fstype, 'tmpfs');
  assert.equal(t.get('/var/lib/docker/overlay2/abc/merged').fstype, 'overlay');
  assert.equal(t.get('/mnt/my disk')?.readOnly, true, '\\040 要还原成空格');
  assert.equal(t.has('/nope'), false);
});

test('/boot/firmware 判成 vfat + 只读', () => {
  const table = parseMounts(FIXTURE);
  const [boot] = annotateDisks([{ path: '/boot/firmware', percent: 37.7, sizeGb: 0.5 }], table);
  assert.equal(boot.fstype, 'vfat');
  assert.equal(boot.readOnly, true);
  assert.equal(boot.percent, 37.7, '其它字段不动');
});

test('查不到挂载点也给 unknown / false，不丢条目', () => {
  const table = parseMounts(FIXTURE);
  const disks = annotateDisks(
    [
      { path: '/', percent: 15, sizeGb: 469, usedGb: 69, freeGb: 381 },
      { path: '/nowhere', percent: 99, sizeGb: 1, usedGb: 1, freeGb: 0 },
      { path: '/with-glances-fstype', fstype: 'btrfs', percent: 1 },
      { path: '/broken', error: 'EACCES' },
    ],
    table,
  );
  assert.equal(disks.length, 4);
  assert.deepEqual(
    disks.map((d) => [d.fstype, d.readOnly]),
    [
      ['ext4', false],
      ['unknown', false],
      ['btrfs', false],
      ['unknown', false],
    ],
  );
});

test('mountTable 缺省（空表）不炸', () => {
  const [d] = annotateDisks([{ path: '/', percent: 1 }], new Map());
  assert.equal(d.fstype, 'unknown');
  assert.equal(d.readOnly, false);
});

test('只读分区不进 warnings', () => {
  const status = {
    cores: 4,
    cpu: { totalPercent: 1 },
    mem: { percent: 10 },
    load: { min1: 0.1, min5: 0.1, min15: 0.1, perCore: 0.1 },
    temps: [],
    warnings: [],
    disks: [
      { path: '/boot/firmware', percent: 99, readOnly: true, fstype: 'vfat' },
      { path: '/', percent: 99, readOnly: false, fstype: 'ext4' },
    ],
  };
  const v = evaluateAlerts(status, { diskPercent: 90 });
  const diskIssues = v.issues.filter((i) => i.metric === 'disk');
  assert.equal(diskIssues.length, 1);
  assert.match(diskIssues[0].text, /磁盘 \/ /);
  assert.doesNotMatch(diskIssues[0].text, /boot\/firmware/);
});

test('renderStatus 标出 fstype 与只读', () => {
  const text = renderStatus({
    host: 'pi',
    os: '',
    uptime: '1 天',
    cpu: { totalPercent: 1, userPercent: 0, systemPercent: 0, iowaitPercent: 0, source: 'glances' },
    cores: 4,
    load: { min1: 0, min5: 0, min15: 0, perCore: 0 },
    mem: null,
    swap: null,
    temps: [],
    disks: [
      { path: '/boot/firmware', percent: 37.7, usedGb: 0.2, sizeGb: 0.5, freeGb: 0.3, fstype: 'vfat', readOnly: true },
      { path: '/', percent: 15, usedGb: 69, sizeGb: 469, freeGb: 381, fstype: 'ext4', readOnly: false },
    ],
  });
  assert.match(text, /磁盘 \/boot\/firmware 37\.7%.*vfat·只读/);
  assert.match(text, /磁盘 \/ 15%.*ext4/);
  assert.doesNotMatch(text, /磁盘 \/ 15%.*只读/);
});

test('真机挂载表能读出来（读不到就跳过）', (t) => {
  let raw;
  try {
    raw = readFileSync(MOUNTS_FILE, 'utf8');
  } catch {
    t.skip(`${MOUNTS_FILE} 读不到`);
    return;
  }
  const table = readMounts();
  assert.ok(table.size > 0);
  assert.equal(table.get('/')?.readOnly, parseMounts(raw).get('/')?.readOnly);
});
