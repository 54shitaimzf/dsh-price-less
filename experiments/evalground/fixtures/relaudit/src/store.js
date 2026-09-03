/**
 * JSON file store with atomic writes (tmp + rename) for runs.json/versions.json.
 */

import fs from 'node:fs'
import path from 'node:path'

export function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

export function createStore(storeDir) {
  const runsFile = path.join(storeDir, 'runs.json')
  const versionsFile = path.join(storeDir, 'versions.json')
  return {
    runsFile,
    versionsFile,
    listRuns() {
      return readJson(runsFile, [])
    },
    addRun(run) {
      const runs = this.listRuns()
      runs.push(run)
      writeJsonAtomic(runsFile, runs)
      return run
    },
    versions() {
      return readJson(versionsFile, { releases: [] })
    },
  }
}
