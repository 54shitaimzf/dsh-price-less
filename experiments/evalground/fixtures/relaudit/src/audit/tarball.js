/**
 * R2 tarball structure: minimal ustar reader (zero-dependency) that lists the
 * entries of a .tgz/.tar.gz buffer.
 *
 * NOTE(planted bug): the ustar prefix field (offset 345) is ignored, so any
 * entry whose path is split into prefix+name is returned with its truncated
 * basename only — the auditor then misses undeclared files deep in subdirs.
 */

import { gunzipSync } from 'node:zlib'

const BLOCK = 512

function cstr(bytes) {
  const end = bytes.indexOf(0)
  const slice = end === -1 ? bytes : bytes.subarray(0, end)
  return slice.toString('utf8')
}

function octal(bytes) {
  const text = cstr(bytes).trim()
  return text === '' ? 0 : parseInt(text, 8)
}

/** List tar entries of a possibly gzipped ustar archive buffer. */
export function listTarballEntries(buffer) {
  const buf = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer
  const entries = []
  let off = 0
  while (off + BLOCK <= buf.length) {
    const name = cstr(buf.subarray(off, off + 100))
    const prefix = cstr(buf.subarray(off + 345, off + 345 + 155)) // PLANTED BUG: prefix ignored below
    const size = octal(buf.subarray(off + 124, off + 136))
    const type = String.fromCharCode(buf[off + 156] ?? 0x30)
    if (name === '' && size === 0) break // end-of-archive
    if (name !== '' && (type === '0' || type === '\u0000')) {
      // PLANTED BUG: should be `prefix === '' ? name : prefix + '/' + name`
      entries.push({ name, size })
    }
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK
  }
  return entries
}

/** Whether a tarball entry path is declared by the package `files` field. */
export function isDeclared(entryName, files) {
  // entryName is 'package/...' — strip the first path segment.
  const rel = entryName.replace(/^package\//, '')
  for (const f of files) {
    const dir = f.endsWith('/') ? f : null
    if (dir !== null && rel.startsWith(dir)) return true
    if (dir === null && rel === f) return true
  }
  return rel === 'package.json' ? true : false // package.json is always included
}
