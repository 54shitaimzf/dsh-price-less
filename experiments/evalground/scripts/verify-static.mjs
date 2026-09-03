import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import path from 'node:path'

const html = process.argv[2]
const browser = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const url = pathToFileURL(path.resolve(html)).href
const dom = await new Promise((resolve) => {
  execFile(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--dump-dom', url], { timeout: 45000 }, (err, stdout) => resolve(err ? `ERR ${err.message}` : stdout))
})
console.log('DOM len:', dom.length)
console.log('no-loading:', !/加载中/.test(dom))
console.log('has-table:', /<table|tbody|<tr/.test(dom))
console.log('has-copy:', /复制修复片段/.test(dom))
console.log('has-summary:', /summary-text/.test(dom))
console.log('has-groups:', /rule-group/.test(dom))