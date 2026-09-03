/**
 * Whitelist tool executor for the eval agent loop. Every call is logged as
 * evidence (transcript). No network tools; `run` is regex-whitelisted.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { guardPath } from './workspace.mjs'
import { ALLOW, inScope } from './allow.mjs'

const MAX_READ_BYTES = 200 * 1024
const MAX_READ_CHARS = 24000
const MAX_WRITE_BYTES = 500 * 1024
const MAX_FILES = 400
// allow: npm test / npm run check / node --test (files list) / node --test tests/ (directory)
// Path segments may not contain '..' (traversal). `runAllowed` is the single
// source of truth used by both the tool and the assertion suite.
const RUN_RE = /^(npm test|npm run check|node --test(?: --test-isolation=none)? (?:tests\/[\w.-]+(?: tests\/[\w.-]+)*|tests\/))$/
export function runAllowed(command) {
  return RUN_RE.test(command) && !command.includes('..')
}
export { MAX_READ_BYTES, MAX_READ_CHARS, MAX_WRITE_BYTES, MAX_FILES }

export const TOOL_NAMES = ['read', 'write', 'glob', 'grep', 'run']

export function createTools(workspace, log, taskId, allowedPaths) {
  const violations = []
  // Single-task: `allowedPaths` absent → ALLOW[taskId] (current behavior).
  // Cascade: `allowedPaths` = the UNION of all task ALLOW scopes (shared
  // relaudit workspace across the whole stream) — minimal & least-buggy scope.
  const writeScope = allowedPaths ?? ALLOW[taskId] ?? null // null = unknown; deny nothing extra

  function fileCount() {
    let n = 0
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.tmp-')) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else n++
      }
    }
    walk(workspace)
    return n
  }

  const tools = {
    read(rel) {
      let file
      try { file = guardPath(workspace, rel) } catch (e) { violations.push(`read-outside:${rel}`); return `ERROR ${e.message}` }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return `ERROR not found: ${rel}`
      if (fs.statSync(file).size > MAX_READ_BYTES) return `ERROR file too large (> ${MAX_READ_BYTES} bytes): ${rel}`
      const text = fs.readFileSync(file, 'utf8')
      return text.length > MAX_READ_CHARS ? text.slice(0, MAX_READ_CHARS) + `\n…[truncated ${text.length - MAX_READ_CHARS} chars]` : text
    },

    write(rel, content) {
      let file
      try { file = guardPath(workspace, rel) } catch (e) { violations.push(`write-outside:${rel}`); return `ERROR ${e.message}` }
      // upfront scope enforcement (mirrors mech ALLOW): no write outside the task's
      // allowed paths, including tests/ and package.json tampering.
      if (writeScope !== null && !inScope(rel, writeScope)) {
        violations.push(`write-denied:${rel}`)
        return `ERROR path not allowed for this task (allowed: ${writeScope.join(', ')}): ${rel}`
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) return `ERROR content too large (> ${MAX_WRITE_BYTES} bytes)`
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
      return `OK wrote ${rel} (${Buffer.byteLength(content, 'utf8')} bytes)`
    },

    glob(pattern) {
      const base = path.basename(pattern)
      const dirRel = path.dirname(pattern)
      const dir = dirRel === '.' ? workspace : guardPath(workspace, dirRel)
      if (!fs.existsSync(dir)) return '[]'
      const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.') + '$')
      const out = []
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name.startsWith('.tmp-')) continue
          const full = path.join(d, e.name)
          if (e.isDirectory()) { if (base.includes('**')) walk(full); continue }
          if (re.test(e.name)) out.push(path.relative(workspace, full).replaceAll('\\', '/'))
        }
      }
      walk(dir)
      return JSON.stringify(out.slice(0, 200))
    },

    grep(pattern, subDir = '.') {
      const dir = subDir === '.' ? workspace : guardPath(workspace, subDir)
      if (!fs.existsSync(dir)) return '[]'
      let re
      try { re = new RegExp(pattern) } catch { return 'ERROR invalid regex' }
      const hits = []
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name.startsWith('.tmp-')) continue
          const full = path.join(d, e.name)
          if (e.isDirectory()) { walk(full); continue }
          if (full.endsWith('.tgz') || full.endsWith('.png')) continue
          try {
            const text = fs.readFileSync(full, 'utf8')
            const lines = text.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) hits.push(`${path.relative(workspace, full).replaceAll('\\', '/')}:${i + 1}:${lines[i].slice(0, 200)}`)
              if (hits.length >= 120) return
            }
          } catch { /* binary skip */ }
          if (hits.length >= 120) return
        }
      }
      walk(dir)
      return JSON.stringify(hits)
    },

    run(command) {
      if (!runAllowed(command)) { violations.push(`run-denied:${command}`); return Promise.resolve(`ERROR command not whitelisted: ${command}`) }
      return new Promise((resolve) => {
        try {
          const [rawCmd, ...args] = command.split(' ')
          // Windows: .cmd shims (npm/npx) cannot be execFile'd directly — run via cmd.exe.
          const viaCmd = process.platform === 'win32' && (rawCmd === 'npm' || rawCmd === 'npx')
          const cmd = viaCmd ? 'cmd.exe' : rawCmd
          const execArgs = viaCmd ? ['/d', '/s', '/c', command] : args
          execFile(cmd, execArgs, { cwd: workspace, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            const out = `${stdout ?? ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.slice(0, 20000)
            resolve(err === null
              ? `OK exit=0\n${out}`
              : `EXIT=${err.code ?? 'fail'}\n${out}`.slice(0, 20000))
          })
        } catch (error) {
          violations.push(`run-spawn-failed:${String(error).slice(0, 120)}`)
          resolve(`ERROR spawn failed: ${String(error)}`)
        }
      })
    },
  }

  for (const name of TOOL_NAMES) log({ type: 'tool-dispatch', tool: name })

  const guard = {
    canWrite(rel) { // file-count cap before write
      const count = fileCount()
      if (count >= MAX_FILES) { violations.push('file-count-exceeded'); return false }
      return true
    },
    violations,
  }
  return { tools, guard }
}
