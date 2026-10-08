// Offline plumbing checks. This fake transport is NOT a real-model benchmark.
import assert from 'node:assert/strict';
import {createTools} from './lab.mjs';
import {gateway, execute, oracle, runCase} from './real.mjs';
const fixture={count:40,seed:20261008};
const baseline=createTools({...fixture,latency:0,fail:true});
const g=gateway(baseline.tools);
const failureId=(await baseline.tools.list_issues()).find(x=>x.status==='open').id;
await assert.rejects(g('get_activity',{id:failureId}),/TEMPORARY_FAILURE/);
await g('get_activity',{id:failureId});
await Promise.all(Array.from({length:40},(_,i)=>g('get_activity',{id:i+1})));
assert.ok(baseline.metrics.peak_concurrency<=4);
const before=baseline.metrics.calls;
await g('get_activity',{id:failureId});assert.equal(baseline.metrics.calls,before);
await assert.rejects(g('get_owner',{id:'1'}),/INVALID_ID/);
await assert.rejects(execute('while(true){}',g,100),/CODE_TIMEOUT/);
await assert.rejects(execute('return await tools.unknown({});',g),/not a function/);
const code=`const issues=await tools.list_issues({}); const rows=[];
for(const issue of issues.filter(x=>x.status==='open')) {
let activity; try {activity=await tools.get_activity({id:issue.id});} catch(e) {if(e.message!=='TEMPORARY_FAILURE') throw e;activity=await tools.get_activity({id:issue.id});}
if(activity.days_since_reply<7) continue;
const owner=await tools.get_owner({id:issue.owner_id});if(owner.active) rows.push({issue,activity});}
return rows.sort((a,b)=>b.issue.severity-a.issue.severity||b.activity.days_since_reply-a.activity.days_since_reply||a.issue.id-b.issue.id).slice(0,5).map(x=>x.issue.id);`;
const expected=await oracle(fixture);
assert.deepEqual(await execute(code,g),expected);
for(const field of ['message','delta']) {
for(const mode of ['native','code']) {
let phase=0;
const request=async body=>{
  assert.equal(body.model,'fake');
  let message;
  if(mode==='native') {
    if(!phase++) message={role:'assistant',content:null,tool_calls:[{id:'list',type:'function',function:{name:'list_issues',arguments:'{}'}}]};
    else message={role:'assistant',content:JSON.stringify(expected)};
  } else if(!phase++) message={role:'assistant',content:null,tool_calls:[{id:'code',type:'function',function:{name:'execute_code',arguments:JSON.stringify({code})}}]};
  else { const last=body.messages.at(-1);assert.deepEqual(JSON.parse(last.content),expected);message={role:'assistant',content:last.content}; }
  return {choices:[{[field]:message}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};
};
const {report}=await runCase(mode,{...fixture,model:'fake',maxTurns:3,maxTokens:200,temperature:0,inputPrice:null,outputPrice:null},request);
assert.equal(report.correct,true);assert.equal(report.model_requests,2);assert.equal(report.total_tokens,30);assert.equal(report.estimated_cost,null);
}
}
const {report}=await runCase('native',{...fixture,model:'fake',maxTurns:1},async()=>({choices:[{message:{role:'assistant',content:'[999]'}}]}));
assert.equal(report.correct,false);assert.equal(report.total_tokens,null);
console.log('Offline plumbing verified: queue <=4, cache, retry, invalid inputs, code timeout, execution, API continuation, oracle, token totals, wrong-answer and missing-usage handling. No real model called.');
