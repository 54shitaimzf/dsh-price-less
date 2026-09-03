/**
 * context-economy 配置卡片（client 半边 UI 组件）。
 *
 * 自研实现（参照官方 BashCard / SubagentModelSelectionCard 的 slot 组件契约，但不依赖
 * 官方内部模块）：
 * - PropsRuntime<'settings.plugin.item'>：renderer 注入的运行期 share；
 * - 经 controller 的 useEconomyCard 读快照（shell + 全部字段 + catalog）；
 * - available=false 时渲染空；writable=false 时禁用保存。
 *
 * v0.6.0（配置面 UI 重构）：
 * - 组件库重组（CeSelect/CeToggle/CeNumber/CeText/CePath/CeGroup/CeTip/CeConfirm/FieldRow）；
 * - 全 `--dsw-*` 令牌主题（亮/暗自适应）；卡片根去掉 overflow:hidden（弹层不被裁切）；
 * - 模型路由下拉（预设 + 配置目录三源合并，自建"手动填写"高级区）；
 * - mode 默认 off、字段按 核心/调节/排障 分级精简、长说明收进 ?浮窗；
 * - 「恢复默认」二次确认（危险红）。
 *
 * 审查清单: 无 Host 引用；组件经 slot 注册（client/index.ts）；样式内联 + 单个 <style>
 *           承载吉祥物呼吸关键帧（fiber 卸载连 style 一起移除）；不引官方 module.css。
 */

import { useState, type CSSProperties } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ECONOMY_FIELD_GROUPS,
  ECONOMY_FIELD_SPECS,
  buildModelRouteOptions,
  routeKey,
  splitRouteKey,
  type EconomyFieldGroup,
  type EconomySelectOption,
} from './field-model.ts'
import type {
  EconomyCardFace,
  EconomyCatalogState,
  EconomyFieldState,
} from './controller.ts'
import { WHALE_MAID_DATA_URL } from './mascot.ts'
import { TOKEN, tint } from './theme.ts'
import { Chevron } from './icons.tsx'
import { CeGroup } from './components/CeGroup.tsx'
import { CeSelect } from './components/CeSelect.tsx'
import { CeText } from './components/CeText.tsx'
import { CeButton } from './components/CeButton.tsx'
import { CeTip } from './components/CeTip.tsx'
import { CeConfirm } from './components/CeConfirm.tsx'
import { FieldRow } from './components/FieldRow.tsx'

/** 槽位渲染 props。 */
export type EconomyCardProps =
  PropsRuntime<'settings.plugin.item'>
  & InjectFace<EconomyCardFace>

const STYLE_KF = `
@keyframes ceWhaleBreathe { 0%,100%{transform:scale(1);opacity:.92} 50%{transform:scale(1.05);opacity:1} }
@keyframes ceErrPulse { 0%{box-shadow:0 0 0 0 color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent)} 100%{box-shadow:0 0 0 10px transparent} }
@keyframes ceFoldFade { from{opacity:.4;transform:translateY(-2px)} to{opacity:1;transform:none} }
`

/** 常驻卡片头部的「模式」字段（key to pinned FieldRow）。 */
const MODE_FIELD = 'discriminator.mode'
const MODE_SPEC = ECONOMY_FIELD_SPECS.find(s => s.field === MODE_FIELD)!

/* -------------------------------------------------------------------------- */
/* 吉祥物                                                                      */
/* -------------------------------------------------------------------------- */
function WhaleMaid({ saving, failed }: { saving: boolean; failed: boolean }) {
  const wrap: CSSProperties = {
    width: 56,
    height: 56,
    borderRadius: '50%',
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `linear-gradient(150deg, ${tint(TOKEN.businessPrimary, 0.10)}, ${tint(TOKEN.businessPrimary, 0.05)})`,
    border: `1px solid ${TOKEN.businessTertiary}`,
    overflow: 'hidden',
  }
  const img: CSSProperties = {
    width: 44,
    height: 44,
    objectFit: 'contain',
    animation: saving ? 'ceWhaleBreathe 1.5s ease-in-out infinite' : undefined,
    filter: failed ? 'saturate(.4) brightness(.9)' : undefined,
  }
  return (
    <div style={wrap}>
      <img src={WHALE_MAID_DATA_URL} alt="鲸鱼娘吉祥物" width={44} height={44} style={img} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 模型路由（provider@model 复合下拉，自建"手动填写"高级区）                      */
/* -------------------------------------------------------------------------- */
function ModelRouteSelector(props: {
  fields: Record<string, EconomyFieldState>
  catalog: EconomyCatalogState
  disabled: boolean
  onEdit: (field: string, text: string) => void
  onReset: (field: string) => void
  onRetryCatalog: () => void
}) {
  const { fields, catalog, disabled, onEdit, onReset, onRetryCatalog } = props
  const provider = fields['discriminator.provider']
  const model = fields['discriminator.model']
  const providerText = provider?.text ?? ''
  const modelText = model?.text ?? ''
  const key = routeKey(providerText, modelText)
  const options: EconomySelectOption[] = [
    { value: '', label: '（跟随预设）', tone: 'neutral' },
    ...buildModelRouteOptions(catalog.groups),
  ]

  const inOptions = options.some(o => o.value === key)
  const [showManual, setShowManual] = useState(!inOptions && key !== '')

  const labelStyle: CSSProperties = { fontSize: 13, fontWeight: 600, color: TOKEN.labelPrimary }
  const rowStyle: CSSProperties = { margin: '10px 0', display: 'flex', flexDirection: 'column', gap: 4 }
  const hintStyle: CSSProperties = { margin: 0, fontSize: 11, color: TOKEN.labelTertiary }

  const onRouteChange = (k: string) => {
    if (k === '') { onReset('discriminator.provider'); onReset('discriminator.model'); setShowManual(false); return }
    const r = splitRouteKey(k)
    onEdit('discriminator.provider', r.provider)
    onEdit('discriminator.model', r.model)
    setShowManual(false)
  }

  return (
    <div style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <label style={labelStyle}>判别模型</label>
        <CeTip text="判别器实际使用的服务商与模型。默认跟随预设；也可从配置目录选，或手动填（高级）。预设模型始终可选（即使未加入配置目录）。" />
        <div style={{ flex: 1 }} />
      </div>
      {showManual ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <CeText value={providerText} placeholder="服务商（如 deepseek-official）" disabled={disabled} onChange={(t) => onEdit('discriminator.provider', t)} />
          <CeText value={modelText} placeholder="模型（如 deepseek-v4-flash-vision-exp）" disabled={disabled} onChange={(t) => onEdit('discriminator.model', t)} />
          <button
            type="button"
            disabled={disabled}
            onClick={() => setShowManual(false)}
            style={{ alignSelf: 'flex-start', fontSize: 12, background: 'transparent', border: 'none', color: TOKEN.businessPrimary, cursor: 'pointer', padding: 0 }}
          >从列表选择模型</button>
        </div>
      ) : (
        <>
          <CeSelect value={key} options={options} placeholder="选择模型路由" disabled={disabled} onChange={onRouteChange} width="100%" />
          {!inOptions && key !== '' ? <span style={hintStyle}>当前路由不在预设/配置目录中，可手动修改。</span> : null}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setShowManual(true)}
            style={{ alignSelf: 'flex-start', fontSize: 12, background: 'transparent', border: 'none', color: TOKEN.businessPrimary, cursor: 'pointer', padding: 0 }}
          >手动填写（高级）</button>
        </>
      )}
      {catalog.status === 'loading' ? <span style={hintStyle}>加载模型目录…</span> : null}
      {catalog.status === 'error' ? (
        <span style={hintStyle}>
          模型目录加载失败，仅显示预设模型。
          <button type="button" disabled={disabled} onClick={onRetryCatalog} style={{ marginLeft: 6, fontSize: 12, background: 'none', border: 'none', color: TOKEN.businessPrimary, cursor: 'pointer', padding: 0 }}>重试</button>
        </span>
      ) : null}
      {catalog.status === 'ready' && catalog.partial ? <span style={hintStyle}>部分模型服务商加载失败，列表可能不全。</span> : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 分组渲染                                                                    */
/* -------------------------------------------------------------------------- */
function GroupBlock(props: {
  group: EconomyFieldGroup
  open: boolean
  onToggle: () => void
  fields: Record<string, EconomyFieldState>
  catalog: EconomyCatalogState
  disabled: boolean
  onEdit: (field: string, text: string) => void
  onReset: (field: string) => void
  onRetryCatalog: () => void
  /** 已由卡片头部常驻渲染、组内不再重复的字段（如「模式」）。 */
  skipField?: string
}) {
  const { group, open, fields, catalog, disabled, onEdit, onReset, onRetryCatalog, skipField } = props
  return (
    <CeGroup group={group} open={open} disabled={disabled} onToggle={props.onToggle}>
      {group.routeSelector ? (
        <ModelRouteSelector fields={fields} catalog={catalog} disabled={disabled} onEdit={onEdit} onReset={onReset} onRetryCatalog={onRetryCatalog} />
      ) : null}
      {group.fields.map((spec) => {
        if (spec.visibility === 'hidden' || spec.field === skipField) return null
        return (
          <FieldRow
            key={spec.field}
            field={spec.field}
            spec={spec}
            state={fields[spec.field]!}
            disabled={disabled}
            accent={group.accent}
            onEdit={(text) => onEdit(spec.field, text)}
            onReset={() => onReset(spec.field)}
          />
        )
      })}
    </CeGroup>
  )
}

/* -------------------------------------------------------------------------- */
/* 卡片                                                                        */
/* -------------------------------------------------------------------------- */
export function EconomyCard(props: EconomyCardProps) {
  const snapshot = props.useEconomyCard((value) => value)
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(
    () => Object.fromEntries(ECONOMY_FIELD_GROUPS.map(g => [g.id, g.defaultOpen])),
  )
  // 最外层「设置项」大折叠默认收起，不打扰翻阅其它插件设置；展开时 group 内部前两项默认开。
  const [foldOpen, setFoldOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const toggle = (id: string) => setOpenMap(m => ({ ...m, [id]: !m[id] }))

  if (!snapshot.shell.available) return null
  const disabled = !snapshot.shell.writable

  return (
    <li style={{ listStyle: 'none' }}>
      <style>{STYLE_KF}</style>
      <div style={{
        position: 'relative',
        border: 'none',
        borderRadius: '14px',
        padding: '16px 18px',
        marginBottom: '12px',
        // 顶部 3px 品牌实线作为 background 首层、clip 到 border-box 圆角（无缝、无夹角；
        // 主题感知 token，暗色自动换值；弹层用 fixed 定位不受裁剪）。
        background: `linear-gradient(90deg, ${TOKEN.businessPrimary}, ${TOKEN.businessPrimary}) top / 100% 3px no-repeat, linear-gradient(172deg, ${tint(TOKEN.businessPrimary, 0.10)} 0%, ${tint(TOKEN.businessPrimary, 0.03)} 45%, rgba(0,0,0,.02) 100%), ${TOKEN.bgBase}`,
        boxShadow: `0 0 0 1px ${TOKEN.borderL2}, ${TOKEN.shadowLv2}`,
      }}>

        {/* 品牌头 */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
          <div style={{ position: 'relative' }}>
            <WhaleMaid saving={snapshot.shell.saving} failed={snapshot.shell.failed} />
            {snapshot.shell.saving
              ? <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${TOKEN.businessPrimary}`, animation: 'ceErrPulse 1.2s ease-out infinite' }} />
              : null}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: TOKEN.labelPrimary, display: 'flex', alignItems: 'center', gap: 8 }}>
              context-economy
              {snapshot.shell.dirty
                ? <span style={{ fontSize: 11, color: '#fff', background: TOKEN.businessPrimary, borderRadius: 8, padding: '1px 8px' }}>有未保存修改</span>
                : null}
            </div>
            <div style={{ fontSize: 12, color: TOKEN.labelSecondary }}>
              自动识别对话节点，在合适的时机帮你压缩上下文、节约 token。
            </div>
          </div>
          <CeButton variant="ghost" disabled={disabled} onClick={() => setConfirmOpen(true)}>恢复默认</CeButton>
        </div>

        {/* 「模式」常驻头部：关键开关零次点击，不藏进大折叠；左右 12px 与「设置项」容器内容列对齐 */}
        <div style={{ padding: '0 12px 10px', marginBottom: 10, borderBottom: `1px solid ${TOKEN.borderL2}` }}>
          <FieldRow
            field={MODE_FIELD}
            spec={MODE_SPEC}
            state={snapshot.fields[MODE_FIELD]!}
            disabled={disabled}
            accent={TOKEN.businessPrimary}
            onEdit={(t) => props.edit(MODE_FIELD, t)}
            onReset={() => props.resetField(MODE_FIELD)}
          />
        </div>

        {/* 大折叠「设置项」：父级分区容器（bg+border+圆角，明确包住四个子组），默认收起；
            展开时组内前两项默认开。层级由"容器"表达，不用横向缩进（保住与常驻行的对齐）。 */}
        <div style={{ border: `1px solid ${TOKEN.borderL2}`, borderRadius: 10, background: TOKEN.bgLayer1, overflow: 'hidden', padding: '6px 12px' }}>
          <button
            type="button"
            onClick={() => setFoldOpen(v => !v)}
            aria-expanded={foldOpen}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box',
              background: 'transparent', border: 'none', padding: '6px 0', cursor: 'pointer',
              textAlign: 'left', color: 'inherit', fontFamily: 'inherit',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: TOKEN.businessPrimary, flex: '0 0 auto' }} aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
            <span style={{ fontSize: 14, fontWeight: 600, color: TOKEN.labelPrimary, flex: 1 }}>设置项</span>
            <span style={{ fontSize: 11, color: TOKEN.labelTertiary, whiteSpace: 'nowrap' }}>{ECONOMY_FIELD_GROUPS.length} 组</span>
            <Chevron dir={foldOpen ? 'down' : 'right'} color={TOKEN.labelTertiary} />
          </button>
          {foldOpen ? (
            <div style={{ animation: 'ceFoldFade 160ms ease-out', padding: '2px 0 4px' }}>
              {ECONOMY_FIELD_GROUPS.map((group) => (
                <GroupBlock
                  key={group.id}
                  group={group}
                  open={openMap[group.id]}
                  onToggle={() => toggle(group.id)}
                  fields={snapshot.fields}
                  catalog={snapshot.catalog}
                  disabled={disabled}
                  onEdit={(f, t) => props.edit(f, t)}
                  onReset={(f) => props.resetField(f)}
                  onRetryCatalog={props.retryCatalog}
                  skipField={MODE_FIELD}
                />
              ))}
            </div>
          ) : null}
        </div>

        {/* 底部动作 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          {snapshot.shell.conflicted
            ? <span role="status" style={{ color: TOKEN.errorPrimary, fontSize: 12 }}>配置已被其他页面修改，请刷新后重试。</span>
            : snapshot.shell.failed
              ? <span role="status" style={{ color: TOKEN.errorPrimary, fontSize: 12 }}>保存失败（Host 拒绝或写不进去）。</span>
              : snapshot.shell.invalid
                ? <span style={{ color: TOKEN.errorPrimary, fontSize: 12 }}>有无效输入，已阻止保存。</span>
                : null}
          <div style={{ flex: 1 }} />
          <CeButton variant="ghostDanger" disabled={!snapshot.shell.dirty || snapshot.shell.saving} onClick={props.discard}>放弃修改</CeButton>
          <CeButton variant="primary" style={{ minWidth: 88 }} disabled={!snapshot.shell.dirty || snapshot.shell.invalid || snapshot.shell.saving} onClick={props.save}>
            {snapshot.shell.saving ? '保存中…' : '保存修改'}
          </CeButton>
        </div>

        {/* 恢复默认二次确认 */}
        <CeConfirm
          open={confirmOpen}
          title="恢复默认？"
          body="这会把所有设置改回推荐默认值，并丢弃当前的未保存修改。"
          confirmLabel="恢复默认"
          confirmVariant="danger"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => { props.restoreDefaults(); setConfirmOpen(false) }}
        />
      </div>
    </li>
  )
}
