import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
const {mountAgentSessionRoutes}=await import('./agent/agent_session_routes.js').catch(()=>({}));

test('session bootstrap uses authenticated identity without invoking the Agent',async()=>{
  assert.equal(typeof mountAgentSessionRoutes,'function');
  const app=express();app.use(express.json());const calls=[];
  mountAgentSessionRoutes({app,authenticate:(req,res,next)=>{req.auth={userId:'7'};next();},
    enabled:()=>true,create:async args=>{calls.push(args);return {ok:true,data:{session:{id:'22'}}};}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try {
    const url=`http://127.0.0.1:${server.address().port}/api/agent/session`;
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({language:'ur'})});
    assert.equal(response.status,200);assert.equal((await response.json()).data.sessionId,'22');
    assert.deepEqual(calls,[{userId:'7',language:'ur'}]);
    const forged=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:'8'})});
    assert.equal(forged.status,422);assert.equal(calls.length,1);
  } finally {server.close();}
});
