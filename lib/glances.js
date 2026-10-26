/**
 * glances 数据采集层（不依赖 dsh，可单独用 node 跑测试）
 *
 * 数据源：glances REST API（默认 http://127.0.0.1:61208/api/4）
 * 磁盘为什么还要 statfs：glances 跑在 docker 容器里，看不到宿主机的 /proc/mounts，
 * /api/4/fs 只有容器自己的 /etc/resolv.conf 之类。所以磁盘占用用本进程的 statfs
 * 兜底（dsh 就跑在这台机器上），glances 的 fs 结果只在看得见真实挂载点时补充。
 */
import fs from 'node:fs';

export const DEFAULT_BASE = 'http://127.0.0.1:61208/api/4';

const SKIP_MOUNTS = /^\/(etc|dev|var\/lib\/docker|sys|proc)\b/;

export async function fetchJson(baseUrl, endpoint, timeoutMs = 4000) {
  const url = `${baseUrl.replace(/\/+$/, '')}${endpoint}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}`);
  return res.json();
}

/** 一次拿全部端点；单个端点失败不致命，记进 warnings */
async function gather(baseUrl, endpoints, timeoutMs) {
  const keys = Object.entries(endpoints);
  const results = await Promise.allSettled(keys.map(([, ep]) => fetchJson(baseUrl, ep, timeoutMs)));
  const out = {};
  const warnings = [];
  results.forEach((r, i) => {
    const [key] = keys[i];
    if (r.status === 'fulfilled') out[key] = r.value;
    else {
      out[key] = null;
      warnings.push(`${key}: ${r.reason?.message ?? r.reason}`);
    }
  });
  return { data: out, warnings };
}

function bytesToGb(n) {
  return Math.round((Number(n) / 1024 ** 3) * 10) / 10;
}

/** 本进程所在机器的磁盘占用（相当于 df） */
export function disksFromStatfs(paths) {
  const out = [];
  for (const p of paths) {
    try {
      const st = fs.statfsSync(p);
      const size = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      const used = size - st.bfree * st.bsize;
      const entry = {
        path: p,
        source: 'statfs',
        sizeGb: bytesToGb(size),
        usedGb: bytesToGb(used),
        freeGb: bytesToGb(free),
        percent: size ? Math.round((used / size) * 1000) / 10 : 0,
      };
      // / 和 /home 常常是同一个文件系统，只报一次（取最短路径）
      const same = out.find(
        (s) => s.sizeGb === entry.sizeGb && s.usedGb === entry.usedGb && s.path.length <= p.length,
      );
      if (same) continue;
      out.push(entry);
    } catch (error) {
      out.push({ path: p, source: 'statfs', error: String(error?.message ?? error) });
    }
  }
  return out;
}

const SKIP_FS = /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|ramfs|devpts|cgroup2?|nsfs|fuse\.lxcfs)$/;

/**
 * 容器里看到的挂载点 → 宿主机路径。
 * glances 跑在 docker 里，宿主 / 通常 bind 到 /nvme0n1（或者别的前缀），
 * 前缀去掉就是宿主上的真实路径；同一设备只留最短的那条。
 */
function disksFromGlances(list, mountPrefix = '/nvme0n1') {
  if (!Array.isArray(list)) return [];
  const byDevice = new Map();
  for (const d of list) {
    const mnt = String(d?.mnt_point ?? '');
    if (!mnt.startsWith('/')) continue;
    if (SKIP_FS.test(String(d?.fs_type ?? ''))) continue;
    if (SKIP_MOUNTS.test(mnt)) continue;
    let hostPath = mnt;
    if (mountPrefix && (mnt === mountPrefix || mnt.startsWith(`${mountPrefix}/`))) {
      hostPath = mnt.slice(mountPrefix.length) || '/';
      if (hostPath !== '/') hostPath = hostPath.replace(/\/+$/, '');
    } else if (mountPrefix) {
      // 不在宿主挂载树里的容器挂载（/etc/resolv.conf 之类）直接丢掉
      continue;
    }
    const entry = {
      path: hostPath,
      source: 'glances',
      device: d?.device_name ?? '',
      fsType: d?.fs_type ?? '',
      sizeGb: bytesToGb(d?.size),
      usedGb: bytesToGb(d?.used),
      freeGb: bytesToGb(d?.free),
      percent: Math.round(Number(d?.percent ?? 0) * 10) / 10,
    };
    const key = entry.device || hostPath;
    const prev = byDevice.get(key);
    if (!prev || entry.path.length < prev.path.length) byDevice.set(key, entry);
  }
  return [...byDevice.values()].sort((a, b) => a.path.length - b.path.length);
}

function tempsFromSensors(list) {
  if (!Array.isArray(list)) return { temps: [], fanRpm: null };
  const temps = [];
  let fanRpm = null;
  for (const s of list) {
    if (s?.type === 'temperature_core') {
      temps.push({
        label: String(s.label ?? ''),
        celsius: Number(s.value ?? 0),
        warning: Number.isFinite(Number(s.warning)) ? Number(s.warning) : null,
        critical: Number.isFinite(Number(s.critical)) ? Number(s.critical) : null,
      });
    } else if (s?.type === 'fan_speed' && fanRpm == null) {
      fanRpm = Number(s.value ?? 0);
    }
  }
  return { temps, fanRpm };
}

/** CPU 温度：优先 cpu_thermal（树莓派 SoC），退回落 CPU 字样的读数 */
function pickCpuTemp(temps) {
  const exact = temps.find((t) => /cpu_thermal|^cpu\b|cpu temp/i.test(t.label));
  if (exact) return exact;
  const anyCpu = temps.find((t) => /cpu/i.test(t.label));
  return anyCpu ?? temps[0] ?? null;
}

/** 板载 NVMe（Composite 是 nvme smart 的合成温度） */
function pickNvmeTemp(temps) {
  return temps.find((t) => /composite/i.test(t.label)) ?? null;
}

export async function collectStatus(options = {}) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE;
  const timeoutMs = options.timeoutMs ?? 4000;
  const diskPaths = options.diskPaths ?? ['/'];
  const mountPrefix = options.mountPrefix ?? '/nvme0n1';
  const { data, warnings } = await gather(
    baseUrl,
    {
      cpu: '/cpu',
      mem: '/mem',
      swap: '/memswap',
      load: '/load',
      sensors: '/sensors',
      fs: '/fs',
      system: '/system',
      uptime: '/uptime',
      quicklook: '/quicklook',
    },
    timeoutMs,
  );

  // glances 的 CPU 百分比是"上次采样到这次"的差值：隔久了第一次全是 0，
  // 间隔太短又会给出 total=50/user=0 这种自相矛盾的窗口。所以：
  // 先按 idle+user+sys+iowait≈100 校验，脏了就本地 /proc/stat 量一段（150ms，准且快）。
  const cpuValid = (c) => {
    if (!c) return false;
    const idle = Number(c.idle);
    const sum = idle + Number(c.user) + Number(c.system) + Number(c.iowait);
    return idle > 0 && Number(c.total) >= 0 && Math.abs(sum - 100) <= 12;
  };
  let cpuSource = 'glances';
  if (!cpuValid(data.cpu)) {
    const local = await cpuFromProcStat();
    if (local) {
      data.cpu = { ...local, cpucore: data.cpu?.cpucore ?? data.load?.cpucore };
      cpuSource = 'proc';
    }
  }

  const cores = Number(data.cpu?.cpucore ?? data.load?.cpucore ?? 0) || 1;
  const load1 = Number(data.load?.min1 ?? 0);
  const { temps, fanRpm } = tempsFromSensors(data.sensors);
  const cpuTemp = pickCpuTemp(temps);
  const nvmeTemp = pickNvmeTemp(temps);

  const mem = data.mem
    ? {
        totalGb: bytesToGb(data.mem.total),
        usedGb: bytesToGb(data.mem.used),
        availableGb: bytesToGb(data.mem.available),
        percent: Math.round(Number(data.mem.percent ?? 0) * 10) / 10,
        cachedGb: bytesToGb(data.mem.cached),
      }
    : null;

  const swap = data.swap
    ? {
        totalGb: bytesToGb(data.swap.total),
        usedGb: bytesToGb(data.swap.used),
        percent: Math.round(Number(data.swap.percent ?? 0) * 10) / 10,
      }
    : null;

  // glances 看得见宿主挂载就用它（df 口径），看不见的路径再用 statfs 兜底
  const glancesDisks = disksFromGlances(data.fs, mountPrefix);
  const covered = new Set(glancesDisks.map((d) => d.path));
  const statfsDisks = disksFromStatfs(diskPaths).filter((d) => !covered.has(d.path));

  return {
    ts: new Date().toISOString(),
    host: String(data.system?.hostname ?? data.quicklook?.hostname ?? ''),
    os: String(data.system?.hr_name ?? data.system?.linux_distro ?? ''),
    uptime: String(data.uptime ?? ''),
    cores,
    cpu: {
      totalPercent: Math.round(Number(data.cpu?.total ?? data.quicklook?.cpu ?? 0) * 10) / 10,
      userPercent: Math.round(Number(data.cpu?.user ?? 0) * 10) / 10,
      systemPercent: Math.round(Number(data.cpu?.system ?? 0) * 10) / 10,
      iowaitPercent: Math.round(Number(data.cpu?.iowait ?? 0) * 10) / 10,
      model: String(data.quicklook?.cpu_name ?? ''),
      source: cpuSource,
    },
    load: {
      min1: Math.round(load1 * 100) / 100,
      min5: Math.round(Number(data.load?.min5 ?? 0) * 100) / 100,
      min15: Math.round(Number(data.load?.min15 ?? 0) * 100) / 100,
      perCore: Math.round((load1 / cores) * 100) / 100,
    },
    mem,
    swap,
    disks: [...glancesDisks, ...statfsDisks],
    temps,
    cpuTemp,
    nvmeTemp,
    fanRpm,
    warnings,
  };
}

/** 本机 /proc/stat 采一段（150ms）算 CPU 占用，和 glances 的字段对齐 */
export async function cpuFromProcStat(sampleMs = 150) {
  const read = () => {
    try {
      const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
      const n = line.trim().split(/\s+/).slice(1).map(Number);
      const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = n;
      const total = user + nice + system + idle + iowait + irq + softirq + steal;
      return { user, nice, system, idle, iowait, irq, softirq, steal, total };
    } catch {
      return null;
    }
  };
  const a = read();
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = read();
  if (!a || !b) return null;
  const d = (k) => Math.max(0, b[k] - a[k]);
  const dTotal = d('total');
  if (dTotal <= 0) return null;
  const pct = (k) => Math.round((d(k) / dTotal) * 1000) / 10;
  const toIdle = pct('idle');
  const toIowait = pct('iowait');
  return {
    total: Math.round((100 - toIdle) * 10) / 10,
    user: pct('user') + pct('nice'),
    system: pct('system') + pct('irq') + pct('softirq'),
    idle: toIdle,
    iowait: toIowait,
  };
}

let passwdMap = null;
function userName(raw) {
  const id = String(raw ?? '');
  if (!/^\d+$/.test(id)) return id;
  if (!passwdMap) {
    passwdMap = new Map();
    try {
      for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
        const parts = line.split(':');
        if (parts.length > 2) passwdMap.set(parts[2], parts[0]);
      }
    } catch {
      /* 读不到就算了，保留 uid */
    }
  }
  return passwdMap.get(id) ?? id;
}

export async function collectTop(options = {}) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE;
  const timeoutMs = options.timeoutMs ?? 4000;
  const sortBy = options.sortBy === 'memory' ? 'memory' : 'cpu';
  const limit = Math.min(20, Math.max(1, Math.trunc(Number(options.limit) || 5)));
  const list = await fetchJson(baseUrl, '/processlist', timeoutMs);
  if (!Array.isArray(list)) throw new Error('glances processlist 返回格式不对');
  const field = sortBy === 'memory' ? 'memory_percent' : 'cpu_percent';
  const rows = [...list]
    .sort((a, b) => Number(b?.[field] ?? 0) - Number(a?.[field] ?? 0))
    .slice(0, limit)
    .map((p) => ({
      pid: Number(p?.pid ?? 0),
      name: String(p?.name ?? ''),
      user: userName(p?.username),
      cpuPercent: Math.round(Number(p?.cpu_percent ?? 0) * 10) / 10,
      memPercent: Math.round(Number(p?.memory_percent ?? 0) * 10) / 10,
      rssMb: Math.round((Number(p?.memory_info?.rss ?? 0) / 1024 ** 2) * 10) / 10,
      cmdline: Array.isArray(p?.cmdline) ? p.cmdline.slice(0, 4).join(' ') : '',
    }));
  return { sortBy, limit, total: list.length, rows };
}

export const DEFAULT_THRESHOLDS = {
  cpuPercent: 85,
  memPercent: 85,
  swapPercent: 85,
  diskPercent: 90,
  tempCelsius: 78,
  loadPerCore: 1.5,
};

/** 阈值体检 + glances 自带 alert */
export function evaluateAlerts(status, thresholds = {}, extraAlerts = []) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const issues = [];
  const push = (metric, level, value, limit, text) => issues.push({ metric, level, value, limit, text });

  if (status.mem == null) {
    push('glances', 'critical', 0, 0, '内存数据取不到（glances 端点异常）');
  }
  if (status.warnings?.length) {
    push('glances', 'warn', status.warnings.length, 0, `部分指标没取到：${status.warnings.join('；')}`);
  }
  if (status.cpu?.totalPercent > t.cpuPercent) {
    push('cpu', 'warn', status.cpu.totalPercent, t.cpuPercent, `CPU ${status.cpu.totalPercent}%（线 ${t.cpuPercent}%）`);
  }
  if (status.mem && status.mem.percent > t.memPercent) {
    push('mem', 'warn', status.mem.percent, t.memPercent, `内存 ${status.mem.percent}%（线 ${t.memPercent}%）`);
  }
  if (status.swap && status.swap.percent > t.swapPercent) {
    push('swap', 'warn', status.swap.percent, t.swapPercent, `swap ${status.swap.percent}%（线 ${t.swapPercent}%）`);
  }
  if (status.load && status.load.perCore > t.loadPerCore) {
    push('load', 'warn', status.load.perCore, t.loadPerCore, `负载 ${status.load.min1}/核 ${status.load.perCore}（线 ${t.loadPerCore}）`);
  }
  for (const d of status.disks ?? []) {
    if (Number(d.percent) > t.diskPercent) {
      push('disk', 'warn', d.percent, t.diskPercent, `磁盘 ${d.path} ${d.percent}%（线 ${t.diskPercent}%）`);
    }
  }
  const hot = (status.temps ?? []).filter((x) => Number(x.celsius) >= t.tempCelsius);
  for (const x of hot) {
    push('temp', 'warn', x.celsius, t.tempCelsius, `${x.label} ${x.celsius}℃（线 ${t.tempCelsius}℃）`);
  }
  for (const a of extraAlerts) {
    const name = String(a?.name ?? a?.type ?? 'alert');
    const level = String(a?.state ?? 'warning') === 'critical' ? 'critical' : 'warn';
    push('glances', level, Number(a?.max ?? a?.value ?? 0), Number(a?.min ?? 0), `glances 告警：${name} ${a?.msg ?? ''}`.trim());
  }
  return { ok: issues.length === 0, issues, thresholds: t };
}

export function renderStatus(v) {
  const lines = [];
  const head = [v.host || 'host', v.uptime ? `上线 ${v.uptime}` : '', v.os ? v.os : ''].filter(Boolean).join(' ｜ ');
  if (head) lines.push(head);
  lines.push(
    `CPU ${v.cpu.totalPercent}%（user ${v.cpu.userPercent}% / sys ${v.cpu.systemPercent}% / iowait ${v.cpu.iowaitPercent}%）｜${v.cores} 核`,
  );
  lines.push(`负载 ${v.load.min1} / ${v.load.min5} / ${v.load.min15}（每核 ${v.load.perCore}）`);
  if (v.mem) lines.push(`内存 ${v.mem.percent}%（用 ${v.mem.usedGb}G / 共 ${v.mem.totalGb}G，可用 ${v.mem.availableGb}G）`);
  if (v.swap?.totalGb) lines.push(`swap ${v.swap.percent}%（用 ${v.swap.usedGb}G / 共 ${v.swap.totalGb}G）`);
  for (const d of v.disks ?? []) {
    if (d.error) lines.push(`磁盘 ${d.path}：读不到（${d.error}）`);
    else lines.push(`磁盘 ${d.path} ${d.percent}%（用 ${d.usedGb}G / 共 ${d.sizeGb}G，剩 ${d.freeGb}G）`);
  }
  if (v.cpuTemp) lines.push(`CPU 温度 ${v.cpuTemp.celsius}℃${v.nvmeTemp ? `｜NVMe ${v.nvmeTemp.celsius}℃` : ''}${v.fanRpm != null ? `｜风扇 ${v.fanRpm}rpm` : ''}`);
  if (v.warnings?.length) lines.push(`⚠️ 没取到：${v.warnings.join('；')}`);
  return lines.join('\n');
}

export function renderTop(v) {
  const lines = [`按${v.sortBy === 'memory' ? '内存' : 'CPU'}排前 ${v.rows.length} / 共 ${v.total} 个进程`];
  for (const r of v.rows) {
    const cmd = r.cmdline ? ` ${r.cmdline}` : '';
    lines.push(`${r.name}${cmd}｜pid ${r.pid}｜CPU ${r.cpuPercent}%｜内存 ${r.memPercent}%（${r.rssMb}MB）｜${r.user}`);
  }
  return lines.join('\n');
}

export function renderAlerts(v) {
  if (v.ok) return `体检正常（线：CPU ${v.thresholds.cpuPercent}% / 内存 ${v.thresholds.memPercent}% / 磁盘 ${v.thresholds.diskPercent}% / 温度 ${v.thresholds.tempCelsius}℃ / 负载 ${v.thresholds.loadPerCore}·核）`;
  return [`${v.issues.length} 项超线：`, ...v.issues.map((i) => `${i.level === 'critical' ? '🔥' : '⚠️'} ${i.text}`)].join('\n');
}
