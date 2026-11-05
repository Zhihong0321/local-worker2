// One handler per process. The final stdout line is the worker's answer.
import { pathToFileURL } from 'node:url';

const [file, keyword] = process.argv.slice(2);
const write = process.stdout.write.bind(process.stdout);
const exit = process.exit.bind(process);
let finished = false;

function finish(answer) {
  if (finished) return;
  // Serialize before marking finished so serialization errors are caught too.
  const line = JSON.stringify(answer);
  finished = true;
  write('\n' + line + '\n', () => exit(0));
}

function fail(error) {
  finish({ ok: false, error: String(error?.message ?? error) });
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
// An unresolved promise alone does not keep Node alive. Let the worker time it out.
setInterval(() => {}, 60_000);
console.log = console.error.bind(console);
console.info = console.log;
console.debug = console.log;

try {
  const handler = await import(pathToFileURL(file).href);
  if (typeof handler.default !== 'function') throw new Error('the handler has no default export function');
  const result = await handler.default(keyword);
  finish({ ok: true, meta: handler.meta ?? null, result });
} catch (error) {
  fail(error);
}
