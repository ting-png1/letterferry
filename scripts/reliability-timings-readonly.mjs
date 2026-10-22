import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectReliabilityTimings} from '../src/reliability-timings.mjs';

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const root=process.argv[2];
  if(!root)throw Error('RELIABILITY_ROOT_REQUIRED');
  process.stdout.write(JSON.stringify(inspectReliabilityTimings(root),null,2)+'\n');
 }catch(error){
  const code=/^[A-Z0-9_]+$/.test(error?.message||'')?error.message:'RELIABILITY_INSPECTION_FAILED';
  process.stderr.write(code+'\n');
  process.exitCode=1;
 }
}
