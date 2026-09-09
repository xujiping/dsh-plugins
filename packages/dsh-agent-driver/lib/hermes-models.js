/** 调用同一 Hermes 安装中的终端模型目录，不使用 ACP 的单 provider 子集。 */
import { spawn } from 'node:child_process'
import { access, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

async function executable(command) {
  const candidates = isAbsolute(command) || command.includes('/')
    ? [resolve(command)] : (process.env.PATH ?? '').split(delimiter).map((dir) => resolve(dir, command))
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate } catch { /* 继续 PATH 查找 */ }
  }
  throw new Error(`找不到 Hermes 可执行文件：${command}`)
}

export async function discoverHermesModels(agent, signal) {
  if (signal?.aborted) throw new Error('模型目录读取已取消')
  const launcher = await realpath(await executable(agent.config.command))
  const file = await open(launcher, 'r')
  const buffer = Buffer.alloc(512)
  try { await file.read(buffer, 0, buffer.length, 0) } finally { await file.close() }
  const shebang = /^#!\s*(.+)/.exec(buffer.toString().split('\n')[0])?.[1]?.trim()
  const parts = shebang?.split(/\s+/) ?? []
  if (!parts.some((part) => /(?:^|\/)python[\d.]*$/.test(part))) {
    throw new Error('Hermes 模型目录需要 Python 版 hermes 启动文件，请将 command 指向实际 hermes 可执行文件')
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('模型目录读取已取消')); return }
    const child = spawn(parts[0], [...parts.slice(1), fileURLToPath(new URL('./hermes-models.py', import.meta.url)), launcher, JSON.stringify(agent.config.args), agent.permission.selectedModel ?? ''], {
      cwd: agent.session.header.cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch { /* 已退出 */ }
      error ? reject(error) : resolve(value)
    }
    const abort = () => finish(new Error('模型目录读取已取消'))
    const timer = setTimeout(() => finish(new Error('Hermes 模型目录读取超时，请重试')), 60000)
    signal?.addEventListener('abort', abort, { once: true })
    child.stderr.resume() // 上游诊断可能含配置内容，不转发给 GUI。
    child.on('error', (error) => finish(error))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.length > 2_000_000) finish(new Error('Hermes 模型目录过大'))
    })
    child.on('close', (code) => {
      if (code !== 0) { finish(new Error('Hermes 终端模型目录读取失败，请检查 Hermes 安装和 profile 配置')); return }
      try {
        const rows = JSON.parse(output)
        if (!Array.isArray(rows) || !rows.length || rows.some((row) => !row.id || !row.providerId || typeof row.label !== 'string')) throw new Error()
        finish(null, rows)
      } catch { finish(new Error('Hermes 未返回有效的终端模型目录')) }
    })
  })
}
