import { createTools, select } from './lab.mjs';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const schema = (name, description, properties = {}, required = []) => ({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const id = {type:'integer',description:'ID obtained from a previous tool response'};
export const definitions = [
  schema('list_issues','Returns ALL issues: array of {id,title,severity,owner_id,status,body}.'),
  schema('get_activity','Returns {id,days_since_reply,comments}.',{id},['id']),
  schema('get_owner','Returns {id,active,name,bio}.',{id},['id'])
];
const executeDefinition = schema('execute_code',
  'Execute JavaScript async function BODY. tools.list_issues({}), tools.get_activity({id}), tools.get_owner({id}) are available, returning promises. Use return to return JSON. No imports, console, fetch or filesystem API. Use variables, loops and Promise.all. Results only enter model context when returned. VM is not a security sandbox.',
  {code:{type:'string'}},['code']);

export function gateway(rawTools, maxCalls = 1000) {
  let active = 0, used = 0;
  const waiting = [], cache = new Map(), attempts = new Map();
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };
  const acquire = async () => { if(active >= 4) await new Promise(r => waiting.push(r)); else active++; };
  return async (name, args = {}) => {
    if (!Object.hasOwn(rawTools, name)) throw new Error('UNKNOWN_TOOL');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_ARGS');
    if (name !== 'list_issues' && !Number.isInteger(args.id)) throw new Error('INVALID_ID');
    const key = name + ':' + (name === 'list_issues' ? '' : args.id);
    if (cache.has(key)) return cache.get(key);
    const promise = (async () => {
      await acquire();
      try {
        if (++used > maxCalls) throw new Error('TOOL_BUDGET_EXCEEDED');
        const n = (attempts.get(key) || 0) + 1;
        attempts.set(key,n);
        if (n > 2) throw new Error('RETRY_BUDGET_EXCEEDED');
        return await rawTools[name](args);
      } finally { release(); }
    })();
    cache.set(key,promise);
    try { return await promise; } catch (e) { cache.delete(key); throw e; }
  };
}

export function execute(code, invoke, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./code-worker.mjs', import.meta.url), {workerData:{code},resourceLimits:{maxOldGenerationSizeMb:128}});
    let finished = false;
    const finish = (error, value) => {
      if(finished) return; finished=true; clearTimeout(timer); worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('CODE_TIMEOUT')), timeout);
    worker.on('error', e => finish(e));
    worker.on('exit', () => {if(!finished) finish(new Error('WORKER_EXIT'));});
    worker.on('message', async m => {
      if(m.type === 'done') return finish(m.error ? new Error(m.error) : null,m.value);
      if(m.type !== 'tool') return;
      try { const value = await invoke(m.name,m.args); if(!finished) worker.postMessage({id:m.id,value}); }
      catch(e) { if(!finished) worker.postMessage({id:m.id,error:e.message}); }
    });
  });
}

export async function oracle(options) {
  const {tools} = createTools({...options,latency:0,fail:false});
  const rows=[];
  for(const issue of await tools.list_issues()) rows.push({issue,activity:await tools.get_activity({id:issue.id}),owner:await tools.get_owner({id:issue.owner_id})});
  return select(rows).map(r=>r.id);
}

export async function runCase(mode, config, request) {
  const fixture = {count:config.count, seed:config.seed, fail:config.fail};
  const expected = await oracle(fixture);
  const {tools,metrics} = createTools({...fixture,latency:20});
  const invoke = gateway(tools,config.count*3+20);
  const system = `Find open issues with days_since_reply >= 7 and active owners. Sort severity DESC, days_since_reply DESC, id ASC, return top 5 (or fewer if fewer qualify). Final answer MUST be a JSON array of integer issue IDs only. Obtain facts from tools; do not infer unavailable values. Both modes have host concurrency <=4, successful-result cache, max 2 attempts per tool+ID (no automatic retry); retry only TEMPORARY_FAILURE. ${mode === 'native' ? 'Use the three functions directly. You may emit parallel tool calls; host queues beyond 4.' : 'Use execute_code to compose the three tools in JavaScript. The code is an async function body with tools available. Return the answer; no exports or imports. You may repair code after errors. Tool contracts: '+definitions.map(t=>t.function.name+': '+t.function.description).join(' ')}`;
  const messages=[{role:'system',content:system},{role:'user',content:`Find the top issues from this dataset of ${config.count} issues. Return JSON IDs.`}];
  const report = {mode,...fixture,model:config.model,model_requests:0,prompt_tokens:0,completion_tokens:0,total_tokens:0,code_executions:0,code_errors:0,context_result_bytes:0,correct:false,usage_complete:true};
  const start=performance.now();
  const trace=[];
  try {
    for(let round=0;round<config.maxTurns;round++) {
      report.model_requests++;
      const response=await request({model:config.model,messages,tools:mode==='native'?definitions:[executeDefinition],max_tokens:config.maxTokens,temperature:config.temperature});
      trace.push({round,response});
      const usage=response.usage;
      for(const key of ['prompt_tokens','completion_tokens','total_tokens']) {
        if(typeof usage?.[key] !== 'number') {report[key]=null;report.usage_complete=false;}
        else if(report[key] !== null) report[key]+=usage[key];
      }
      // Some gateways return choices[0].delta (stream-style) instead of choices[0].message.
      const choice=response.choices?.[0];
      const message=choice?.message ?? choice?.delta;
      if(!message) throw new Error('INVALID_API_RESPONSE');
      // Preserve reasoning_content for providers that require it on tool continuations.
      messages.push(message);
      if(!message.tool_calls?.length) {
        const answer=JSON.parse(message.content);
        report.answer=answer;report.expected=expected;
        report.correct=JSON.stringify(answer)===JSON.stringify(expected);
        report.status=report.correct?'passed':'wrong_answer';break;
      }
      const results=await Promise.all(message.tool_calls.map(async call => {
        let result;
        try {
          const args=JSON.parse(call.function.arguments);
          if(mode==='code') {
            if(call.function.name!=='execute_code' || typeof args.code!=='string') throw new Error('INVALID_CODE_CALL');
            report.code_executions++;
            try { result=await execute(args.code,invoke); }
            catch(e) { report.code_errors++; throw e; }
          } else result=await invoke(call.function.name,args);
        } catch(e) { result={error:e.message}; }
        const content=JSON.stringify(result ?? null);
        report.context_result_bytes+=Buffer.byteLength(content);
        return {role:'tool',tool_call_id:call.id,content};
      }));
      messages.push(...results);
    }
    if(!report.status) report.status='turn_limit';
  } catch(e) {report.status='error';report.error=e.message;}
  report.elapsed_ms=Math.round(performance.now()-start);
  Object.assign(report,metrics);
  report.estimated_cost = report.prompt_tokens !== null && report.completion_tokens !== null && config.inputPrice !== null && config.outputPrice !== null
    ? (report.prompt_tokens*config.inputPrice+report.completion_tokens*config.outputPrice)/1e6 : null;
  // Aggregate token pricing ignores cached-token discounts; marked estimated only.
  return {report,trace};
}

async function main() {
  const args=process.argv.slice(2), value=(flag,fallback)=>{const i=args.indexOf(flag);return i<0?fallback:args[i+1];};
  if(!args.includes('--allow-code')) throw new Error('Pass --allow-code to acknowledge execution of model-generated code in a teaching runtime without a security sandbox.');
  const model=process.env.LLM_MODEL, base=process.env.LLM_BASE_URL, apiKey=process.env.LLM_API_KEY;
  if(!model || !base || !apiKey) throw new Error('Set LLM_MODEL, LLM_BASE_URL and LLM_API_KEY.');
  const positive=(flag,defaultValue)=>{const n=Number(value(flag,defaultValue));if(!Number.isInteger(n)||n<1) throw new Error('Invalid '+flag);return n;};
  const config={model,count:positive('--count',40),maxTurns:positive('--max-turns',80),maxTokens:positive('--max-tokens',4096),temperature:Number(value('--temperature',0)),fail:args.includes('--fail'),
    inputPrice:process.env.LAB_INPUT_PRICE ? Number(process.env.LAB_INPUT_PRICE):null,outputPrice:process.env.LAB_OUTPUT_PRICE ? Number(process.env.LAB_OUTPUT_PRICE):null};
  const runs=positive('--runs',1), firstSeed=positive('--seed',20261008);
  const out=resolve(value('--out','results/'+new Date().toISOString().replaceAll(':','-')));mkdirSync(out,{recursive:true});
  const request=async body=>{
    const r=await fetch(base.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+apiKey},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
    if(!r.ok) throw new Error('API_HTTP_'+r.status); // Do not print provider responses that may echo secrets.
    return r.json();
  };
  const reports=[];
  for(let i=0;i<runs;i++) {
    // Alternate order to reduce first-run/temporal effects; each mode gets fresh state.
    for(const mode of i%2?['code','native']:['native','code']) {
      const result=await runCase(mode,{...config,seed:firstSeed+i},request);
      reports.push(result.report);
      writeFileSync(resolve(out,`${i}-${mode}.json`),JSON.stringify(result,null,2));
      writeFileSync(resolve(out,'summary.json'),JSON.stringify({notice:'Real API responses; correctness checked against a private deterministic oracle. Local VM is not a security sandbox. Cost is optional estimate, not billing.',config,runs,reports},null,2));
      console.log(JSON.stringify(result.report));
    }
  }
  console.log('Saved '+out);
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
