const BASE='http://127.0.0.1:3200';
function cookieFrom(res){const sc=res.headers.get('set-cookie')||'';const m=sc.match(/adaptiq_session=([^;]+)/);return m?`adaptiq_session=${m[1]}`:null;}
async function login(email){const r=await fetch(`${BASE}/api/auth`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'login',email,password:'password123'})});return {cookie:cookieFrom(r),body:await r.json()};}
async function req(p,{method='GET',cookie,body}={}){const h={};if(cookie)h.Cookie=cookie;if(body)h['Content-Type']='application/json';const r=await fetch(`${BASE}${p}`,{method,headers:h,body:body?JSON.stringify(body):undefined});let j=null;try{j=await r.json()}catch{}return{status:r.status,body:j};}
let pass=0,fail=0;const log=[];const ok=(n,c,d='')=>{(c?pass++:fail++);log.push(`${c?'PASS':'FAIL'} | ${n}${d?` :: ${d}`:''}`);};

const student=await login('student@adaptiq.ai');
const teacher=await login('teacher@adaptiq.ai');

// student completes an answer end-to-end
const start=await req('/api/assessments',{method:'POST',cookie:student.cookie,body:{mode:'practice',itemTarget:3}});
const aId=start.body.assessmentId, itemId=start.body.session.itemId;
const ans=await req(`/api/assessments/${aId}/answer`,{method:'POST',cookie:student.cookie,body:{action:'answer',itemId,studentAnswer:0,responseTimeMs:4000}});
ok('student can submit an answer & get graded', ans.status===200 && typeof ans.body.isCorrect==='boolean' && typeof ans.body.correctIndex==='number', `status=${ans.status}`);
ok('graded response reveals correctIndex AFTER answering', ans.body.correctIndex>=0);

// teacher creates a learner in own institution
const email=`newkid_${Date.now()}@nw.com`;
const create=await req('/api/students',{method:'POST',cookie:teacher.cookie,body:{name:'New Kid',email}});
ok('teacher can create learner (own tenant)', create.status===201 && create.body.student.role==='student', `status=${create.status}`);
ok('created learner inherits teacher institution', create.body?.student?.institutionId===teacher.body.user.institutionId);

// student generates own recommendations (self-service allowed)
const rec=await req('/api/recommendations',{method:'POST',cookie:student.cookie,body:{}});
ok('student can refresh OWN recommendations', [200,201].includes(rec.status), `status=${rec.status}`);

// student sees skill catalog (non-sensitive) but no answers
ok('student can read skill catalog', (await req('/api/skills',{cookie:student.cookie})).status===200);

// teacher can view models
ok('teacher can view ML registry', (await req('/api/ml',{cookie:teacher.cookie})).status===200);

// logout works
const lo=await req('/api/auth',{method:'POST',cookie:student.cookie,body:{action:'logout'}});
ok('logout works', lo.status===200);

console.log(log.join('\n'));
console.log(`\nSMOKE: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
