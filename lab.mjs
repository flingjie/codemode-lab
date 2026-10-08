import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { appendFileSync } from 'node:fs';

export function createTools({ latency = 20, fail = false, log, count = 40, seed } = {}) {
  const metrics = { calls: 0, result_bytes: 0, failures: 0, peak_concurrency: 0 };
  let active = 0;
  const seen = new Set();
  const issues = Array.from({length: count}, (_, i) => ({
    id: i + 1, title: `Issue ${i + 1}`, severity: (i % 4) + 1,
    owner_id: (i % 8) + 1, status: i % 7 === 0 ? 'closed' : 'open',
    body: 'Synthetic diagnostic details. '.repeat(80)
  }));
  let randomState = seed === undefined ? null : seed >>> 0;
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
  const activities = new Map();
  const owners = new Map();
  for (const issue of issues) {
    if (randomState !== null) {
      issue.severity = 1 + Math.floor(random() * 4);
      issue.owner_id = 1 + Math.floor(random() * 8);
      issue.status = random() < 0.2 ? 'closed' : 'open';
    }
    activities.set(issue.id, randomState === null ? issue.id % 15 : Math.floor(random() * 15));
  }
  for (let id = 1; id <= 8; id++) owners.set(id, randomState === null ? id % 3 !== 0 : random() < 0.75);
  const failureId = seed === undefined ? 13 : issues.find(i => i.status === 'open')?.id;
  async function call(name, args, fn) {
    metrics.calls++; active++; metrics.peak_concurrency = Math.max(active, metrics.peak_concurrency);
    try {
      await new Promise(r => setTimeout(r, latency));
      if (fail && name === 'get_activity' && args.id === failureId && !seen.has(failureId)) {
        seen.add(failureId); metrics.failures++; throw new Error('TEMPORARY_FAILURE');
      }
      const value = fn(); metrics.result_bytes += Buffer.byteLength(JSON.stringify(value));
      if (log) appendFileSync(log, JSON.stringify({ name, args, ok: true }) + '\n');
      return value;
    } catch (error) {
      if (log) appendFileSync(log, JSON.stringify({ name, args, ok: false, error: error.message }) + '\n');
      throw error;
    } finally { active--; }
  }
  const tools = {
    list_issues: async () => call('list_issues', {}, () => structuredClone(issues)),
    get_activity: async ({id}) => call('get_activity', {id}, () => {
      if (!Number.isInteger(id) || id < 1 || id > count) throw new Error('INVALID_ID');
      return {id, days_since_reply: activities.get(id), comments: 'Synthetic discussion. '.repeat(100)};
    }),
    get_owner: async ({id}) => call('get_owner', {id}, () => {
      if (!Number.isInteger(id) || id < 1 || id > 8) throw new Error('INVALID_OWNER');
      return {id, active: owners.get(id), name: `Owner ${id}`, bio: 'Synthetic owner profile. '.repeat(80)};
    })
  };
  return {tools, metrics};
}

export function select(rows) {
  return rows.filter(r => r.issue.status === 'open' && r.activity.days_since_reply >= 7 && r.owner.active)
    .sort((a,b) => b.issue.severity-a.issue.severity || b.activity.days_since_reply-a.activity.days_since_reply || a.issue.id-b.issue.id)
    .slice(0,5).map(r => ({id:r.issue.id, severity:r.issue.severity, days_since_reply:r.activity.days_since_reply, owner:r.owner.name}));
}

async function reference(mode, options = {}) {
  const {tools,metrics} = createTools(options);
  let bytes = 0, boundaries = 0;
  const deliver = value => {bytes += Buffer.byteLength(JSON.stringify(value)); boundaries++; return value;};
  const start = performance.now();
  const issues = await tools.list_issues();
  if (mode.startsWith('native')) deliver(issues);
  const rows = [];
  if (mode === 'native-sequential' || mode === 'code-sequential') {
    for (const issue of issues.filter(i => i.status === 'open')) {
      const activity = await tools.get_activity({id:issue.id});
      const owner = await tools.get_owner({id:issue.owner_id});
      if (mode === 'native-sequential') {deliver(activity); deliver(owner);}
      rows.push({issue,activity,owner});
    }
  } else {
    const todo = issues.filter(i=>i.status==='open');
    // Equal fan-out for grouped-native and code-parallel; concurrency <= 4.
    for (let offset=0;offset<todo.length;offset+=2) {
      const group = await Promise.all(todo.slice(offset,offset+2).map(async issue => {
        const [activity,owner] = await Promise.all([tools.get_activity({id:issue.id}),tools.get_owner({id:issue.owner_id})]);
        return {issue,activity,owner};
      }));
      if (mode === 'native-grouped') deliver(group.flatMap(r=>[r.activity,r.owner]));
      rows.push(...group);
    }
  }
  const result = select(rows);
  if (mode.startsWith('code')) deliver(result);
  return {mode,elapsed_ms:Math.round(performance.now()-start),...metrics,
    modeled_context_bytes:bytes,modeled_observation_boundaries:boundaries,result};
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'call') {
    const {tools} = createTools({log:process.env.LAB_LOG});
    if (!Object.hasOwn(tools,args[0])) throw new Error('UNKNOWN_TOOL');
    console.log(JSON.stringify(await tools[args[0]](JSON.parse(args[1] || '{}'))));
  } else if (command === 'run') {
    const {tools,metrics} = createTools({fail:args.includes('--fail'),log:process.env.LAB_LOG});
    const program = await import(pathToFileURL(resolve(args[0])));
    const start = performance.now();
    const result = await program.default(tools);
    console.log(JSON.stringify({result,metrics,elapsed_ms:Math.round(performance.now()-start)},null,2));
  } else if (command === 'compare') {
    const reports=[];
    for (const mode of ['native-sequential','native-grouped','code-sequential','code-parallel']) reports.push(await reference(mode));
    if (!reports.every(r=>JSON.stringify(r.result)===JSON.stringify(reports[0].result))) throw new Error('RESULT_MISMATCH');
    console.log(JSON.stringify({notice:'No LLM is invoked. Context bytes and boundaries are modeled, not measured tokens or model turns.',reports},null,2));
  } else throw new Error('Usage: node lab.mjs compare | call TOOL JSON | run PROGRAM [--fail]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
