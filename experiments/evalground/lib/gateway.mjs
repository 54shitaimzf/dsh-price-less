/**
 * Gateway transport — the SINGLE network egress of the eval ground.
 *
 * createGateway() returns a transport object with chatCall(); the real one
 * talks to an OpenAI-compatible chat endpoint (DeepSeek official API by
 * default: https://api.deepseek.com + /chat/completions; other OpenAI-style
 * endpoints work via EVAL_GROUND_BASEURL + EVAL_GROUND_API_KEY, e.g. a GLM
 * coding-plan endpoint). runner/judge/compress accept opts.callLLM so tests
 * can swap in gateway-mock (record/replay/scripted) and never touch the
 * network. Closed-world invariant: no other lib module may call fetch.
 *
 * Credential resolution (first hit wins): opts.apiKey → env EVAL_GROUND_API_KEY
 * → ~/.dsh/.credentials.yaml `EVAL_GROUND_API_KEY` → env DEEPSEEK_API_KEY →
 * credentials.yaml `DEEPSEEK_API_KEY`. Base URL: opts.baseUrl → env
 * EVAL_GROUND_BASEURL → credentials.yaml `EVAL_GROUND_BASEURL` → DeepSeek
 * official default. BASE_URL and API_KEY must pair (a DeepSeek key only auths
 * at api.deepseek.com), so both read the same two channels — the yaml forms a
 * complete provider profile without any env setup.
 *
 * 2026-09 transport pivot: opencode zen gateway fully retired (model switch =
 * new batch, annotated in EXPERIMENT.md; historical runs stay on the old
 * transport).
 */
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function readCredential(name) {
  if (process.env[name]) return process.env[name]
  try {
    const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
    const text = fs.readFileSync(file, 'utf8')
    const m = text.match(new RegExp(`^\\s+${name}:\\s*(.*)$`, 'm'))
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  } catch { /* ignore */ }
  return ''
}

export class GatewayError extends Error {
  constructor(message, { code = 'gateway', retryable = false } = {}) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
    this.retryable = retryable
  }
}

const DEFAULT_API_KEY = readCredential('DEEPSEEK_API_KEY')
const PROFILE_API_KEY = readCredential('EVAL_GROUND_API_KEY')

/**
 * Per-model protocol switches (single source of truth for gateway params).
 * Two facts verified end-to-end against the opencode zen gateway:
 *   1. Both `max_tokens` and `max_completion_tokens` are accepted (HTTP 200).
 *   2. deepseek-v4-flash returns `message.reasoning_content` (thinking mode).
 * The max-param is chosen so reasoning+content share the budget on thinking
 * models (max_completion_tokens), and falls back to max_tokens otherwise.
 * Temperature: GLM/Z.AI recommends 1 (thinking stable); the rest keep 0 for
 * deterministic eval. reasoning_effort is passed through when the caller sets it.
 */
export function protocolFor(model = '') {
  const m = String(model).toLowerCase()
  // hy3/hy4 also return message.reasoning_content (verified for hy3) — treat
  // them as thinking so they get max_completion_tokens + a generous budget and
  // don't regress into the length-cap/empty-completion problem.
  const isThinking = /flash|glm|deepseek|qwen|kimi|mimo|minimax|hy\d/.test(m)
  const isGlm = m.includes('glm')
  return {
    maxParam: isThinking ? 'max_completion_tokens' : 'max_tokens',
    temperature: isGlm ? 1 : 0,
    thinking: isThinking, // hints whether reasoning_content echo is expected
  }
}

/**
 * Build a chat-completion transport.
 * @param {object} opts { baseUrl, apiKey, defaultMaxTokens, defaultTimeoutMs, fetchImpl }
 *   fetchImpl lets offline tests provide their own fetch shim.
 */
export function createGateway(opts = {}) {
  const BASE_URL = opts.baseUrl ?? (process.env.EVAL_GROUND_BASEURL || readCredential('EVAL_GROUND_BASEURL') || 'https://api.deepseek.com')
  const API_KEY = opts.apiKey ?? (PROFILE_API_KEY || DEFAULT_API_KEY)
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch

  async function chatCall({ provider, model, messages, tools, toolChoice, maxTokens, temperature, timeoutMs = 600000, attempts = 3, reasoningEffort }) {
    if (API_KEY === '') throw new GatewayError('gateway credentials missing (set EVAL_GROUND_API_KEY or DEEPSEEK_API_KEY)')
    const proto = protocolFor(model)
    const temp = temperature ?? proto.temperature
    // Thinking models reason long; a small hard cap silently eats the content
    // budget and yields finish_reason=length with empty content/tools. Default
    // to a generous ceiling (vendor max output is far larger) so reasoning +
    // content both fit. Callers may override for judge write-ups.
    const budget = maxTokens ?? (proto.thinking ? 65536 : 8192)
    let lastError = null
    let effBudget = budget
    for (let i = 0; i < attempts; i++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const body = { model, messages, temperature: temp, stream: false }
        body[proto.maxParam] = effBudget
        if (tools) { body.tools = tools; body.tool_choice = toolChoice ?? 'auto' }
        if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort
        // OpenAI-style chat protocol requires thinking-mode reasoning_content to
        // be echoed back on the NEXT turn. Ensure the outgoing message list
        // preserves it (see the @{...reasoning_content} read below).
        body.messages = (messages ?? []).map(m => {
          const out = { ...m }
          if (m.reasoning_content !== undefined) out.reasoning_content = m.reasoning_content
          return out
        })
        const res = await fetchImpl(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!res.ok) {
          const text = (await res.text()).slice(0, 500)
          const retryable = res.status >= 500 || res.status === 429
          throw new GatewayError(`gateway ${res.status}: ${text}`, { code: `http-${res.status}`, retryable })
        }
        const data = await res.json()
        const choice = data.choices?.[0]
        const message = choice?.message
        const text = (message?.content ?? '').trim()
        const finishReason = choice?.finish_reason ?? null
        const toolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0
          ? message.tool_calls.map(tc => ({ id: tc.id, name: tc.function?.name, args: String(tc.function?.arguments ?? '') }))
          : null
        // Thinking-mode models (e.g. deepseek-v4-flash) emit reasoning_content on
        // message; it MUST be echoed back on the next assistant turn or the gateway
        // 400s ("reasoning_content in the thinking mode must be passed back"). We
        // expose it separately so callers (runner/compress/judge) can carry it.
        // GLM uses the same field name for its thinking blocks; accept a string or
        // an array (some gateways emit consecutive blocks) — normalize to string.
        const rawReasoning = message?.reasoning_content ?? message?.reasoning ?? null
        const reasoningContent = Array.isArray(rawReasoning)
          ? rawReasoning.map(b => (typeof b === 'string' ? b : b?.text ?? '')).filter(Boolean).join('\n')
          : (typeof rawReasoning === 'string' || rawReasoning == null ? rawReasoning : null)
        // finish_reason=length (output cap hit) is NOT fatal on its own: the
        // model may still return a valid tool_calls. It becomes a diagnosis
        // signal only when the model over-reasoned into an EMPTY reply (no
        // content, no tools) — then surface length-cap so the caller can raise
        // the budget / lower reasoning instead of silently killing the run.
        const isEmpty = text === '' && !(toolCalls && toolCalls.length > 0)
        if (finishReason === 'length' && isEmpty) {
          throw new GatewayError(`model hit output cap (${proto.maxParam}=${effBudget}); over-reasoned, retry with more budget`, { code: 'length-cap', retryable: true })
        }
        if (isEmpty) {
          throw new GatewayError('empty completion from gateway (no content, no tool calls)', { code: 'empty-completion', retryable: true })
        }
        const usage = {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          // OpenAI-style chat usage reports cached prompt tokens under
          // prompt_tokens_details.cached_tokens; some gateways use one of the
          // alternate names below. Read all of them so cache hits are observed.
          cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens
            ?? data.usage?.prompt_cache_hit_tokens
            ?? data.usage?.cache_read_tokens
            ?? data.usage?.prompt_cache_read_tokens
            ?? null,
          totalTokens: data.usage?.total_tokens ?? (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0),
        }
        return {
          text,
          toolCalls,
          model: data.model ?? model,
          finishReason,
          usage,
          reasoning_content: reasoningContent,
          raw: data,
        }
      } catch (error) {
        lastError = error instanceof GatewayError
          ? error
          : new GatewayError(String(error), { code: error?.name === 'AbortError' ? 'timeout' : 'network', retryable: true })
        if (!lastError.retryable) throw lastError
        // Over-reasoned cap hit: the model thinks so long it eats the whole
        // budget. Retrying against the same wall is pointless — double the
        // budget and lower reasoning effort so content/tools get room.
        if (lastError.code === 'length-cap') {
          effBudget = Math.min(effBudget * 2, 262144)
        }
        await sleep(1000 * 2 ** i)
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError
  }

  return { chatCall, baseUrl: BASE_URL }
}

/** Fixed-price estimation (USD) from real usage — same table as the repo bench. */
export function costUsd(usage, price) {
  if (!usage || !price) return null
  const fresh = Math.max(0, (usage.inputTokens ?? 0) - (usage.cacheReadTokens ?? 0))
  const c = ((fresh ?? 0) * price.inputPerM + (usage.cacheReadTokens ?? 0) * price.cacheReadPerM
    + (usage.outputTokens ?? 0) * price.outputPerM) / 1e6
  return Number(c.toFixed(8))
}

// Default transport instance used by callers that do not inject one
const defaultGateway = createGateway()
export const chatCall = defaultGateway.chatCall