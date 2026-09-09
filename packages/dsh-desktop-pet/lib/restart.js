import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 独立助手等待旧进程退出后再启动，防止端口争用；不经 shell 执行参数。
const [pid, cwd, ...args] = process.argv.slice(2)
const directory = join(homedir(), '.dsh', 'logs')
mkdirSync(directory, { recursive: true })
const log = openSync(join(directory, 'desktop-pet-restart.log'), 'a', 0o600)
const cancel = setTimeout(() => process.exit(1), 10000)
process.once('message', () => {
  clearTimeout(cancel)
  const deadline = Date.now() + 15000
  const wait = setInterval(() => {
    try {
      process.kill(Number(pid), 0)
      if (Date.now() > deadline) process.exit(1)
    } catch (error) {
      if (error.code !== 'ESRCH') process.exit(1)
      clearInterval(wait)
      const child = spawn(process.execPath, args, { cwd, env: process.env, detached: true, stdio: ['ignore', log, log] })
      child.once('error', () => process.exit(1))
      child.once('spawn', () => { closeSync(log); child.unref() })
    }
  }, 250)
})
process.send('ready')
