## 你想解决什么问题

WSL 是 Windows 生态的重要组成部分，大量开发者将项目放在 WSL 发行版的 ext4 中，工作区指向 `\\wsl.localhost\<distro>\...`（微软官方支持路径）。但 dsh-ops 的文件工具运行在宿主侧，访问 WSL 工作区时每个操作经 9P 协议跨 VM 边界，扫描类操作被放大到难以使用的程度。

实测（Windows 10 19045 + WSL2 Ubuntu 24.04，同一 2093 文件目录，各运行三次取中位数）：

| 操作 | 发行版内原生 | 宿主侧经 `\\wsl.localhost`（现状） | 差距 |
| --- | --- | --- | --- |
| find 元数据扫描 | 0.002s | 2.49s | **约 1200 倍** |
| grep 全文搜索 | 0.222s | 24.45s | **约 110 倍** |

40 万+ 文件的真实目录下，全文搜索外推至小时级。

另一个结构性问题：社区已有 WSL 专项插件在发行版内提供原生工具，但与之共存时无法自动切换——模式行（如 `mode-standard`）替换官方工具后模型自然全走 ops，而插件启停是 profile 级而非会话级，无法做到"WSL 工作区会话用 WSL 工具、Windows 工作区会话用 ops"。结果是 WSL 工作区会话全程落在 9P 慢路径。

> 注：官方路线图的"后续方向"目前未包含 WSL。本 issue 按路线图结尾指引"提出使用场景请提交 issue"提交，主张 WSL 支持是 ops"针对 Windows 全方位优化"版图上尚未覆盖的一块。

## 现状与替代方案

- 源码中目前对 WSL 的唯一处理是**主动排除**：`src/shells/paths.ts` 的 `isWslBashLauncher()` 拒绝将 `System32\bash.exe` 选为候选 shell（理由正确，应保留——它是发行版启动器，不是操作调用者文件系统的 POSIX shell）。即 ops 对 WSL 没有正向支持，文件工具只能落在 9P 慢路径。
- 现在的绕法：安装 WSL 专项插件（如 dsh-wsl-tool）并用 `AGENTS.md` 约定引导模型优先用它。代价：约定对模型只是软引导、不保证被遵守；且两插件并存时工具语义混杂，专项插件的工具不在 ops 的权限/凭据围栏体系内，绕过了 ops 精心维护的安全边界。

## 建议方案（可选）

**在文件工具执行层增加 WSL 委托**：当会话 cwd 为 `\\wsl.localhost\<distro>\...` / `\\wsl$\<distro>\...` UNC 路径时，`glob` / `grep` / `read_files` 三个只读工具经 `wsl.exe -d <distro> -e ...` 路由到发行版内执行（`rg`/`find` 等），路径做 Win↔Linux 双向转换，返回值保持现有契约语义不变。

- **schema / 提示词字节影响：零。** 不新增工具名（仍经 `publicToolName()` 投影）、不改工具契约与参数 schema、系统提示词结构不变——路由在执行层内部发生，对模型完全透明；
- **低改动面**：改动集中在 `src/file/` 执行层（新增路径判定 + 委托通道模块），复用现有 `credentialPath`/`credentialRoots` 凭据围栏与 `subprocess` 服务（数据驱动 argv，不做 shell 插值），Rust worker 不动；
- **非目标（可拆后续 issue）**：写入类操作保持现状（单文件 9P 开销可接受）；`ops_batch` 与 PTC SDK 的 WSL 化；独立 `wsl-aware` 模式行；
- **回退语义**：`wsl.exe` 不可用或发行版缺失时回退现有原生 worker 路径（9P 照常可用），或按现有错误结构报错，不静默降级。

## 是否愿意提 PR

愿意，并已能本地跑通门禁。

---
*数据复现：`~/.cache`（2093 文件）上分别执行原生 `time grep -rl "the" ~/.cache` 与宿主侧对 `//wsl.localhost/Ubuntu/home/<user>/.cache` 的同等扫描。环境：DSH 桌面版 0.2.1-rc.5 + dsh-ops 最新版；Windows 10 19045；WSL2 Ubuntu 24.04。*
