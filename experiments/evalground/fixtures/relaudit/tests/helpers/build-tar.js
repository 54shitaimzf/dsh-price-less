/**
 * Minimal ustar tar writer for fixture tests and the deterministic tgz builder.
 * No dependencies; fixed mtime/mode for reproducible output.
 */
const BLOCK = 512

function pad(bytes, size) {
  return Buffer.concat([bytes, Buffer.alloc(Math.max(0, size - bytes.length))])
}

function octalField(value, width = 7) {
  return Buffer.from(value.toString(8).padStart(width, '0') + '\0')
}

export function buildTar(entries) {
  const list = []
  for (const item of entries) {
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(String(item.data), 'utf8')
    let name = item.path
    let prefix = ''
    if (Buffer.byteLength(name) > 100) {
      const idx = name.lastIndexOf('/')
      prefix = name.slice(0, idx)
      name = name.slice(idx + 1)
      if (Buffer.byteLength(prefix) > 155) throw new Error(`prefix too long: ${prefix}`)
    }
    const mode = 0o755 & 0xfff
    const header = Buffer.alloc(BLOCK)
    pad(Buffer.from(name, 'utf8'), 100).copy(header, 0)
    octalField(mode & 0o7777, 7).copy(header, 100)
    octalField(0, 7).copy(header, 108)
    octalField(0, 7).copy(header, 116)
    octalField(data.length, 11).copy(header, 124)
    octalField(0, 11).copy(header, 136) // mtime 0 = 1970-01-01, deterministic
    header[156] = 0x30 // '0' regular file
    Buffer.from('ustar\0' + '00', 'ascii').copy(header, 257)
    pad(Buffer.from(prefix, 'utf8'), 155).copy(header, 345)
    // checksum: field filled with spaces first
    Buffer.from('        ', 'ascii').copy(header, 148)
    const sum = header.reduce((acc, b) => acc + b, 0)
    Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148)
    list.push(header, data, Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK - data.length))
  }
  list.push(Buffer.alloc(BLOCK * 2)) // end-of-archive
  return Buffer.concat(list)
}
