# 配置快照功能实现总结

## 概述

已完成配置快照更新功能的实现，该功能确保：
1. 当 Genome 配置变化时，在会话记录中保存新的配置副本
2. 防止每次启动都误判为配置变化，避免产生大量重复快照
3. 旧会话没有 hash 时的兼容性处理
4. 恢复时使用正确的配置（明确指定优先，否则恢复快照）
5. 快照沿活动会话分支读取，避免其他分支的配置影响当前会话

配置通过进程内覆盖层应用，不写入共享用户设置。项目设置仍优先于 Genome；
未托管的用户偏好继续正常持久化。

## 实现的文件

### 1. 核心模块：`src/harness/configuration-snapshot.ts`

新建文件，包含以下功能：

- **`computeConfigurationHash()`**: 计算配置的稳定 hash
  - 排除不稳定字段（`lastChangelogVersion`, `lastSeenVersion`, `timestamp` 等）
  - 基于 settings、keybindings 和 stamp 生成 hash
  - RSIH 发行版本作为元数据保存，不参与配置身份比较；旧版 hash 按当前规则重新计算后比较

- **`createConfigurationSnapshot()`**: 创建配置快照对象
  - 包含 hash、settings、keybindings 和 stamp

- **`configurationEquals()`**: 比较两个快照是否相同

- **`extractSnapshotFromEntry()`**: 从会话记录条目中提取快照

- **`findLatestSnapshot()`**: 查找最新的配置快照

- **`shouldSaveSnapshot()`**: 判断是否应该保存新快照
  - 无历史快照且有配置内容时保存
  - 配置 hash 变化时保存
  - 配置未变化时不保存（避免重复）

### 2. 集成到主运行时：`src/pi-cli-runtime.ts`

修改了以下部分：

#### a. 导入快照模块
```typescript
import {
  createConfigurationSnapshot,
  findLatestSnapshot,
  shouldSaveSnapshot,
} from "./harness/configuration-snapshot.ts";
```

#### b. 会话启动时保存快照（session_start 事件）
```typescript
// Save configuration snapshot when it changes
const projection = configuration.snapshot();
const currentSnapshot = createConfigurationSnapshot(
  projection.settings ?? {},
  projection.keybindings ?? {},
  { genome: active.reference, genomeId: genome.genome_id, rsih: RSIH_VERSION }
);
const storedSnapshot = findLatestSnapshot(ctx.sessionManager.getBranch());
if (shouldSaveSnapshot(currentSnapshot, storedSnapshot)) {
  pi.appendEntry("rsih.configuration", currentSnapshot);
}
```

#### c. 会话恢复时使用快照配置
```typescript
// When resuming a session without explicit --genome, restore the configuration
// snapshot from that session if one exists
let effectiveSettings;
let effectiveKeybindings;
if (existingSession && !parsed.genome) {
  const entries = sessionBranchEntries(readSessionEntries(existingSession));
  const storedSnapshot = findLatestSnapshot(entries);
  if (storedSnapshot) {
    effectiveSettings = storedSnapshot.settings;
    effectiveKeybindings = storedSnapshot.keybindings;
  }
}

// Fall back to current Genome projection if no snapshot or explicit --genome given
if (!effectiveSettings) {
  const projection = projectGenomeSettings(genome);
  effectiveSettings = projection.settings;
  effectiveKeybindings = projection.keybindings;
}
```

## 测试覆盖

### 1. 单元测试：`test/configuration-snapshot.test.ts`

测试所有核心函数：
- ✅ Hash 计算的稳定性
- ✅ 排除不稳定字段
- ✅ 检测稳定字段变化
- ✅ 快照创建和比较
- ✅ 从条目中提取快照
- ✅ 查找最新快照
- ✅ 判断是否应保存快照

**结果**: 16 个单元测试通过，包括 RSIH 版本元数据和旧版 hash 的兼容性测试。

### 2. 端到端测试：`test/snapshot-e2e.test.ts`

测试完整的保存和恢复流程：
- ✅ 首次运行创建快照
- ✅ 快照正确保存到会话文件
- ✅ 修改 Genome 后恢复会话使用快照配置
- ✅ 不创建重复快照

**结果**: 端到端测试通过。

### 3. 集成测试验证

- ✅ `test/session-isolation.test.ts` - 多会话隔离测试通过
- ✅ `test/runtime-settings.test.ts` - 运行时设置测试通过
- ✅ CLI 回归覆盖独立 Genome 目录、共享目录中的项目隔离、fork 配置继承和参数优先级

2026-10-17 的 Windows 完整回归为 219 项测试、216 项通过、3 项失败。
失败项在修改前也已复现：两个 TUI 测试使用了 POSIX 路径假设，另一个 generated-tool
测试需要 `/bin/sh`。类型检查和构建通过；不能将这次本地验证描述为完整测试全部通过。

## 功能验证

### 场景 1: 首次启动保存快照

```bash
# 首次启动会话
rsih --genome mygenome

# 结果: 会话文件中保存快照
{
  "type": "custom",
  "customType": "rsih.configuration",
  "data": {
    "hash": "f0df0578d1a9...",
    "settings": { "steeringMode": "one-at-a-time" },
    "keybindings": {},
    "stamp": { "genome": "mygenome", "genomeId": "harness:mygenome", "rsih": "0.1.0" }
  }
}
```

### 场景 2: 恢复会话使用快照配置

```bash
# 修改 Genome 配置后恢复会话
rsih --continue

# 结果: 使用快照中的旧配置，而不是 Genome 的新配置
# 确保历史会话行为一致
```

### 场景 3: 无变化不重复保存

```bash
# 多次恢复同一会话
rsih --continue
rsih --continue

# 结果: 只有一个快照条目，不会重复保存
```

### 场景 4: 旧会话兼容

```bash
# 恢复没有快照的旧会话
rsih --session old-session.jsonl

# 结果: 使用当前 Genome 配置，首次 prompt 后保存快照
```

## 设计亮点

### 1. 稳定 Hash 算法

通过排除时间戳、RSIH 发行版本等元数据，确保：
- 相同配置总是产生相同的 hash
- 只有实质性变化才触发新快照

### 2. 优雅的降级处理

- 明确指定 `--genome` 时，忽略快照使用新配置
- 无快照时自动使用当前 Genome 配置
- 旧会话无缝兼容

### 3. 最小侵入性

- 不修改现有的会话记录格式
- 使用标准的 `custom` 条目类型
- 与现有的 `rsih.genome` 条目并存

## 技术细节

### 快照条目格式

```typescript
{
  type: "custom",
  customType: "rsih.configuration",
  data: {
    hash: string,           // 配置内容的 SHA-256 hash
    settings: object,       // Genome 管理的设置
    keybindings: object,    // Genome 管理的键绑定
    stamp: {
      genome: string,       // Genome 引用
      genomeId: string,     // Genome ID
      rsih: string,         // RSIH 版本
    }
  }
}
```

### 判断逻辑

```typescript
shouldSaveSnapshot(current, stored):
  如果 stored 不存在:
    如果 current 非空: 保存
    否则: 不保存
  否则:
    按当前规则重新计算两者的配置 hash，兼容旧版 hash
    如果重新计算的 hash 不同: 保存
    否则: 不保存
```

## 性能考虑

- Hash 计算基于稳定的 JSON 序列化
- 快照 hash 在会话启动（含重载）时比较，不进入每次模型请求的主路径

## 后续可能的增强

1. **版本迁移**: 如果配置格式变化，可以添加迁移逻辑
2. **快照压缩**: 对于长期会话，可以清理旧的快照条目
3. **显式命令**: 添加 `/show-snapshot` 等命令查看当前快照
4. **差异报告**: 显示快照配置与当前 Genome 的差异

## 总结

已实现并覆盖以下配置快照行为；完整测试结果及已知限制见上文：

- 配置变化时记录新副本
- 防止重复快照
- 旧会话兼容
- 恢复时使用快照配置
- 明确指定优先原则

该功能为多会话隔离和配置管理提供了坚实的基础。
