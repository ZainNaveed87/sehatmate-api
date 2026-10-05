import {agentConfig} from './agent_config.js';
import {createAgentSession} from './agent_session_store.js';

export function mountAgentSessionRoutes({app,authenticate,pool,limiter=(_req,_res,next)=>next(),
  enabled=()=>agentConfig().enabled,create=args=>createAgentSession({db:pool,...args})}) {
  app.post('/api/agent/session',authenticate,limiter,async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(!enabled()) return res.status(503).json({success:false,code:'AGENT_DISABLED'});
    const input=req.body??{};
    if(typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='language')||
      input.language!==undefined&&!['en','ur','roman_ur'].includes(input.language)) {
      return res.status(422).json({success:false,code:'INVALID_AGENT_REQUEST'});
    }
    try {
      const result=await create({userId:String(req.auth.userId),language:input.language??'en'});
      if(!result.ok) return res.status(503).json({success:false,code:'AGENT_UNAVAILABLE'});
      return res.json({success:true,data:{sessionId:result.data.session.id}});
    } catch {return res.status(503).json({success:false,code:'AGENT_UNAVAILABLE'});}
  });
}
