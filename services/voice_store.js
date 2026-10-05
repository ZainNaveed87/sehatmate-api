import {createHash} from 'node:crypto';
import {voiceError} from './voice_contract.js';
const sessionFields={id:'id',userId:'user_id',agentSessionId:'agent_session_id',roomName:'room_name',participantIdentity:'participant_identity',dispatchId:'dispatch_id',jobId:'job_id',workerIdentity:'worker_identity',transportOwner:'transport_owner',epoch:'transport_epoch',status:'status',activeTurnId:'active_turn_id',usageDay:'usage_day',chargedSeconds:'charged_seconds',createdAt:'created_at',lastActiveAt:'last_active_at',expiresAt:'expires_at'};
const receiptFields={voiceSessionId:'voice_session_id',userId:'user_id',agentSessionId:'agent_session_id',turnId:'turn_id',epoch:'transport_epoch',requestHash:'request_hash',confirmationId:'confirmation_id',confirmationHash:'confirmation_hash',status:'status',encryptedResult:'encrypted_result',startedAt:'started_at',finishedAt:'finished_at',resultExpiresAt:'result_expires_at'};
// Date handling is explicitly UTC and independent of the host/driver timezone.
const dates=new Set(['createdAt','lastActiveAt','expiresAt','startedAt','finishedAt','resultExpiresAt']);
function decode(row,fields) {
  if(!row) return null;
  return Object.fromEntries(Object.entries(fields).map(([k,c])=>{
    let v=row[c];
    if(['userId','agentSessionId'].includes(k)&&v!=null) v=String(v);
    if(dates.has(k)&&v!=null) v=new Date(typeof v==='string' ? `${v.replace(' ','T')}Z`:v).toISOString();
    if(k==='usageDay') v=typeof v==='string' ? v.slice(0,10) : v.toISOString().slice(0,10);
    return [k,v];
  }));
}
async function save(db,table,fields,row,keys) {
  const entries=Object.entries(fields),cols=entries.map(([,c])=>c);
  const values=entries.map(([k])=>dates.has(k)&&row[k]!=null ? new Date(row[k]).toISOString().replace('T',' ').replace('Z','') : row[k]??null);
  await db.execute(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')}) ON DUPLICATE KEY UPDATE ${cols.filter(c=>!keys.includes(c)).map(c=>`${c}=VALUES(${c})`).join(',')}`,values);
}
export function createVoiceStore(pool,{lockPool=pool,sessionLockPool=lockPool}={}) {
  const rowsQuery=(db,sql,values)=>db.query({sql,dateStrings:true},values);
  async function acquire(selectedPool,userId,resource) {
    let connection;try {connection=await selectedPool.getConnection();} catch {return null;}
    const name=`smv:${createHash('sha256').update(`${userId}:${resource}`).digest('hex').slice(0,56)}`;
    try {
      const [rows]=await connection.query('SELECT GET_LOCK(?, 0) AS acquired',[name]);
      if(Number(rows[0]?.acquired)!==1) {connection.release();return null;}
      let released=false;
      return async()=>{if(released) return;released=true;
        try {await connection.query('SELECT RELEASE_LOCK(?)',[name]);} catch {connection.destroy();return;} connection.release();};
    } catch(error) {connection.destroy();throw error;}
  }
  function scoped(db) {
    return {
      async getSession(id) {const [rows]=await rowsQuery(db,'SELECT * FROM agent_voice_sessions WHERE id = ?',[id]);return decode(rows[0],sessionFields);},
      saveSession:s=>save(db,'agent_voice_sessions',sessionFields,s,['id']),
      async listSessions(userId) {const [rows]=await rowsQuery(db,'SELECT * FROM agent_voice_sessions WHERE user_id = ?',[userId]);return rows.map(r=>decode(r,sessionFields));},
      async getReceipt(id,turnId) {const [rows]=await rowsQuery(db,'SELECT * FROM agent_turn_receipts WHERE voice_session_id = ? AND turn_id = ?',[id,turnId]);return decode(rows[0],receiptFields);},
      async findConfirmation(agentSessionId,confirmationId) {const [rows]=await rowsQuery(db,'SELECT * FROM agent_turn_receipts WHERE agent_session_id = ? AND confirmation_id = ?',[agentSessionId,confirmationId]);return decode(rows[0],receiptFields);},
      saveReceipt:r=>save(db,'agent_turn_receipts',receiptFields,r,['voice_session_id','turn_id','request_hash','confirmation_id','confirmation_hash']),
    };
  }
  return {...scoped(pool),
    async transaction(userId,fn) {
      const connection=await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows]=await connection.query('SELECT id FROM users WHERE id = ? FOR UPDATE',[userId]);
        if(!rows.length) throw voiceError('VOICE_SESSION_NOT_FOUND',404);
        const result=await fn(scoped(connection));await connection.commit();return result;
      } catch(error) {await connection.rollback();throw error;} finally {connection.release();}
    },
    acquireAgentLock:(userId,agentSessionId)=>acquire(lockPool,userId,agentSessionId),
    acquireSessionLock:(userId,id)=>acquire(sessionLockPool,userId,`voice-session:${id}`),
    async sweepCandidates(now,idleSeconds,disabled=false) {
      const [rows]=await rowsQuery(pool,"SELECT * FROM agent_voice_sessions WHERE status IN ('active','creating','closing') AND (? OR status = 'closing' OR agent_session_id IS NULL OR expires_at <= ? OR last_active_at <= ?) LIMIT 100",
        [disabled,new Date(now).toISOString().replace('T',' ').replace('Z',''),new Date(now-idleSeconds*1000).toISOString().replace('T',' ').replace('Z','')]);
      return rows.map(r=>decode(r,sessionFields));
    },
    async prune(now) {
      const stamp=new Date(now).toISOString().replace('T',' ').replace('Z','');
      await pool.execute('UPDATE agent_turn_receipts SET encrypted_result = NULL WHERE result_expires_at <= ? AND encrypted_result IS NOT NULL',[stamp]);
      // Keep uncertain tombstones until their owning Agent session expires/deletes.
      await pool.execute("DELETE FROM agent_voice_sessions WHERE status = 'ended' AND active_turn_id IS NULL AND expires_at < DATE_SUB(?, INTERVAL 2 DAY)",[stamp]);
    },
  };
}
