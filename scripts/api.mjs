// Starts the FastAPI backend with the project's virtualenv on any OS. Usage: node scripts/api.mjs [--mock]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend');
const venvPython = join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = existsSync(venvPython) ? venvPython : 'python';

const env = { ...process.env };
if (process.argv.includes('--mock')) env.MOCK_AGENTS = '1';

const child = spawn(
  python,
  ['-m', 'uvicorn', 'app.main:app', '--reload', '--reload-dir', 'app', '--reload-dir', 'agents', '--host', '127.0.0.1', '--port', '8000'],
  { cwd: backend, env, stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
