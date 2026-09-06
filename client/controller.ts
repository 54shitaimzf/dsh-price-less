/**
 * context-economy 配置卡片（client 半边 controller）。
 *
 * 自研等价实现（参照官方 bash-card-controller + subagent-model-selection-card-controller，
 * 但独立实现，不依赖官方内部 `./src/*` 模块）：绑定 `context-economy` settings scope，
 * 对每个字段做 staged 编辑（草稿 → 保存时统一原子写入）。
 *
 * v0.6.0（配置面 UI 重构）：
 * - 字段模型下沉到 field-model.ts（纯逻辑，可单测）：parse 返回精确错误文案、默认解析、
 *   可见性分级；
 * - 快照扩：每字段 modified / errorMessage；shell.conflicted（revision-fence 竞争保护）；
 *   catalog（模型目录：status/partial/groups）；
 * - save() 用 scope.mutate(ops, basedRevision) 原子提交（多段 path + revision 门）；
 * - 载入模型目录用于"模型路由下拉"（新会话/adapters/settings 变更时刷新）。
 *
 * 与 Host 契约（docs/11 §6）：
 * - namespace 'context-economy'；scope.getSnapshot() = { status, value, base, user, revision, writable }
 * - 写入经 scope.mutate(ops, revision) —— revision-fenced 文档变更。
 *
 * 审查清单: 纯 client；fiber 效应（dispose 清订阅/递增代际）；不依赖官方内部模块。
 * 度量: 无新增（配置变更经判账号本 call 字段可观测，docs/ledger-history.md §18）。
 */

import type { ClientRemote, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  ECONOMY_FIELD_SPECS,
  defaultForPath,
  pathSegments,
  readPath,
  userHasPath,
  type EconomyCardSettingsShape as EconomyCardSettings,
  type EconomyFieldSpec,
} from './field-model.ts'

/** 卡片编辑的配置形状（= Config schema 的可写面）。 */
/** 一个字段的暂存/显示状态。 */
export interface EconomyFieldState {
  text: string
  invalid: boolean
  /** 是否与推荐默认不同（= 应显示"复原"胶囊）。 */
  modified: boolean
  overridden: boolean
  errorMessage?: string
}

/** 模型目录状态（驱动"模型路由下拉"）。 */
export interface EconomyCatalogState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  partial: boolean
  groups: readonly ModelProviderGroup[]
}

/** 卡片整体状态。 */
export interface EconomyCardShell {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  conflicted: boolean
}

/** 一次快照。 */
export interface EconomyCardSnapshot {
  shell: EconomyCardShell
  fields: Record<string, EconomyFieldState>
  catalog: EconomyCatalogState
}

/** 卡片的 action 面（slot inject 注入给组件）。 */
export interface EconomyCardActions {
  edit(field: string, text: string): void
  resetField(field: string): void
  restoreDefaults(): void
  retryCatalog(): void
  save(): void
  discard(): void
}

/** 暂存编辑条目。 */
interface StagedEdit {
  text: string
  clear: boolean
}

/** 在 scope 值里按 spec.paths 分别读取（复合字段用 spec.format）。 */
function readPaths(value: unknown, spec: EconomyFieldSpec): unknown {
  const first = spec.paths[0]!
  return readPath(value, first)
}

/**
 * 卡片 controller：绑定 settings scope，持有 staged 草稿 + 模型目录，保存时统一原子写入。
 */
export class EconomyCardController {
  private readonly specs = new Map<string, EconomyFieldSpec>()
  private readonly staged = new Map<string, StagedEdit>()
  private saving = false
  private failed = false
  private conflicted = false
  private readonly store: SnapshotStore<EconomyCardSnapshot>
  private readonly unsubscribeScope: () => void
  private catalogGroups: readonly ModelProviderGroup[] = []
  private catalogPartial = false
  private catalogStatus: EconomyCatalogState['status'] = 'idle'
  private catalogGeneration = 0
  private basedRevision: number | undefined
  private disposed = false

  constructor(
    private readonly scope: SettingsScope<EconomyCardSettings>,
    private readonly session: Pick<ClientRemote['session'], 'modelCatalog'>,
  ) {
    for (const spec of ECONOMY_FIELD_SPECS) this.specs.set(spec.field, spec)
    this.store = createSnapshotStore(this.build())
    this.unsubscribeScope = this.scope.subscribe(() => { this.onScopeChange() })
    void this.loadCatalog()
  }

  /** store 访问（slot inject 的 hooks 面）。 */
  injectStore(): SnapshotStore<EconomyCardSnapshot> {
    return this.store
  }

  /** 卸载：停止跟随 scope + 抑制晚到的目录/写入结算。 */
  dispose(): void {
    this.disposed = true
    this.catalogGeneration += 1
    this.unsubscribeScope()
    this.staged.clear()
  }

  private onScopeChange(): void {
    if (this.saving) return
    if (this.staged.size > 0 && this.basedRevision !== undefined && this.scope.getSnapshot().revision !== this.basedRevision) {
      this.conflicted = true
    }
    this.publish()
  }

  private snapshot(): SettingsScopeSnapshot<EconomyCardSettings> {
    return this.scope.getSnapshot()
  }

  private build(): EconomyCardSnapshot {
    return {
      shell: this.shell(),
      fields: this.buildFields(),
      catalog: {
        status: this.catalogStatus,
        partial: this.catalogPartial,
        groups: this.catalogGroups,
      },
    }
  }

  private shell(): EconomyCardShell {
    const snap = this.snapshot()
    return {
      available: snap.status === 'ready',
      writable: snap.writable,
      dirty: this.staged.size > 0,
      invalid: this.hasInvalidDraft(),
      saving: this.saving,
      failed: this.failed,
      conflicted: this.conflicted,
    }
  }

  private buildFields(): Record<string, EconomyFieldState> {
    const fields: Record<string, EconomyFieldState> = {}
    for (const spec of ECONOMY_FIELD_SPECS) fields[spec.field] = this.field(spec.field)
    return fields
  }

  private field(key: string): EconomyFieldState {
    const staged = this.staged.get(key)
    const spec = this.specs.get(key)!
    const snap = this.snapshot()
    const defaultText = spec.format(spec.default)
    if (staged === undefined) {
      const text = spec.format(readPaths(snap.value, spec))
      return {
        text,
        overridden: userHasPath(snap.user, key),
        modified: text !== defaultText,
        invalid: false,
      }
    }
    if (staged.clear) {
      return { text: '', overridden: false, modified: defaultText !== '', invalid: false }
    }
    const parsed = spec.parse(staged.text)
    if (parsed.kind === 'error') {
      return { text: staged.text, overridden: false, modified: true, invalid: true, errorMessage: parsed.message }
    }
    return {
      text: staged.text,
      overridden: true,
      modified: staged.text !== defaultText,
      invalid: false,
    }
  }

  /** 组件 actions。 */
  actions(): EconomyCardActions {
    return {
      edit: (field, text) => this.stage(field, { text, clear: false }),
      resetField: (field) => this.resetField(field),
      restoreDefaults: () => this.restoreDefaults(),
      retryCatalog: () => { void this.loadCatalog() },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed && !this.conflicted) return
        this.staged.clear()
        this.failed = false
        this.conflicted = false
        this.basedRevision = undefined
        this.publish()
      },
    }
  }

  /** 单字段复原：有推荐默认 → 设为默认；无（可选覆盖/跟随预设）→ 清空。 */
  private resetField(field: string): void {
    const spec = this.specs.get(field)!
    const def = defaultForPath(field) ?? spec.default
    if (def === undefined) {
      this.stage(field, { text: '', clear: true })
    } else {
      this.stage(field, { text: spec.format(def), clear: false })
    }
  }

  /** 「恢复推荐默认」：把每个字段草稿设为推荐默认（可选覆盖清空）。 */
  private restoreDefaults(): void {
    for (const spec of ECONOMY_FIELD_SPECS) {
      const def = defaultForPath(spec.field)
      if (def === undefined) {
        this.staged.set(spec.field, { text: '', clear: true })
      } else {
        this.staged.set(spec.field, { text: spec.format(def), clear: false })
      }
    }
    this.failed = false
    this.conflicted = false
    this.publish()
  }

  private stage(key: string, edit: StagedEdit): void {
    this.staged.set(key, edit)
    this.failed = false
    if (this.basedRevision === undefined) this.basedRevision = this.scope.getSnapshot().revision
    this.publish()
  }

  private hasInvalidDraft(): boolean {
    for (const [key, edit] of this.staged) {
      if (edit.clear) continue
      const spec = this.specs.get(key)!
      if (spec.parse(edit.text).kind === 'error') return true
    }
    return false
  }

  /** 保存：校验全部暂存（非法 → 拒绝），经 scope.mutate(ops, basedRevision) 一次原子提交多段 path。 */
  private async save(): Promise<void> {
    const entries = [...this.staged]
    if (entries.length === 0 || this.saving || this.hasInvalidDraft()) return
    const snap = this.snapshot()
    if (this.basedRevision !== undefined && snap.revision !== this.basedRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    this.saving = true
    this.failed = false
    this.conflicted = false
    this.publish()
    try {
      const ops: SettingsPathOpView[] = []
      for (const [key, edit] of entries) {
        const spec = this.specs.get(key)!
        const parsed = edit.clear ? { kind: 'clear' as const } : spec.parse(edit.text)
        if (parsed.kind === 'error') continue
        if (parsed.kind === 'clear') {
          for (const p of spec.paths) ops.push({ op: 'unset', path: pathSegments(p) })
        } else {
          for (const p of spec.paths) ops.push({ op: 'set', path: pathSegments(p), value: parsed.values[p] as never })
        }
      }
      if (ops.length > 0) await this.scope.mutate(ops, this.basedRevision)
      this.staged.clear()
      this.basedRevision = undefined
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogPartial = false
    this.publish()
    try {
      const res = await this.session.modelCatalog()
      if (generation !== this.catalogGeneration) return
      if (!res.ok) throw new Error(res.error.message)
      this.catalogGroups = res.value.groups
      this.catalogPartial = res.value.failures.length > 0
      this.catalogStatus = 'ready'
    } catch {
      if (generation !== this.catalogGeneration) return
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  /** 刷新模型目录（模型/适配器/设置变更后）。 */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogGeneration += 1
    this.catalogStatus = 'idle'
    this.catalogPartial = false
    void this.loadCatalog()
  }

  private publish(): void {
    this.store.set(this.build())
  }
}

/** slot 注册注入面。 */
export type EconomyCardFace = {
  hooks: {
    economyCard: SnapshotStore<EconomyCardSnapshot>
  }
} & EconomyCardActions
