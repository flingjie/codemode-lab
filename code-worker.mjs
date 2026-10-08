import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
let sequence = 0;
const pending = new Map();
parentPort.on('message', ({id, value, error}) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  error ? p.reject(new Error(error)) : p.resolve(value);
});
const tools = Object.fromEntries(['list_issues','get_activity','get_owner'].map(name => [name,
  (args = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, {resolve, reject});
    parentPort.postMessage({type:'tool', id, name, args});
  })
]));
// VM and worker timeout are resource controls, NOT a security boundary.
try {
  const context = vm.createContext({tools});
  const result = await new vm.Script(`(async () => {${workerData.code}\n})()`)
    .runInContext(context, {timeout:1000});
  parentPort.postMessage({type:'done', value:result});
} catch (e) { parentPort.postMessage({type:'done', error:String(e.message).slice(0,1000)}); }
