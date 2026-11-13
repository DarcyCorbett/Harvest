import fs from 'node:fs';
import path from 'node:path';
import { hash, makeRequest, canReserve, validateOutput, verifyShopping, type Case, type Usage } from './lib/aiEvaluationCore';
import { DIR, read, save } from './lib/aiEvaluationPrepare';
import { loadGeminiKey, headers, callProvider } from './lib/aiEvaluationProviders';
import { journal, balances, resumeDisposition, validateBenchmark } from './evaluate-ai-stack';

export const MODEL = 'gemini-3.5-flash-lite';
export const PRICE = { input: .30, cached: .03, output: 2.50, checkedOn: '2026-10-10', source: 'https://ai.google.dev/gemini-api/docs/pricing' };
export const SUBDIR = 'gemini-3.5-flash-lite';
export const events35 = () => fs.existsSync(path.join(DIR,SUBDIR,'ledger.jsonl')) ? fs.readFileSync(path.join(DIR,SUBDIR,'ledger.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)) : [];
export const cost35 = (u: Usage) => (Math.max(0,u.input-u.cached)*PRICE.input+u.cached*PRICE.cached+u.output*PRICE.output)/1e6;
export function request35(c: Case, effort = c.task==='shopping'?'high':'medium') {
  if(!['minimal','low','medium','high'].includes(effort))throw Error('Unsupported Gemini thinking level');
  const original = makeRequest('gemini',c);
  const maxOutputTokens=c.task==='shopping'?16384:8192;
  const body={...original.body,generationConfig:{...(original.body as any).generationConfig,maxOutputTokens,thinkingConfig:{thinkingLevel:effort}}};
  return {url:`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,body,cfg:{provider:'gemini' as const,model:MODEL,effort,maxOutputTokens}};
}
export function reserve35(request: ReturnType<typeof request35>) {
  const bytes=Buffer.byteLength(JSON.stringify(request.body),'utf8')+4096;
  if(bytes>95000)throw Error('Request exceeds conservative context bound');
  return cost35({input:bytes,cached:0,cacheWrite:0,output:request.cfg.maxOutputTokens,reasoning:0});
}
export function jobs35(cases: Case[], phase: string) {
  return cases.flatMap((c)=>{
    const same=cases.filter(x=>x.task===c.task),i=same.findIndex(x=>x.id===c.id);
    if(phase==='pilot'&&i>=3||['repeat','sweep'].includes(phase)&&i%5!==0)return [];
    const efforts=phase==='sweep'?(c.task==='taxonomy'?['minimal']:c.task==='reminders'?['low']:c.task==='shopping'?['medium']:[]):[c.task==='shopping'?'high':'medium'];
    return efforts.flatMap(effort=>(phase==='repeat'?[1,2]:[0]).map(repeat=>({c,effort,repeat})));
  });
}
const append=(row:any)=>{const fd=fs.openSync(path.join(DIR,SUBDIR,'ledger.jsonl'),'a');try{fs.writeSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
async function run(phase:string) {
  const {dataset,benchmark}=validateBenchmark();
  const lock=path.join(DIR,'run.lock');const fd=fs.openSync(lock,'wx');fs.writeSync(fd,String(process.pid));fs.closeSync(fd);
  try{
    const manifest={model:MODEL,datasetHash:hash(dataset),benchmarkHash:hash(benchmark),originalManifestHash:hash(read('run-manifest.json')),price:PRICE,capUsd:4.5,settings:'medium recipe tasks; high shopping; 8192/16384 total output tokens; Gemini baseline prompts and JSON mode retained',requests:dataset.cases.flatMap((c:Case)=>[...new Set([c.task==='shopping'?'high':'medium',...jobs35(dataset.cases,'sweep').filter(j=>j.c.id===c.id).map(j=>j.effort)])].map(effort=>({caseId:c.id,effort,hash:hash(request35(c,effort))})))};
    if(fs.existsSync(path.join(DIR,SUBDIR,'manifest.json'))&&hash(read(`${SUBDIR}/manifest.json`))!==hash(manifest))throw Error('Frozen extension settings changed');
    save(`${SUBDIR}/manifest.json`,manifest);
    const old=journal(),events=events35(),batch=jobs35(dataset.cases,phase),key=await loadGeminiKey();
    const jobId=(j:typeof batch[number])=>hash([hash(manifest),j.c.id,j.repeat,j.effort]);
    let stopped=false,completed=0;
    const committed=()=>balances([...old,...events]).gemini;
    async function worker(lane:number){for(const job of batch.filter((_,i)=>i%2===lane)){
      const id=jobId(job);if(stopped||resumeDisposition(events,id)!=='new')continue;
      const request=request35(job.c,job.effort),reserve=reserve35(request);
      let last:any,usd=0,latencyMs=0;
      for(let attempt=0;attempt<2;attempt++){
        if(!canReserve(committed(),reserve)){stopped=true;break;}
        const attemptId=`${id}-${attempt}`,reservation={type:'reserve',provider:'gemini',jobId:id,attemptId,usd:reserve,at:new Date().toISOString()};append(reservation);events.push(reservation);
        save(`${SUBDIR}/requests/${id}.json`,{jobId:id,caseId:job.c.id,phase,repeat:job.repeat,...request.cfg,body:request.body});
        last=await callProvider('gemini',job.c,key,[key],job.effort,fetch,request);
        const amount=last.usage?cost35(last.usage):[400,401,403,404,422,429].includes(last.httpStatus)?0:reserve;
        const settled={type:'settle',provider:'gemini',jobId:id,attemptId,usd:amount,measured:!!last.usage,response:last,at:new Date().toISOString()};append(settled);events.push(settled);usd+=amount;latencyMs+=last.latencyMs;
        if(![0,429,500,502,503,504,529].includes(last.httpStatus)||attempt===1)break;
        await new Promise(r=>setTimeout(r,1500));
      }
      if(!last)continue;
      let value:any,shopping:any,validationError:string|undefined;
      try{if(last.error||!last.complete)throw Error(last.error??'Incomplete output');value=validateOutput(job.c,JSON.parse(last.text));if(job.c.task==='shopping'){shopping=await verifyShopping(job.c,value);if(!shopping.conserved)throw Error('Quantity conservation failure');}}
      catch(e){validationError=e instanceof SyntaxError?'Invalid JSON':e instanceof Error?e.message.slice(0,500):'Invalid output';}
      const result={type:'result',jobId:id,caseId:job.c.id,task:job.c.task,phase,repeat:job.repeat,...request.cfg,value,shopping,valid:!validationError,validationError,latencyMs,usd,usage:last.usage,at:new Date().toISOString()};append(result);events.push(result);completed++;
      if(completed%10===0||!result.valid)console.log(JSON.stringify({phase,completed,task:job.c.task,valid:result.valid,committedGeminiUsd:committed(),error:validationError}));
      if([400,401,403,404,422].includes(last.httpStatus))stopped=true;
    }}
    const workers=await Promise.allSettled([worker(0),worker(1)]);for(const w of workers)if(w.status==='rejected')throw w.reason;
    const state={scheduled:batch.length,completed:batch.filter(j=>resumeDisposition(events,jobId(j))==='completed').length,committedGeminiUsd:committed(),stopped,completedAt:new Date().toISOString()};save(`${SUBDIR}/phase-${phase}.json`,state);console.log(JSON.stringify(state));
  }finally{fs.unlinkSync(lock);}
}
async function main(){
 const stage=process.argv[2];
 if(stage==='preflight'){const key=await loadGeminiKey();const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`,{headers:headers('gemini',key),redirect:'error',signal:AbortSignal.timeout(30000)});const body=await r.json()as any;const result={available:r.ok,status:r.status,model:body.name,inputTokenLimit:body.inputTokenLimit,outputTokenLimit:body.outputTokenLimit,price:PRICE};save(`${SUBDIR}/preflight.json`,result);console.log(JSON.stringify(result));if(!r.ok)process.exitCode=1;return;}
 if(stage==='pilot')return run('pilot');
 if(stage==='run'){for(const phase of ['main','repeat','sweep']){await run(phase);const s=read(`${SUBDIR}/phase-${phase}.json`);if(s.completed<s.scheduled)break;}return;}
 if(stage==='report'){const {report35}=await import('./lib/aiEvaluationGemini35Report');return report35();}
 throw Error('Use preflight, pilot, run, or report');
}
if(process.argv[1]?.replace(/\\/g,'/').endsWith('/evaluate-gemini35.ts'))main().catch(e=>{console.error(e instanceof Error?e.message:'Evaluation failed');process.exitCode=1});
