// Read this only after trying to generate your own program.
export default async function(tools) {
  const issues = (await tools.list_issues()).filter(i=>i.status==='open');
  const owners = new Map();
  async function retry(fn) {
    try {return await fn();} catch(e) {
      if(e.message !== 'TEMPORARY_FAILURE') throw e;
      return fn();
    }
  }
  const rows=[];
  for(let offset=0;offset<issues.length;offset+=4) {
    const group=await Promise.all(issues.slice(offset,offset+4).map(async issue=>{
      const activity=await retry(()=>tools.get_activity({id:issue.id}));
      return {issue,activity};
    }));
    rows.push(...group.filter(r=>r.activity.days_since_reply>=7));
  }
  // Fetch each relevant owner once. Keep tool concurrency <= 4.
  const ids=[...new Set(rows.map(r=>r.issue.owner_id))];
  for(let offset=0;offset<ids.length;offset+=4) {
    await Promise.all(ids.slice(offset,offset+4).map(async id=>owners.set(id,await tools.get_owner({id}))));
  }
  return rows.filter(r=>owners.get(r.issue.owner_id).active)
    .sort((a,b)=>b.issue.severity-a.issue.severity || b.activity.days_since_reply-a.activity.days_since_reply || a.issue.id-b.issue.id)
    .slice(0,5).map(r=>({id:r.issue.id,severity:r.issue.severity,days_since_reply:r.activity.days_since_reply,owner:owners.get(r.issue.owner_id).name}));
}
