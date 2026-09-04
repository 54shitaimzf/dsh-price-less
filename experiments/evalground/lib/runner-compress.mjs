/**
 * Compression steps — the per-mode compression logic extracted from the runner
 * loop so `runSession` stays a pure orchestrator (setup → loop → teardown).
 * This is a PURE MOVE of the branches: event order, conditions, log strings
 * and snapshot shapes are byte-identical to the inlined originals.
 *
 *   wholeSurfaceStep  — the DSH-native controls (`native-auto` trigger-at-
 *                       threshold / `manual-habit` human-habit rules) and the
 *                       legacy threshold-triggered modes (mock/semantic/…).
 *                       Checked before EVERY model request.
 *   taskBoundaryStep  — the plugin task-boundary arm (self-*): compress the
 *                       closed segment when the NEXT staged message is a new
 *                       segment head (premarked boundaries; PTC compressor).
 *
 * Both mutate the shared `ctx` state bag in place (the messages list, the
 * counters in `st`, `compressSnapshots`) exactly as the inlined code mutated
 * its closure variables. `st` fields:
 *   compressCount / degenerateCount / lastPromptTokens (whole-surface)
 *   sectionCount / retainNode / segmentEntriesStart    (task-boundary)
 */
import fs from 'node:fs'
import path from 'node:path'
import { compressOnce, compressWithProgram, enrichRefs, productPath, frameNativeSummary } from './compress.mjs'
import { makeCompressorBindings } from './compressor-io.mjs'
import { attachRetainDetail } from './retain-detail.mjs'
import { renderProduct, renderSection, renderRetain } from './assemble.mjs'
import { boundaryRegion, contextWireTokens, estimateMessagesTokens, shouldTrigger } from './prefix.mjs'
import { calibrateThresholds, compressionDomain } from './arm-spec.mjs'
import { selectCompactableRange } from './native-range.mjs'
import { detectHumanTrigger, extractFocusSet, buildFocusDirective } from './manual-habit.mjs'

/**
 * The whole-surface compression check (native controls + legacy modes).
 * Called once per loop iteration, ONLY while
 * `compressionMode !== 'none' && !taskBoundary && st.compressCount < maxCompressions`.
 */
export async function wholeSurfaceStep(ctx) {
  const { opts, messages, append, logger, guard, task, a2, callLLM, provider, model, st, compressSnapshots, transcriptPath } = ctx
  const compressionMode = ctx.compressionMode
  const maxCompressions = ctx.maxCompressions
  if (ctx.isNativeWhole) {
    // ---- trigger (deterministic, mechanical) ----
    // `opts.calibrated` (offline tests) overrides the config-derived task-scale
    // calibration so a small scripted run can force the trigger/range to fire.
    const calib = opts.calibrated ?? calibrateThresholds()
    const domain = opts.compressionDomain ?? compressionDomain()
    let fired = null
    // F10a: production triggers on the WIRE-anchored size (exact usage anchor +
    // small delta estimate). Offline tests that force triggers pass
    // `opts.calibrated` and keep the pure message estimate (scripted usage is
    // tiny; the anchor would never reach the forced threshold).
    const roundTokens = opts.calibrated
      ? estimateMessagesTokens(messages)
      : contextWireTokens(st, messages)
    if (ctx.nativeAuto) {
      if (roundTokens >= calib.thresholdTokens) fired = { trigger: 'pressure', roundTokens }
    } else {
      const at = detectHumanTrigger({ messages, transcript: ctx.transcript, domain, currentTokens: roundTokens })
      if (at) fired = { ...at, roundTokens }
    }
    if (fired) {
      // ---- range select over the CONVERSATION surface (M0 严格原生: exclude
      // system ONLY — real native is head-anchored from surface[0] = the task). ----
      const surface = messages.slice(1)
      const { retainTokens } = calib
      const range = selectCompactableRange(surface, retainTokens)
      if (!range) {
        // no compactable range → the retain budget swallowed the surface.
        // A transient no-op (e.g. the conversation surface is still empty) is
        // NOT a degenerate control; the control is only degenerate if it ends
        // having NEVER compressed (asserted after the loop, see the return).
        st.degenerateCount++
        logger(`${compressionMode} skip: no compactable range (retain ${retainTokens}); surface too small this round`)
      } else {
        const start = 1 + range.startIdx
        const end = 1 + range.endIdx
        const focus = ctx.manualHabit ? extractFocusSet({ task, transcript: ctx.transcript }) : null
        const res = await compressOnce({
          task,
          mode: 'native',
          a2, reference: opts.reference, sourceFlag: opts.sourceFlag,
          focusDirective: focus ? buildFocusDirective(focus) : undefined,
          callLLM, provider, model,
          // Cache-reuse (DSH-native transport): the summarizer call must be a
          // GENUINE PREFIX of the last routed request so the provider reuses the
          // KV cache. The replayed prefix = the conversation UP TO AND INCLUDING
          // the region end (`messages[0..end]`) — not just `[system]` + the region
          // slice, which would DROP every message between system and the region
          // (e.g. the task instruction at index 1) and diverge → cache miss. The
          // instruction is appended as the final user message, exactly DSH-native.
          prefix: { messages: messages.slice(0, end + 1), tools: ctx.makeSchemas() },
        })
        if (res.ok && res.product) {
          const cpMsg = frameNativeSummary(res.product.summary)
          const before = JSON.parse(JSON.stringify(messages))
          const rebuilt = [...messages.slice(0, start), cpMsg, ...messages.slice(end + 1)]
          messages.length = 0
          messages.push(...rebuilt)
          // F10a: the rebuild invalidates the send-time anchor — cold path
          // until the next routed request re-anchors exactly.
          st.lastPromptTokens = 0
          st.lastCompletionTokens = 0
          st.lastPromptMsgCount = null
          compressSnapshots.push({ range: { start, end }, before, after: JSON.parse(JSON.stringify(messages)) })
          st.compressCount++
          append({ type: 'compress', mode: compressionMode, inputTokens: res.usage?.inputTokens ?? estimateMessagesTokens([cpMsg]), outputTokens: res.usage?.outputTokens ?? null, cacheReadTokens: res.usage?.cacheReadTokens ?? 0, range: { start, end } })
          logger(`compressed ${st.compressCount}/${maxCompressions} (${compressionMode}) fired=${fired.trigger} range=[${start}..${end}]`)
          try { fs.writeFileSync(productPath(path.dirname(transcriptPath)), JSON.stringify(res.product, null, 2)) } catch (e) { logger(`persist product failed: ${e.message}`) }
        } else {
          guard.violations.push(`compression-failed:${compressionMode}:${(res.problems ?? []).join(';')}`)
          append({ type: 'gateway-error', message: `${compressionMode} compression failed: ${(res.problems ?? []).join('; ')}` })
          // Cost discipline (2026-09): a failed compression is STILL a real LLM
          // call whose usage the gateway billed. Land it as a `compress` event
          // with ok:false so collectCompressUsage (which filters every
          // `compress` entry) accounts the failed call's tokens+USD instead of
          // silently dropping them. Zero-usage failures (network error, mock)
          // record 0 and stay out of the ledger by the inputTokens>0 gate.
          append({ type: 'compress', mode: compressionMode, ok: false, problems: (res.problems ?? []).slice(0, 3), inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0, cacheReadTokens: res.usage?.cacheReadTokens ?? 0 })
          logger(`${compressionMode} compression FAILED — continuing with full context`)
        }
      }
    }
  } else {
    const roundTokens = estimateMessagesTokens(messages)
    if (shouldTrigger(ctx.triggerThreshold)(roundTokens)) {
      const res = await compressOnce({
        task,
        mode: compressionMode === 'mock' ? 'mock' : compressionMode,
        mockProduct: opts.mockProduct,
        reference: opts.reference,
        a2,
        sourceFlag: opts.sourceFlag,
        callLLM, provider, model,
        // Cache-reuse (DSH-native transport): reuse the caller's own session
        // prefix (system+tools+messages) so the summarizer call hits the
        // provider KV cache instead of cold-billing every compression.
        prefix: { messages, tools: ctx.makeSchemas() },
      })
      if (res.ok && res.product) {
        // rebuild context: keep [system, task instruction], then inject P
        const keep = messages.slice(0, 2)
        const pUser = { role: 'user', content: '# 压缩上下文（历史已整理，勿重复执行已完成步骤）\n' + renderProduct(res.product) }
        messages.length = 0
        messages.push(...keep, pUser)
        // F10a: rebuild invalidates the wire anchor (same as the native path).
        st.lastPromptTokens = 0
        st.lastCompletionTokens = 0
        st.lastPromptMsgCount = null
        st.compressCount++
        append({ type: 'compress', mode: compressionMode, inputTokens: res.usage?.inputTokens ?? estimateMessagesTokens([pUser]), outputTokens: res.usage?.outputTokens ?? null, cacheReadTokens: res.usage?.cacheReadTokens ?? 0 })
        logger(`compressed ${st.compressCount}/${maxCompressions} (${compressionMode}) at roundTokens≈${roundTokens}`)
        // persist the compressed product so the run can be audited offline
        // (P.json under runs/<runDir>/compressed/; model-unreachable).
        try { fs.writeFileSync(productPath(path.dirname(transcriptPath)), JSON.stringify(res.product, null, 2)) } catch (e) { logger(`persist product failed: ${e.message}`) }
      } else {
        guard.violations.push(`compression-failed:${compressionMode}:${(res.problems ?? []).join(';')}`)
        append({ type: 'gateway-error', message: `compression failed ${compressionMode}: ${(res.problems ?? []).join('; ')}` })
        // Same cost discipline as the native branch above: a failed compression
        // is a real billed call — its usage must not vanish.
        append({ type: 'compress', mode: compressionMode, ok: false, problems: (res.problems ?? []).slice(0, 3), inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0, cacheReadTokens: res.usage?.cacheReadTokens ?? 0 })
        logger(`compression FAILED (${compressionMode}) — continuing with full context`)
      }
    }
  }
}

/**
 * The task-boundary compression step (self-* arms). Called at a stage DONE,
 * ONLY while `taskBoundary && boundaryMark` and another stage remains. Compress
 * the just-closed segment when the NEXT staged message is a new segment head
 * (per the preprocessed boundary mark); rebuild the context with an immutable
 * section node (+ the transient S1 retain bridge).
 */
export async function taskBoundaryStep(ctx, stageIndex) {
  const { opts, messages, transcript, append, logger, guard, task, a1, a2, callLLM, provider, model, st, compressSnapshots, transcriptPath, compGates, workspace, boundaryMark } = ctx
  const segs = boundaryMark.boundaries ?? []
  const nextSeq = stageIndex + 1
  const segAt = segs.find(b => b.startSeq === nextSeq)
  if (segAt && segAt.startSeq > 0) {
    const roundTokens = estimateMessagesTokens(messages) // diagnostic only (not a gate)
    // M4: the previous S1 hot-bridge is TRANSIENT — deleted on the next
    // compaction, never compressed into a product. The splice happens AFTER the
    // compressor call below, not here: while the bridge is still in `messages`
    // the replay stays a byte-aligned super-prefix of the last routed request
    // (the property the comment below promises → provider cache reuse). Splicing
    // first diverges the replay at the bridge position and drops compressor
    // cache hits to the ~1-2K head (measured mtng8ctd: bridge-spliced seg4 hit
    // 1,024 tok vs bridge-free seg3 hit 96%). The bridge is kept out of the
    // compression REGION by identity filter in boundaryRegion() — it is never
    // product material.
    const bridgeToDrop = st.retainNode
    st.retainNode = null
    // The closed segment's raw work = the messages AFTER the immutable section
    // nodes (minus any pending bridge). Compressor input = the CURRENT messages
    // (they carry the segment's closing DONE too): the newest bytes are only the
    // last reply, so the input is still a super-set-prefix of the last routed
    // request → provider cache reuse; and the model sees the segment's closing
    // statement (it is part of the raw work). NOT a slice that would break the
    // prefix near the sections.
    const region = boundaryRegion(messages, st.sectionCount, bridgeToDrop)
    const before = JSON.parse(JSON.stringify(messages))
    if (region.length === 0) {
      logger(`task-boundary seg=${segAt.segmentIndex}: closed segment has no raw work; nothing to compress`)
      // M4 (cont.): empty-region path still owes the one-shot drop (no compressor
      // call happened, so there is nothing the replay needed the bridge for).
      if (bridgeToDrop) {
        const ri = messages.indexOf(bridgeToDrop)
        if (ri >= 0) messages.splice(ri, 1)
        logger('task-boundary: dropped previous A1-S1 retain bridge (transient, one-shot)')
      }
    } else {
      const regionTokens = estimateMessagesTokens(region)
      const segmentEntries = transcript.slice(st.segmentEntriesStart)
      const context = { transcript: segmentEntries, workspace }
      const res = await compressWithProgram({
        task, a1, a2,
        prefix: messages, // current messages (incl. the closing DONE) — a super-prefix of the last routed request (M1)
        // WIRE-prefix alignment (M5): the routed request carries the tool schemas;
        // the compressor request must carry the SAME schemas or the provider cache
        // diverges at the tools position (observed: compressor cacheRead 128 vs ~3k).
        tools: ctx.makeSchemas(),
        context, callLLM, provider, model, regionTokens,
        ratioCfg: compGates.ratioCfg, retentionCfg: compGates.retentionCfg, codeRunCfg: compGates.codeRunCfg,
      })
      // M4 (cont.): the compressor call is done — now drop the previous bridge,
      // on BOTH ok and failure paths (lifecycle unchanged: one-shot per
      // boundary). Only the replay above needed it, for cache alignment.
      if (bridgeToDrop) {
        const ri = messages.indexOf(bridgeToDrop)
        if (ri >= 0) messages.splice(ri, 1)
        logger('task-boundary: dropped previous A1-S1 retain bridge (transient, one-shot)')
      }
      if (res.ok && res.product) {
        // A2 方案1: HARNESS-side expand — resolve every ref to its real content
        // (never model-authored; stored on refs for the renderer + audit).
        if (a2 === 'expand') {
          const enrichProblems = await enrichRefs(res.product, context)
          if (enrichProblems.length > 0) {
            logger(`task-boundary expand: ${enrichProblems.join('; ')}`)
          }
        }
        // Design R (F11): the S1 retain bridge gets its near-verbatim detail
        // attached by the HARNESS — verbatim last-run results / failing lines
        // + retain-ref content — budget-capped at RETAIN_DETAIL_TOKEN_BUDGET,
        // trimmed deterministically. Runs BEFORE persist so P-<seg>.json
        // audits exactly what the renderer emits.
        if (res.product.retain) {
          const bindings = makeCompressorBindings(context)
          const detail = await attachRetainDetail(res.product, context, bindings)
          if (detail.overBudget > 0) logger(`task-boundary retain detail trimmed (over by ${detail.overBudget} tok)`)
        }
        try { fs.writeFileSync(productPath(path.dirname(transcriptPath), `P-${segAt.segmentIndex}`), JSON.stringify(res.product, null, 2)) } catch (e) { logger(`persist product failed: ${e.message}`) }
        // Assemble: keep [system, ...old sections], append the NEW section node
        // (immutable), then (S1) the transient retain bridge node. THE OLD LIVE
        // WORK IS REPLACED — its raw bytes never re-enter.
        const sectionNode = { role: 'user', content: renderSection(res.product.sections[0], { a2 }) }
        const keep = messages.slice(0, 1 + st.sectionCount)
        messages.length = 0
        messages.push(...keep, sectionNode)
        st.sectionCount++
        let retainedRefs = 0
        if (res.product.retain) {
          st.retainNode = { role: 'user', content: renderRetain(res.product.retain) }
          messages.push(st.retainNode)
          retainedRefs = (res.product.retain.refs ?? []).length
        }
        st.segmentEntriesStart = transcript.length
        st.compressCount++
        compressSnapshots.push({ range: { start: 1 + st.sectionCount - 1, end: Math.max(0, messages.length - 1) }, before, after: JSON.parse(JSON.stringify(messages)) })
        // `segmentIndex` is the segment ORDINAL (audit label); `slot` is the
        // flattened stream position of the closed segment's last message —
        // the real attribution key for splitTranscriptByTask. A segment may
        // span MULTIPLE messages (discriminator judged 'continue'), so the
        // ordinal must never be used as a message position.
        const prunedCount = (res.prunedRefs ?? []).length
        append({ type: 'task-compact', segmentIndex: segAt.segmentIndex, slot: stageIndex, pressuredTokens: regionTokens, retainedTokens: retainedRefs, retain: !!res.product.retain, ratio: res.ratio?.ratio ?? null, ratioVerdict: res.ratio?.verdict ?? null, sections: st.sectionCount, prunedRefs: prunedCount })
        append({ type: 'decision', reason: 'task-boundary', segmentIndex: segAt.segmentIndex, pressuredTokens: regionTokens, retainedTokens: retainedRefs })
        append({ type: 'compress', mode: 'task-boundary', segmentIndex: segAt.segmentIndex, inputTokens: res.usage?.inputTokens ?? regionTokens, outputTokens: res.usage?.outputTokens ?? null, cacheReadTokens: res.usage?.cacheReadTokens ?? 0, ratio: res.ratio?.ratio ?? null, pruned: prunedCount })
        logger(`task-compact seg=${segAt.segmentIndex}/${segs.length - 1} a1=${a1} a2=${a2} region=${regionTokens} ratio=${res.ratio?.verdict ?? '-'}/${res.ratio?.ratio ?? ''} retainRefs=${retainedRefs} pruned=${prunedCount} sections=${st.sectionCount}`)
      } else {
        guard.violations.push(`compression-failed:task-boundary:${(res.problems ?? []).join(';')}`)
        append({ type: 'gateway-error', message: `task-boundary compression failed: ${(res.problems ?? []).join('; ')}` })
        // Cost discipline: failed PTC call (bad program / gate reject) is still a
        // real billed LLM call — land its usage so the compression ledger counts it.
        // F9: `refusal` types model refusals separately from program errors so the
        // batch ledger can observe refusal-rate vs program-error-rate.
        append({ type: 'compress', mode: 'task-boundary', ok: false, segmentIndex: segAt.segmentIndex, refusal: res.refusal === true, problems: (res.problems ?? []).slice(0, 3), inputTokens: res.usage?.inputTokens ?? regionTokens, outputTokens: res.usage?.outputTokens ?? 0, cacheReadTokens: res.usage?.cacheReadTokens ?? 0 })
        logger(`task-boundary compression FAILED${res.refusal ? ' (model refusal)' : ''} — continuing with full context${res.refusal ? ' refusal=1' : ''}`)
      }
    }
  }
}
