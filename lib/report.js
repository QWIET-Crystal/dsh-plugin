/**
 * dsh-doctor / lib/report.js —— 分层取证与渲染（只读；不执行任何东西）
 *
 * 每一层独立取证，不因为上一层健康就跳过下一层——这条教训来自本机 2026-09-23/24 那批事故：
 *   HTTP 有应答 ≠ 服务还在；端口在听 ≠ 插件加载成功；进程在 ≠ 会话没卡死。
 *
 * 0.2.0 的两处结构性变化：
 *   1) 每条结论都有稳定 id（见 lib/findings.js），文案可以改，id 不改；
 *   2) "取不到证"是独立的一级（unknown），不再被静默压成"正常"或"故障"。
 */

import path from 'node:path';
import { readdirSync } from 'node:fs';

import { discover } from './detect.js';
import { IDS, SCHEMA_VERSION, exitCodeOf, finding, sortFindings, summarize, verdictOf, verdictText } from './findings.js';
import { inspectBundles, kernelProfileOf } from './packages.js';
import { DEFAULT_LIMITS, fenceText, localIdentity, oneLine, redact, safeReadText } from './safety.js';

/**
 * 已知故障签名 → 稳定 id + 随包案例库 id（docs/cases/<id>.md）。
 * `runbook` 是作者本机 `_ops/runbook.md` 的锚点，**不随包分发**，只做内部对齐用。
 */
export const LOG_SIGNATURES = [
    {
        re: /disabling profile plugin row "([^"]+)"[^\n]{0,300}?incompatible with dsh ([0-9][^\s:]*)/i,
        id: IDS.LOG_ABI_INCOMPATIBLE,
        level: 'fault',
        area: '插件',
        text: (m) => `插件 ${m[1]} 与内核 ${m[2]} 不兼容，已被禁用`,
        // 只有这条签名能点出"是谁"——修复计划里禁用条目要用它
        plugin: (m) => m[1],
        caseId: '2026-10-11-plugin-kernel-abi-mismatch',
        runbook: '#插件与内核 ABI 不符',
    },
    {
        re: /waiting for service: ([A-Za-z0-9_.\-]+)/i,
        id: IDS.LOG_SERVICE_REMOVED,
        level: 'warn',
        area: '插件',
        text: (m) => `有插件在等已被内核删除的服务：${m[1]}（会永久 pending）`,
        caseId: '2026-10-21-plugin-waits-removed-service',
        runbook: '#插件等已删除的服务',
    },
    {
        re: /warning: (\d+) entr(?:y|ies) did not activate/i,
        id: IDS.LOG_ENTRY_NOT_ACTIVATED,
        level: 'warn',
        area: '插件',
        text: (m) => `${m[1]} 个插件条目未激活`,
        caseId: '2026-10-21-plugin-waits-removed-service',
        runbook: '#插件等已删除的服务',
    },
    {
        re: /Failed to load plugins/i,
        id: IDS.LOG_PLUGINS_LOAD_FAILED,
        level: 'fault',
        area: '插件',
        text: () => '整个插件树加载失败',
        caseId: '2026-10-11-plugin-kernel-abi-mismatch',
        runbook: '#插件与内核 ABI 不符',
    },
    {
        re: /child process gone[^\n]{0,200}?type:\s*GPU/i,
        id: IDS.LOG_GPU_CRASH,
        level: 'warn',
        area: '渲染',
        text: () => 'GPU 子进程崩溃，渲染可能已回退到软件渲染',
        caseId: '2026-09-24-gpu-process-crash',
        runbook: '#GPU进程崩溃',
    },
    {
        re: /previous desktop run did not shut down cleanly/i,
        id: IDS.LOG_DESKTOP_UNCLEAN_EXIT,
        level: 'info',
        area: '历史',
        text: () => '上次桌面端非正常退出（历史上下文，非当前故障）',
        caseId: '2026-10-14-web-self-shutdown-by-user',
        runbook: '#外壳崩溃',
    },
    {
        re: /ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION/i,
        id: IDS.LOG_SUPPLYCHAIN_RELEASE_AGE,
        level: 'warn',
        area: '插件安装',
        text: () => '插件安装被供应链冷却期（minimumReleaseAge）挡下',
        caseId: null,
        runbook: '#插件等已删除的服务',
    },
    {
        // 注意：不能用 `[^\n]*` 这种无界间隙——在 1MB 单行日志上它是 O(n²)，
        // 实测 1.2MB 的 "EBUSY " 重复行会把主线程卡 94 秒（红队实测）。
        re: /errno:?\s*-4082|EBUSY[^\n]{0,200}?libvips/i,
        id: IDS.LOG_UPGRADE_NATIVE_BUSY,
        level: 'warn',
        area: '升级',
        text: () => '升级时原生库被占用（宿主没停）',
        caseId: '2026-10-11-desktop-upgrade-2.0.4-to-2.0.17',
        runbook: '#桌面升级需提权',
    },
];

/**
 * 扫描桌面端日志（白名单限定在该目录内），返回命中的签名。
 * 带 `capability`：没读到日志时要说清楚是"没有这个目录"还是"读不动"。
 */

/** 单行匹配样本上限：超过就取头尾各 1KB（正则只跑样本，避免 O(n²)）。 */
const LINE_SAMPLE = 2048;
/** 单文件最多扫多少行（再多的部分是历史噪声，也会拖慢主线程）。 */
const MAX_SCAN_LINES = 50000;
/** 宿主自己写的结构化启动事件（只认这个当"重启点"）。 */
const STARTUP_EVENT = /"event"\s*:\s*"shell-load\.start"/g;

function sampleLine(line) {
    const half = Math.floor(LINE_SAMPLE / 2);
    return line.slice(0, half) + '\u2026' + line.slice(-half);
}

function lastStartupIndex(text) {
    let last = -1;
    let m;
    STARTUP_EVENT.lastIndex = 0;
    while ((m = STARTUP_EVENT.exec(text))) last = m.index;
    return last;
}

export function scanDesktopLogs(env, limits) {
    const out = { hits: [], scanned: [], warnings: [], scope: 'all', capability: { ok: true, reason: null } };
    const dir = path.join(env.APPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Roaming'), 'DSH Desktop', 'logs');
    let names = [];
    try {
        names = readdirSync(dir).filter((n) => /^dsh-.*\.log$/.test(n)).sort();
    } catch (e) {
        const code = e && e.code ? String(e.code) : 'unknown';
        // 没有这个目录 = 这台机器没装桌面端，属正常；其它错误 = 取证失败
        out.capability = code === 'ENOENT' ? { ok: true, reason: 'no-desktop' } : { ok: false, reason: code };
        out.warnings.push(
            code === 'ENOENT'
                ? '桌面端日志目录不存在（非桌面端宿主正常）'
                : `桌面端日志目录读不动（${code}）—— 本次没有日志证据`,
        );
        return out;
    }
    // 只看最近 2 个文件，且按字节上限读；不遍历历史
    for (const name of names.slice(-2)) {
        const file = path.join(dir, name);
        const r = safeReadText(file, { roots: [dir], maxBytes: limits.maxLogBytes });
        if (!r.ok) {
            out.warnings.push(`日志 ${name} 读取失败：${r.reason}`);
            continue;
        }
        out.scanned.push({ file: name, bytes: r.bytes, truncated: r.truncated });
        // 只扫"最近一次启动"之后的日志：否则修好之后历史行还会反复报警（误报比不报更糟）。
        // 但**只认宿主自己写的结构化启动事件**——早先用的是裸短语，
        // 于是任何一行日志（包括插件自己的 console.log）都能"擦掉"之前的故障（红队实测 1→0）。
        const cut = lastStartupIndex(r.text);
        if (cut >= 0) out.scope = 'since-last-start';
        const currentRun = cut >= 0 ? r.text.slice(cut) : r.text;
        const lines = currentRun.split(/\r?\n/);
        const limit = Math.min(lines.length, MAX_SCAN_LINES);
        for (let li = 0; li < limit; li++) {
            const rawLine = lines[li];
            // 单行设上限：正则只跑在 ~2KB 的样本上。无界 `[^\n]*` + 1MB 单行是 O(n²)，
            // 实测 1.2MB 的 "EBUSY " 重复行让主线程卡 94 秒（红队实测，已复现）。
            const line = rawLine.length > LINE_SAMPLE ? sampleLine(rawLine) : rawLine;
            for (const sig of LOG_SIGNATURES) {
                const m = line.match(sig.re);
                if (m) {
                    out.hits.push({
                        ...finding(sig.id, sig.level, sig.area, sig.text(m), {
                            caseId: sig.caseId,
                            runbook: sig.runbook,
                            // 点名了哪个插件：修复计划里"禁用这条"必须有名字，否则不动手
                            meta: sig.plugin ? { plugin: sig.plugin(m) } : undefined,
                        }),
                        evidence: [oneLine(rawLine, 240)],
                    });
                }
            }
        }
    }    return out;
}

/**
 * 汇总一个实例的体检结论（纯计算，不做 I/O）。
 * discovery 可以带 capabilities（读不到/被截断/端口探测未知），这些直接变成 unknown。
 */
export function collectFindings(discovery, logScan, sessionScan) {
    const findings = [];
    const caps = discovery.capabilities || { homesDenied: [], profilesTruncated: [], portUnknown: [] };

    // ---- 发现层 ----
    if (discovery.homes.length === 0) {
        findings.push(
            finding(IDS.DISCOVERY_NO_HOME, 'warn', '发现', '没找到任何 DSH_HOME', {
                caseId: '2026-09-24-frontend-dead',
                runbook: '#前端进程死亡',
            }),
        );
    }
    for (const denied of caps.homesDenied) {
        findings.push(
            finding(IDS.DISCOVERY_HOME_DENIED, 'unknown', '发现', `${denied.dir} 的 profiles 目录读不动（${denied.error}），这一处没取证`, {
                meta: { dir: denied.dir, error: denied.error },
            }),
        );
    }
    if (discovery.engines.length === 0) {
        findings.push(
            finding(IDS.DISCOVERY_NO_ENGINE, 'info', '发现', '没发现 npm 全局内核或桌面端安装（只做 profile 发现）', {}),
        );
    }

    // ---- 装配层 ----
    for (const home of discovery.homes) {
        if (home.error) continue; // 已在 DISCOVERY_HOME_DENIED 里报过
        if (home.profileCount === 0) {
            findings.push(
                finding(IDS.PROFILE_NONE, 'warn', 'profile', `${home.dir} 下没有任何 profile`, {
                    caseId: '2026-09-24-frontend-dead',
                    runbook: '#前端进程死亡',
                }),
            );
        }
        for (const p of home.profiles) {
            if (p.bundles.length === 0) {
                findings.push(
                    finding(IDS.PROFILE_BUNDLES_EMPTY, 'warn', 'profile', `profile ${p.name} 的 bundles 为空（插件不会加载）`, {
                        caseId: '2026-10-11-plugin-kernel-abi-mismatch',
                        runbook: '#插件与内核 ABI 不符',
                    }),
                );
            }
            if (!p.hasPatch) {
                findings.push(finding(IDS.PROFILE_NO_PATCH, 'info', 'profile', `profile ${p.name} 没有 cordis.patch.yml（用默认装配）`, {}));
            }
        }
    }
    for (const trunc of caps.profilesTruncated) {
        findings.push(
            finding(
                IDS.PROFILE_LIMIT_REACHED,
                'unknown',
                'profile',
                `${trunc.dir} 下还有 profile 没扫（共 ${trunc.total} 个，只看了 ${trunc.scanned} 个；调大 maxProfiles 可扫全）`,
                { meta: { dir: trunc.dir, total: trunc.total, scanned: trunc.scanned } },
            ),
        );
    }

    // ---- 引擎层 ----
    for (const e of discovery.engines) {
        if (e.kind === 'desktop' && !e.kernelVersion) {
            findings.push(
                finding(IDS.ENGINE_DESKTOP_NO_KERNEL, 'info', '引擎', `桌面端 ${e.version} 没找到内置内核包（可能是精简安装）`, {}),
            );
        }
    }

    // ---- ABI 层（静态：不等出事，先看"装上能不能跑"） ----
    const kp = kernelProfileOf(discovery);
    if (kp.versions.length > 0) {
        for (const home of discovery.homes) {
            if (home.error) continue;
            for (const p of home.profiles) {
                const rows = inspectBundles(p, kp.versions, kp.dirs).filter((r) => !r.skipped);
                if (rows.length === 0) continue;

                // 没有自己的 node_modules → 多半是备份/占位 profile。
                // 逐条报"装不到"只会把真正的问题淹掉（新手尤其看不出来），聚合成一条 info 就够。
                const missing = rows.filter((r) => !r.found);
                if (!p.hasNodeModules && missing.length > 0) {
                    findings.push(
                        finding(IDS.PROFILE_LOOKS_UNINSTALLED, 'info', 'profile', `profile ${p.name} 没有自己的 node_modules（${missing.length} 个 bundle 没安装）—— 像是备份或占位目录；它被加载时这些插件不会生效`, {
                            meta: { profile: p.name, missing: missing.length, bundles: missing.map((m) => m.name) },
                        }),
                    );
                    continue;
                }

                for (const r of rows) {
                    if (!r.found) {
                        // 静态预警最高到「注意」：我们只能证明"这个 profile 里的包解析不到"，
                        // 证明不了"当前宿主正在用这个 profile"（多 profile 是常态，备份目录也算 profile）。
                        // 报成故障会在真机上刷出一片假红——基线验证时踩到过。
                        findings.push(
                            finding(IDS.ABI_BUNDLE_MISSING, 'warn', 'ABI', `profile ${p.name} 声明的 bundle ${r.name} 解析不到（该 profile 被加载时这个插件不会生效）`, {
                                caseId: '2026-10-11-plugin-kernel-abi-mismatch',
                                runbook: '#插件与内核 ABI 不符',
                                meta: { profile: p.name, bundle: r.name },
                            }),
                        );
                        continue;
                    }
                    if (r.satisfied === false) {
                        const levels = kp.versions.length === 1 ? '本机内核' : '本机各内核';
                        findings.push(
                            finding(IDS.ABI_PEER_UNSATISFIED, 'warn', 'ABI', `插件 ${r.name} 要求内核 \`${r.peer}\`，${levels} ${kp.versions.join(' / ')} 都不满足（升级前先确认这个插件有没有新版）`, {
                                caseId: '2026-10-11-plugin-kernel-abi-mismatch',
                                runbook: '#插件与内核 ABI 不符',
                                meta: { profile: p.name, bundle: r.name, peer: r.peer, kernels: kp.versions },
                            }),
                        );
                    } else if (r.satisfied === null && r.peer) {
                        findings.push(
                            finding(IDS.ABI_PEER_UNKNOWN, 'unknown', 'ABI', `插件 ${r.name} 的 peer 范围 \`${r.peer}\` 无法静态判定（不猜）`, {
                                meta: { profile: p.name, bundle: r.name, peer: r.peer },
                            }),
                        );
                    }
                }
            }
        }
    }

    // ---- 升级层：版本漂移（info，只做上下文） ----
    const kernelLabels = [];
    for (const e of discovery.engines) {
        if (e.kind === 'npm') kernelLabels.push(`npm ${e.version}`);
        else if (e.kind === 'desktop' && e.kernelVersion) kernelLabels.push(`桌面端内置 ${e.kernelVersion}`);
    }
    const distinctKernels = [...new Set(kernelLabels.map((x) => x.split(' ').pop()))];
    if (distinctKernels.length > 1) {
        findings.push(
            finding(IDS.UPGRADE_VERSION_DRIFT, 'info', '版本', `本机内核版本不一致：${kernelLabels.join(' / ')}（多宿主各跑各的内核属常见，升级后要确认对齐）`, {
                caseId: '2026-10-11-desktop-upgrade-2.0.4-to-2.0.17',
                runbook: '#桌面升级需提权',
            }),
        );
    }

    // ---- 升级层：写权限探针结果（只在 deepWriteProbe 打开时有数据） ----
    for (const w of discovery.writeProbe || []) {
        if (w.writable === false) {
            findings.push(
                finding(IDS.UPGRADE_DIR_NOT_WRITABLE, 'fault', '升级', `安装目录 \`${w.dir}\` 不可写（${w.error}）：就地升级会静默失败，必须提权安装`, {
                    caseId: '2026-10-11-desktop-upgrade-2.0.4-to-2.0.17',
                    runbook: '#桌面升级需提权',
                    meta: { dir: w.dir, error: w.error },
                }),
            );
        }
    }

    // ---- 端口层 ----
    const openPorts = new Set(discovery.running.map((r) => r.port));
    const declared = new Set(discovery.declaredPorts);
    for (const port of declared) {
        if (!openPorts.has(port)) {
            findings.push(
                finding(IDS.PORT_DECLARED_NOT_LISTENING, 'warn', '运行', `profile 声明的端口 ${port} 没在监听`, {
                    caseId: '2026-09-24-frontend-dead',
                    runbook: '#前端进程死亡',
                }),
            );
        } else {
            findings.push(finding(IDS.PORT_DECLARED_LISTENING, 'ok', '运行', `端口 ${port} 在监听（profile 声明）`, {}));
        }
    }
    for (const port of openPorts) {
        if (!declared.has(port)) {
            findings.push(finding(IDS.PORT_UNDECLARED_LISTENING, 'info', '运行', `端口 ${port} 在听，但没有 profile 声明它（可能属于别的程序）`, {}));
        }
    }
    if (declared.size === 0) {
        findings.push(
            finding(IDS.PORT_NO_DECLARATION, 'info', '运行', '没有任何 profile 声明端口 —— 已按常见默认端口探测（见引擎清单的端口段）', {}),
        );
    }
    for (const u of caps.portUnknown) {
        findings.push(
            finding(IDS.PORT_PROBE_UNKNOWN, 'unknown', '运行', `端口 ${u.port} 的探测没拿到明确结果（${u.errno}）—— 既不当作"在听"，也不当作"挂了"`, {
                meta: { port: u.port, errno: u.errno },
            }),
        );
    }

    // ---- 运行层：装了却没在跑（急救包最需要的那条） ----
    // 只看 profile 声明的端口会漏掉最要命的情况：桌面端关掉了，但 43120 不是任何 profile 声明的，
    // 于是报告一片绿。这里用"本机确实装了哪个宿主"来反推"应该有哪些端口在听"。
    const probedByPort = new Map((discovery.probedPorts || []).map((p) => [p.port, p]));
    const expectedHosts = [];
    for (const e of discovery.engines || []) {
        if (e.kind === 'desktop') {
            const exe = e.dir ? path.join(e.dir, 'DSH Desktop.exe') : null;
            expectedHosts.push({ label: '桌面端', port: 43120, fix: exe ? [`start "" "${exe}"`] : [] });
        } else if (e.kind === 'npm') {
            expectedHosts.push({ label: '网页端', port: 3080, fix: ['dsh web --no-open --port 3080'] });
        }
    }
    const downHosts = [];
    for (const h of expectedHosts) {
        const p = probedByPort.get(h.port);
        if (!p || p.state !== 'closed') continue;
        downHosts.push(h);
        findings.push(
            finding(IDS.PORT_HOST_NOT_LISTENING, 'info', '运行', `${h.label}（:${h.port}）装了但没在运行`, {
                caseId: '2026-09-24-frontend-dead',
                runbook: '#前端进程死亡',
                fix: h.fix,
                meta: { headline: true, port: h.port, label: h.label },
            }),
        );
    }
    if (downHosts.length > 0 && downHosts.length === expectedHosts.length) {
        const fixes = downHosts.flatMap((h) => h.fix).slice(0, 3);
        findings.push(
            finding(IDS.PORT_ALL_HOSTS_DOWN, 'warn', '运行', `本机所有 DSH 宿主都没在运行（${downHosts.map((h) => `${h.label}:${h.port}`).join('、')}）`, {
                caseId: '2026-09-24-frontend-dead',
                runbook: '#前端进程死亡',
                fix: fixes,
                meta: { headline: true, ports: downHosts.map((h) => h.port) },
            }),
        );
    }

    // ---- 日志层 ----
    const seen = new Set();
    for (const hit of logScan.hits) {
        const key = hit.id + '|' + hit.text;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(finding(hit.id, hit.level, hit.area, hit.text, { evidence: hit.evidence, caseId: hit.caseId, runbook: hit.runbook }));
    }
    if (logScan.capability && logScan.capability.ok === false) {
        findings.push(
            finding(IDS.LOG_SCAN_DENIED, 'unknown', '日志', `桌面端日志读不动（${logScan.capability.reason}）—— 本次没有日志证据`, {}),
        );
    }
    // ---- 会话层（0.5.0）：只看统计，不带原文 ----
    if (sessionScan) {
        const sid = (id) => String(id || '').replace(/^session-/, '').slice(0, 8);
        const empties = sessionScan.emptyTurns || [];
        const collapses = sessionScan.collapses || [];
        if (empties.length) {
            const bySession = new Map();
            for (const e of empties) {
                const list = bySession.get(e.sessionId) || [];
                list.push(e.turn);
                bySession.set(e.sessionId, list);
            }
            for (const [session, turns] of bySession) {
                findings.push(
                    finding(IDS.SESSION_EMPTY_TURN, 'warn', '会话', `会话 ${sid(session)} 有 ${turns.length} 轮"空回合"：只有推理，没有正文也没有工具调用（第 ${turns.slice(0, 5).join('、')} 轮）`, {
                        caseId: '2026-11-06-reasoning-repetition-collapse',
                        meta: { session: sid(session), turns: turns.slice(0, 20), count: turns.length },
                    }),
                );
            }
        }
        for (const c of collapses.slice(0, 3)) {
            findings.push(
                finding(IDS.SESSION_REPETITION_COLLAPSE, 'warn', '会话', `会话 ${sid(c.sessionId)} 第 ${c.turn ?? '?'} 轮有一条 ${c.chars.toLocaleString()} 字符的消息，同一短语重复 ${c.count.toLocaleString()} 次（占 ${c.ratio}%）`, {
                    caseId: '2026-11-06-reasoning-repetition-collapse',
                    meta: { session: sid(c.sessionId), turn: c.turn, count: c.count, ratio: c.ratio, chars: c.chars },
                }),
            );
        }
        // 坏帧 = 这一段没取到证。红队实测：在帧里内嵌 4 字节 magic 就能让内容被静默丢弃，
        // 而且不产生任何结论——"看不见"必须变成 unknown，不能变成"没问题"。
        // 取证不完整必须变成 unknown（"看不见"≠"没问题"）：
        // 帧超限 / 帧数超限 / 成片坏行 / 硬链接跳过，任一条都要说出来
        const incomplete = [];
        if ((sessionScan.linked || 0) > 0) incomplete.push(sessionScan.linked + ' 个会话文件是硬链接（可能指向根外）');
        if (sessionScan.truncatedByFrame) incomplete.push('有会话帧解压后超过单帧上限');
        if (sessionScan.truncated) incomplete.push('会话数量或帧数超过预算，只扫了一部分');
        if ((sessionScan.badLines || 0) > 0) incomplete.push(sessionScan.badLines + ' 行会话事件解析失败');
        if (incomplete.length) {
            findings.push(
                finding(IDS.SESSION_SCAN_UNAVAILABLE, 'unknown', '会话', '会话层取证不完整：' + incomplete.join('；') + '，这一段不能当作没问题', {
                    meta: { incomplete },
                }),
            );
        }
        if ((sessionScan.droppedFrames || 0) > 0) {
            findings.push(
                finding(IDS.SESSION_SCAN_UNAVAILABLE, 'unknown', '会话', `有 ${sessionScan.droppedFrames} 个会话帧解不出来（损坏或被篡改），这一段没取证`, {
                    meta: { droppedFrames: sessionScan.droppedFrames },
                }),
            );
        }
        if ((sessionScan.scanned || []).length === 0 && (sessionScan.errors || []).length > 0) {
            findings.push(
                finding(IDS.SESSION_SCAN_UNAVAILABLE, 'unknown', '会话', `会话层没取到证：${sessionScan.errors.slice(0, 2).join('；')}`, {
                    meta: { errors: sessionScan.errors.slice(0, 5) },
                }),
            );
        }
    }

    return findings;
}

function levelTag(level) {
    return { fault: '故障', warn: '注意', unknown: '无法取证', ok: '正常', info: '信息' }[level] || '信息';
}

/** 常见宿主的默认端口（启发式标签；不据此断定归属，只帮人认端口）。 */
export const PORT_LABELS = {
    3080: '网页端 DSH 常用默认端口',
    43120: '桌面端 DSH 常用默认端口',
    19372: '桌宠 harness 常用默认端口',
    3081: '网页端备用端口',
    8080: '通用 HTTP 端口（可能被其它程序占用）',
};

function portStateText(p) {
    if (p.state === 'open') return `在听 ${p.ms}ms`;
    if (p.state === 'unknown') return `探测失败（${p.errno || '未知'}）`;
    return '未监听';
}

/** 渲染"引擎清单"（供 doctor_engines 工具返回）。 */
export function renderEngines(discovery, identity = localIdentity()) {
    const lines = [];
    lines.push(`# DSH 引擎清单（${discovery.generatedAt}）`);
    lines.push('');
    lines.push(`- 平台：${discovery.platform} · Node ${discovery.node}`);
    lines.push(`- DSH_HOME 数量：${discovery.homes.length} · 引擎安装：${discovery.engines.length} · 在监听端口：${discovery.running.length}`);
    lines.push('');
    lines.push('## DSH_HOME 与 profile');
    if (discovery.homes.length === 0) lines.push('_（无）_');
    for (const home of discovery.homes) {
        if (home.error) {
            lines.push(`- \`${redact(home.dir, identity)}\` —— **profile 目录读不动（${home.error}）**，这一处没取证`);
            continue;
        }
        lines.push(`- \`${redact(home.dir, identity)}\` —— ${home.profileCount} 个 profile`);
        for (const p of home.profiles) {
            lines.push(`  - **${p.name}**：${p.bundles.length} 个 bundle / ${p.deps.length} 个依赖${p.declaredPorts.length ? ' / 端口 ' + p.declaredPorts.join(',') : ''}`);
        }
    }
    lines.push('');
    lines.push('## 引擎安装');
    if (discovery.engines.length === 0) lines.push('_（无）_');
    for (const e of discovery.engines) {
        lines.push(`- [${e.kind}] **${e.label}**${e.kernelVersion ? ' · 内核 ' + e.kernelVersion : ''} —— \`${redact(e.path, identity)}\``);
    }
    lines.push('');
    lines.push('## 端口');
    lines.push(
        discovery.probedPorts
            .map((p) => {
                const label = PORT_LABELS[p.port] ? `（${PORT_LABELS[p.port]}）` : '';
                return `- ${p.port}${label}: ${portStateText(p)}`;
            })
            .join('\n'),
    );
    if (discovery.warnings.length) {
        lines.push('');
        lines.push('## 提示');
        for (const w of discovery.warnings) lines.push('- ' + w);
    }
    return lines.join('\n');
}

/**
 * 把一轮体检打包成**结构化 payload**（JSON 契约 / 历史落盘 / 面板 共用同一份）。
 * 渲染是它的纯函数投影，所以"人看到的"和"机读的"永远一致。
 */
export function buildCheckPayload(discovery, findings, logScan, sessionScan) {
    const summary = summarize(findings);
    const verdict = verdictOf(summary);
    return {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: discovery.generatedAt,
        environment: discovery.environment || {
            platform: discovery.platform,
            node: discovery.node,
            host: discovery.host,
            dshHome: null,
        },
        discovery: {
            homes: discovery.homes,
            engines: discovery.engines,
            declaredPorts: discovery.declaredPorts,
            probedPorts: discovery.probedPorts,
            running: discovery.running.map((r) => r.port),
            warnings: discovery.warnings,
            capabilities: discovery.capabilities || null,
        },
        // hits 里的证据行在落盘前就脱敏：runs/ 是持久化面，不能存原文
        logScan: {
            scanned: logScan.scanned || [],
            warnings: (logScan.warnings || []).map((w) => redact(w, localIdentity())),
            capability: logScan.capability || null,
            hits: (logScan.hits || []).map((h) => ({
                id: h.id,
                level: h.level,
                area: h.area,
                caseId: h.caseId || null,
                evidence: (h.evidence || []).map((e) => redact(String(e), localIdentity())),
            })),
        },
        // 会话层只留统计：扫了几个、几条命中、错误原因；原文一律不带
        sessions: sessionScan
            ? {
                  deep: Boolean(sessionScan.deep),
                  scanned: (sessionScan.scanned || []).length,
                  files: (sessionScan.scanned || []).map((s) => ({ session: String(s.sessionId || '').slice(0, 12), events: s.events, frames: s.frames, badFrames: s.badFrames })),
                  emptyTurns: (sessionScan.emptyTurns || []).length,
                  collapses: (sessionScan.collapses || []).length,
                  errors: (sessionScan.errors || []).slice(0, 3),
              }
            : null,
        findings: sortFindings(findings).map((f) => ({ ...f, text: redact(f.text, localIdentity()) })),
        summary,
        verdict,
        exitCode: exitCodeOf(verdict),
    };
}

/** 从 payload 还原渲染所需的最小 discovery（面板/工具 render 用）。 */
export function payloadToDiscovery(payload) {
    const d = payload.discovery || {};
    return {
        type: 'payload',
        generatedAt: payload.generatedAt,
        platform: (payload.environment && payload.environment.platform) || process.platform,
        node: (payload.environment && payload.environment.node) || process.version,
        host: (payload.environment && payload.environment.host) || '',
        environment: payload.environment,
        homes: d.homes || [],
        engines: d.engines || [],
        declaredPorts: d.declaredPorts || [],
        probedPorts: d.probedPorts || [],
        running: (d.running || []).map((port) => ({ port, state: 'open' })),
        warnings: d.warnings || [],
        capabilities: d.capabilities || null,
    };
}

/** 渲染完整体检报告（供 doctor_check 工具返回 / CLI 人类视图）。 */
export function renderReport(discovery, findings, logScan, identity = localIdentity()) {
    const summary = summarize(findings);
    const verdict = verdictOf(summary);
    const sorted = sortFindings(findings);
    const lines = [];
    lines.push(`# DSH 体检报告（${discovery.generatedAt}）`);
    lines.push('');
    const scanned = logScan.scanned || [];
    const hits = logScan.hits || [];
    const warnings = logScan.warnings || [];
    const scanLine = scanned.length
        ? `已扫描 ${scanned.length} 个文件：` + scanned.map((s) => `${s.file}${s.truncated ? '(截断)' : ''} ${s.bytes}B`).join('、')
        : `**未扫描**（${warnings[0] || '没有可读的桌面端日志'}）`;
    lines.push(`- 扫描日志：${scanLine}`);
    lines.push(`- 判定：${verdictText(summary, verdict)}`);
    lines.push(`- 计数：故障 ${summary.fault} · 注意 ${summary.warn} · 无法取证 ${summary.unknown} · 信息 ${summary.info} · 正常 ${summary.ok}`);
    lines.push('');
    for (const f of sorted) {
        const rb = f.caseId ? `  → 案例 \`${f.caseId}\`` : f.runbook ? `  → 对策库 ${f.runbook}` : '';
        lines.push(`- [${levelTag(f.level)}] ${f.area}：${redact(f.text, identity)}${rb}`);
        for (const cmd of f.fix || []) lines.push(`  - 复制即用：\`${cmd}\``);
    }
    if (summary.unknown > 0 && discovery.capabilities) {
        lines.push('');
        lines.push('## 无法取证（这些不是"没问题"，是"没看到"）');
        const caps = discovery.capabilities;
        if ((caps.portUnknown || []).length) lines.push(`- 端口探测失败：${caps.portUnknown.map((u) => `${u.port}(${u.errno})`).join('、')}`);
        if ((caps.homesDenied || []).length) lines.push(`- DSH_HOME 读不动：${caps.homesDenied.map((h) => `${redact(h.dir, identity)}(${h.error})`).join('、')}`);
        if ((caps.profilesTruncated || []).length) lines.push(`- profile 扫描被上限截断：${caps.profilesTruncated.map((t) => `${redact(t.dir, identity)}（${t.scanned}/${t.total}）`).join('、')}`);
        lines.push('> 想消掉这些 unknown：确认权限后重跑，或调大 `maxProfiles` / `httpTimeoutMs`。');
    }
    if (hits.length) {
        lines.push('');
        lines.push('## 证据（原始日志行，已脱敏、已围栏化）');
        const uniq = [];
        const seen = new Set();
        for (const h of hits) {
            const evidence = Array.isArray(h.evidence) ? h.evidence[0] : h.evidence;
            if (!evidence || seen.has(evidence)) continue;
            seen.add(evidence);
            uniq.push({ ...h, evidence });
        }
        for (const h of uniq.slice(0, 8)) lines.push(fenceText(redact(h.evidence, identity), { lang: 'text' }));
    }
    const notes = warnings.filter(Boolean);
    if (notes.length) {
        lines.push('');
        lines.push('## 提示');
        for (const n of notes) lines.push('- ' + redact(n, identity));
    }
    return lines.join('\n');
}

/** payload → Markdown（工具 render / 面板共用）。 */
export function renderPayload(payload, identity = localIdentity()) {
    return renderReport(payloadToDiscovery(payload), payload.findings || [], payload.logScan || { scanned: [], warnings: [] }, identity);
}

/**
 * 落盘/上网之前的脱敏版本。
 *
 * 工具返回值保留真实路径（同进程同用户，agent 要拿去做事）；
 * 但 `runs/` 是持久化面、HTTP 路由是跨进程面，两处都只能看到脱敏后的内容。
 *
 * 实现是**深拷贝式全量脱敏**，而不是「挑几个字段」。踩过的坑：第一版只处理
 * `dir`/`path`/`text`/`evidence`，漏了 `engines[].id`（`npm:C:\Users\<user>\...`），
 * 用户名直接落进了历史文件。白名单式脱敏迟早会漏，这里改成无条件递归。
 */
const STRUCTURAL_KEYS = new Set(['level', 'verdict', 'schemaVersion', 'exitCode']);

function deepRedact(value, identity, depth = 0, key = '') {
    if (depth > 16) return value;
    // 结构性字段不参与脱敏：红队实测 USERNAME=fault 会把 level:'fault' 洗成 '<user>'，
    // 于是真故障在报告里变成"全绿"，而 exitCode 仍是 2（自相矛盾且危险）。
    if (STRUCTURAL_KEYS.has(key)) return value;
    if (typeof value === 'string') return redact(value, identity);
    if (Array.isArray(value)) return value.map((v) => deepRedact(v, identity, depth + 1, key));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v, identity, depth + 1, k);
        return out;
    }
    return value;
}

export function redactPayload(payload, identity = localIdentity()) {
    return deepRedact(payload, identity);
}

export { DEFAULT_LIMITS, discover };
