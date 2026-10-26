# dsh-glances

树莓派整机监控插件。数据来自 [glances](https://github.com/nicolargo/glances) 的 REST API，
把 CPU、负载、内存、swap、磁盘、温度、风扇凑成一次快照，交给 DSH 的模型和脚本用。

```
host_status   CPU / 负载 / 内存 / swap / 磁盘 / 温度 / 风扇，一次看全
host_top      最吃 CPU 或内存的进程
host_alerts   阈值体检 + glances 自带告警
```

## 装

```bash
dsh plugin --profile <name> add link:/path/to/dsh-glances
```

`cordis.patch.yml` 会把自己的配置行插进 profile；glances 默认地址
`http://127.0.0.1:61208/api/4`，改 `baseUrl` 就能连别的机器（glances 开 `-w`）。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:61208/api/4` | glances REST 根地址 |
| `timeoutMs` | `4000` | 单次请求超时 |
| `diskPaths` | `['/']` | glances 看不见时用 statfs 兜底的路径 |
| `mountPrefix` | `/nvme0n1` | 容器里宿主 `/` 的挂载前缀，剥掉后就是宿主机路径 |
| `cpuPercent` | `85` | CPU 告警线 |
| `memPercent` | `85` | 内存告警线 |
| `swapPercent` | `85` | swap 告警线（这台机器 swap 常驻 60% 上下，别设太低） |
| `diskPercent` | `90` | 磁盘告警线 |
| `tempCelsius` | `78` | 温度告警线（树莓派 80℃ 软降频） |
| `loadPerCore` | `1.5` | 每核负载告警线 |

## 命令行

不开 dsh 也能看，`boot-notify.sh` 用的就是这条：

```bash
node lib/cli.js            # 多行详情
node lib/cli.js --line     # 一行摘要
node lib/cli.js --json     # 结构化数据
node lib/cli.js --check    # 阈值体检，超线退出码 1
```

## 三个实现细节（踩过的坑）

- **磁盘口径**：glances 跑在 docker 里，宿主 `/` 是 bind 到容器 `/nvme0n1` 的。
  插件把 `mountPrefix`（默认 `/nvme0n1`）从挂载点前缀剥掉，`/nvme0n1` → `/`、
  `/nvme0n1/boot/firmware` → `/boot/firmware`，同一设备只留最短路径，容器自己的
  `/etc/resolv.conf` 之类整条丢掉。glances 看不到的 `diskPaths` 再用 `statfs` 兜底
  （所以换容器挂载也不用改代码，配置里改 `mountPrefix` 即可）。
- **CPU 百分比要挑有效采样窗**：glances 的百分比是"上次采样到这次"的差值。隔久了第一次
  全是 0，两次请求挨太近又会给出 `total=50 / user=0` 这种自相矛盾的窗口。插件检查
  `idle+user+system+iowait ≈ 100`，不成立就改用本机 `os.cpus()` 采 400ms 现算
  （字段口径一致，`source` 标 `proc`，输出里会显示「·本机采样」），不报假数、
  也不为等 glances 的窗口卡几秒。
- **swap 常驻**：这台机器 swap 长年在 60% 上下，默认告警线设 85%，别往低调。

## 测试

```bash
node --test test/*.test.mjs    # glances 没在跑就整体跳过
```

MIT。
