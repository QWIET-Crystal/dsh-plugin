# dsh-doctor

> A **read-first** health check plugin for [DeepSeek Harness](https://github.com/anywhere-labs/dsh-desktop) (DSH):
> discovers every engine/instance on the machine, gathers evidence layer by layer, returns findings with **stable ids**
> and an explicit **"could not verify"** state, and ships a case library grown from real incidents.

**English** · [中文](README.md)

DSH machines usually run several engines at once: an npm-global kernel, the desktop app's bundled kernel,
one or more `DSH_HOME`s (the user's `.dsh`, the desktop pet's `dsh-home`, …), and several profiles inside each home —
a profile is one plugin assembly. When something breaks, the most misleading sentence is
**"HTTP answers, so the service is alive."**

`dsh-doctor` splits that into layers, each verified independently:

| Layer | What it looks at | Why it must be separate |
| --- | --- | --- |
| Discovery | every `DSH_HOME` / profile / npm kernel / desktop install / listening port | you cannot tell "is it broken" without knowing how many engines exist |
| Ports | raw TCP connectivity (no WMI/CIM) | `Get-NetTCPConnection` silently returns empty under restricted tokens |
| Assembly | each profile's `bundles`, deps, `cordis.patch.yml` | installed but not loaded = not installed |
| ABI | can each bundle be resolved, does its `peerDependencies['@deepseek-ai/dsh']` accept this kernel | tells you **before** a kernel upgrade which plugins will break |
| Logs | known failure signatures (plugin disabled, waiting for a removed service, GPU crash, …) | some failures print **no error**, only one warn line |
| Sessions | event-stream statistics of the newest session (empty turns, repetition collapse) | the service is alive and the logs are clean, yet the model is degrading — ports can never see that |
| Verdict | fault / warn / **unknown** / info / ok + a case pointer | "I could not verify" is not the same as "it is broken" |

## Install

```bash
# as a DSH plugin (bundle)
dsh plugin --profile <name> add @qweit-crystal/dsh-doctor

# straight from GitHub
dsh plugin --profile <name> add github:QWIET-Crystal/dsh-plugin

# local dev directory (host HMR)
dsh plugin --profile <name> add "link:/path/to/dsh-plugin"
```

> ⚠️ **Package name**: the bare name `dsh-doctor` on npm belongs to an unrelated project.
> Always use the scoped name `@qweit-crystal/dsh-doctor`.

The plugin inserts one row (`cordis.patch.yml`: `id: dsh-doctor`, `name: '@qweit-crystal/dsh-doctor'`).
The entry id stays `dsh-doctor`; only the package name is scoped. The client module id must equal the package name.

Tested with DSH kernel `0.2.1-rc.2` / `0.2.1-rc.5`, Node >= 22.19.0 (24.20.0 on this machine).

## Tools

| Tool | Purpose |
| --- | --- |
| `doctor_engines` | list every engine/instance: each `DSH_HOME`, every profile's bundles/deps/declared ports, npm & desktop versions, listening ports |
| `doctor_check` | layered health check (ports / assembly / ABI / logs / **session events**) returning a **structured object** (`findings[]` with id / level / caseId / fix), rendered as Markdown too |
| `doctor_runs` | read the health history: list recent runs, or read one full run |
| `doctor_cases` | read **both** case libraries; index without args, one case by `id`, full-text search by `search` (AND across words, with matching snippets) |
| `doctor_export_kit` | export the **rescue kit** for the day every host is down |
| `doctor_case_add` | file a failure into the **local** case library (write point ①) |
| `doctor_contribute` | same, plus the one command that turns it into a PR |

## Exit codes and the JSON contract

`doctor_check` and `dsh-doctor check --json` return the same shape:

```json
{
  "schemaVersion": 1,
  "generatedAt": "…",
  "environment": { "platform": "win32", "node": "v24.20.0", "host": "<host>", "dshHome": "<home>/.dsh" },
  "discovery": { "homes": [], "engines": [], "probedPorts": [], "capabilities": {} },
  "logScan": { "scanned": [], "warnings": [] },
  "findings": [{ "id": "PORT.DECLARED.NOT_LISTENING", "level": "warn", "area": "运行", "text": "…", "caseId": "…", "fix": [] }],
  "summary": { "fault": 0, "warn": 1, "unknown": 0, "info": 4, "ok": 0, "total": 5 },
  "verdict": "warn",
  "exitCode": 1
}
```

| Verdict | Meaning | Exit code |
| --- | --- | --- |
| `fault` | a confirmed failure | 2 |
| `unknown` | **some probe could not complete**, so "green/amber" cannot be trusted | 3 |
| `warn` | something worth looking at | 1 |
| `ok` | all green | 0 |

Precedence: `fault` > `unknown` > `warn` > `ok`.

## Health history

Every run (already redacted) is written to `$DSH_HOME/dsh-doctor/runs/<time>-<contenthash>.json`:

- identical content is not rewritten inside the `cacheTtlMs` window (panel refreshes do not spam files);
- only the newest `runsRetention` runs are kept;
- only the **current host's own** `DSH_HOME` is written (writing into someone else's home would be out of bounds);
- a failed write degrades to one `info` finding — evidence must never fail because bookkeeping failed.

## Rescue kit (for the day every host is down)

The plugin lives inside the host process. If every host is dead, the plugin is not there either. So it can export
a double-clickable kit (`dsh-doctor kit --to <dir>`, or the `doctor_export_kit` tool):

| File | Purpose |
| --- | --- |
| `急救.cmd` | the double-click entry; **pure ASCII** (cmd.exe decodes batch files with the OEM code page) |
| `rescue.ps1` | Chinese menu + environment detection + actions; **UTF-8 with BOM** (PowerShell 5.1 decodes BOM-less files as ANSI) |
| `kit.json` | version / export time / plugin install path (the thin launcher uses it to find the newest code) |
| `payload/` | built-in copy (still works after the plugin is uninstalled, but goes stale) |

Seven menu actions: health check + open report · start the web host (:3080) · start the desktop app · open the kit folder ·
open the DSH config folder · **6 one-click repair** · **7 roll back the last repair** (see the section above).
Apart from 6/7 it never edits config, deletes files, or runs anything invisible, and every run writes `run-<time>.log`.

Runtime detection cascades through five levels, **each recorded in the log and report**:
`DSH_DOCTOR_NODE` → `node` on `PATH` → `%APPDATA%\npm\node.exe` → the optional portable-node package →
the desktop app with `ELECTRON_RUN_AS_NODE=1`. If none works, it falls back to a PowerShell-only check
(processes / ports / directories) and still produces a simplified HTML report.

## The two case libraries

| | shared | local |
| --- | --- | --- |
| Location | `<package>/docs/cases` | `<DSH_HOME>/dsh-doctor/cases` |
| Who writes | reviewers merge PRs; the plugin is read-only | you (`doctor_case_add`) |
| Purpose | incidents other people will hit too | this machine's quirks |

### Types: `runtime` vs `authoring`

A case declares its type in a section (defaults to `runtime` when absent):

```markdown
## 类型

authoring
```

- `runtime` — DSH runtime failures. A **judgement signature is mandatory** (lint fails without it);
- `authoring` — pitfalls hit while building plugins/tools (host schema DSL, injection, encodings). Recommended, not enforced.

### Search, promotion, template

- `doctor_cases --search "words"` / `dsh-doctor cases --search "words"`: all words must appear, case-insensitive,
  results carry the matching snippet and the case type. No similarity ranking — a miss is a miss.
- After a local case is merged into the shared library, mark it (the file is kept):
  `dsh-doctor case-promote <local-id> <shared-id>` writes `> promoted: <id>` and the index shows "already merged".
- Newcomers: fork on GitHub, add `docs/cases/<id>.md` from [`docs/cases/_TEMPLATE.md`](docs/cases/_TEMPLATE.md), open a PR.
  Files starting with `_` are ignored by lint, index and search.

## After a repair: contribute the case

When the previous run was not green and the current one is, the plugin treats it as a repair, attaches
`repair` (fixed count, fixed ids, a pre-filled case template) to the payload, and the client shows a one-time prompt:
**copy the template / open the report / ignore this one**. Ignoring is remembered per run.
The trigger is deliberately narrow — only an `ok` ↔ non-`ok` crossing counts; "5 faults down to 3" stays quiet.

## Session layer (0.5.0)

Some failures leave **ports listening, HTTP healthy and logs clean** while the model degrades — typically the
reasoning channel collapsing into one repeated phrase for tens of thousands of characters, producing "empty turns"
that still report `completed`. A service-level check can never see that.

- Session files are **multi-frame zstd**: feeding the whole file to `zstdDecompressSync` returns **only the first frame**
  (measured: a 3.2 MB / 2,481-frame file yielded 187 bytes). So this plugin walks frames by the `28 B5 2F FD` magic and
  decompresses each one.
- By default it reads the **last 1 MB of the most recent session** (measured: 951 frames / 1,529 events, whole check 0.34 s);
  `deepSessions` widens it to every session touched in the last 24 hours (2 MB tail each).
- Two verdicts:
  - `SESSION.EMPTY_TURN` (warn): a turn with reasoning only — **no text and no tool call**;
  - `SESSION.REPETITION.COLLAPSE` (warn): a single message ≥20k chars where one short unit repeats ≥100 times **and covers ≥50%**.
- **Numbers only**: turn indexes, counts and ratios. Session text never reaches the report or `runs/`.
- Playbook: [`2026-11-06-reasoning-repetition-collapse`](docs/cases/2026-11-06-reasoning-repetition-collapse.md).

## One-click repair (rescue kit 0.5.0)

`dsh-doctor plan [--json]` turns findings into an **action list** (data) that the rescue kit executes.
Action types are a closed enum — there is no "run arbitrary command" escape hatch:

| Action | Trigger | Risk | Verification |
| --- | --- | --- | --- |
| `start-service` | port not listening while that host is installed | A (automatic) | wait for the port (`LISTENING`, 30 s) |
| `disable-plugin-entry` | host log **names** a plugin that failed to load | B (per-item confirm) | file contains `disabled: true` |
| `restore-file` | broken config with an existing backup | B | content hash matches |
| — | corrupt session / ACL / kernel reinstall | C (guidance only) | no action produced |

The rescue kit exposes **6 one-click repair** (all A, ask for each B, list C) and **7 roll back the last repair**.
Every action is backup → execute → verify → log; backups live in `<kit>/backups/<timestamp>/` with a `.path`
sidecar recording the original path. Without Node it degrades to a built-in minimal plan (A-class starts only).

## Security model

- **Zero execution surface**: `lib/` never imports `child_process`/`vm`, never uses `eval`/`new Function`; a static test enforces it.
- **Two write points, both closable**: the local case library (`allowLocalCaseWrite`) and health history (`saveRuns`).
- **Whitelisted reads**: every read goes through `safeReadText` (realpath-checked roots, byte caps, `truncated` flagged).
- **Redaction on output**: usernames, host names, home/temp dirs, `ghp_*`/`sk-*`/`Bearer`/URL userinfo are replaced with placeholders.
  Files written to disk and served over HTTP are **already redacted** (recursive, not a field whitelist).
- **Anti-injection**: foreign text is neutralised before entering Markdown fences.
- **Settings route**: `/dsh-doctor/api/report` is same-origin only (no CORS headers).

## Tests and the CLI

```bash
node --test test/            # 21 files / 131 checks
node test/units.test.mjs     # run a single file directly when the sandbox blocks the test runner
node tools/lint-cases.mjs    # mechanical checks over the case library
```

```bash
dsh-doctor engines
dsh-doctor check [--html <file>] [--quiet]
dsh-doctor fix               # print copy-paste commands; never executes anything
dsh-doctor plan [--json]     # emit the repair action list (the rescue kit executes it; this command does not)
dsh-doctor check --deep-sessions   # widen the session scan to every session touched in 24h
dsh-doctor kit --to <dir>
dsh-doctor runs [name]
dsh-doctor cases [id] [--search "words"]
dsh-doctor case-promote <local-id> <shared-id>
dsh-doctor contribute --from <file> --pr
```

## Known limitations

- The session scan reads a **bounded tail** (1 MB by default, 2 MB in deep mode). A collapse that only exists in the
  middle of a very old session will not be seen; `--deep-sessions` widens the window but still reads tails, not whole files.
- The host's `output.schema` uses a **value-schema DSL**, not full JSON Schema: no `required`, and every object node
  must declare `additionalProperties`. (This costs one full activation to learn the hard way.)
- `.cmd` must stay ASCII and `.ps1` must carry a UTF-8 BOM — both are enforced by tests and at export time.
- `fs.access(dir, W_OK)` is unreliable on Windows (it checks the read-only attribute, not the ACL), so "will the next
  upgrade silently fail" is only reported as info unless `deepWriteProbe` (an opt-in real write probe) is enabled.
- The ABI check never escalates beyond `warn`: it can prove a profile is assembled wrong, not that the current host uses it.
- A rescue kit exported to the desktop leaves the npm package behind: the thin launcher follows the plugin directory,
  the built-in copy goes stale — the report says which one was used.

## License

MIT © 2026 QWIET-Crystal
