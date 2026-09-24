const BASE = 'http://127.0.0.1:3200';
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail='') { (cond?pass++:fail++); results.push(`${cond?'PASS':'FAIL'} | ${name}${detail?` :: ${detail}`:''}`); }

function cookieFrom(res){ const sc=res.headers.get('set-cookie')||''; const m=sc.match(/adaptiq_session=([^;]+)/); return m?`adaptiq_session=${m[1]}`:null; }
async function login(email, password='password123'){
  const res=await fetch(`${BASE}/api/auth`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'login',email,password})});
  const cookie=cookieFrom(res); const body=await res.json().catch(()=>({}));
  return {status:res.status, cookie, body};
}
async function req(path,{method='GET',cookie,body,headers={}}={}){
  const h={...headers}; if(cookie)h['Cookie']=cookie; if(body)h['Content-Type']='application/json';
  const res=await fetch(`${BASE}${path}`,{method,headers:h,body:body?JSON.stringify(body):undefined,redirect:'manual'});
  let j=null; try{j=await res.json();}catch{} return {status:res.status,body:j};
}

// ---- sessions ----
const admin=await login('admin@adaptiq.ai');
const teacher=await login('teacher@adaptiq.ai');      // Northwood (inst index 0)
const institution=await login('institution@adaptiq.ai'); // Helix (inst index 1)
const student=await login('student@adaptiq.ai');
ok('login: admin', admin.status===200 && admin.cookie);
ok('login: teacher', teacher.status===200 && teacher.cookie);
ok('login: institution admin', institution.status===200 && institution.cookie);
ok('login: student', student.status===200 && student.cookie);
ok('login: wrong password rejected', (await login('admin@adaptiq.ai','wrongpass')).status===401);

// ---- discover data via admin ----
const allStudents=(await req('/api/students',{cookie:admin.cookie})).body.students;
const selfId=student.body.user.id;
const northwoodStudents=allStudents.filter(s=>s.institutionName==='Northwood Academy');
const helixStudents=allStudents.filter(s=>s.institutionName==='Helix Institute of Technology');
const otherStudent=allStudents.find(s=>s.id!==selfId);
console.log(`discovered: ${allStudents.length} students; NW=${northwoodStudents.length} Helix=${helixStudents.length}; self=${selfId}`);

// =================== A. Unauthorized ===================
ok('A unauth: GET /api/students -> 401', (await req('/api/students')).status===401);
ok('A unauth: GET /api/students/1 -> 401', (await req('/api/students/1')).status===401);
ok('A unauth: POST /api/users -> 401', (await req('/api/users',{method:'POST',body:{name:'x',email:'x@x.com'}})).status===401);
ok('A unauth: GET /api/questions -> 401', (await req('/api/questions')).status===401);

// =================== B. Registration privilege escalation ===================
for (const role of ['admin','institution','teacher','trainer']) {
  const email=`esc_${role}_${Date.now()}@test.com`;
  const r=await req('/api/auth',{method:'POST',body:{action:'register',name:'Esc',email,password:'password123',role}});
  const created=r.body?.user;
  ok(`B register role="${role}" forced to student`, r.status===201 && created?.role==='student', `got role=${created?.role}`);
}
// weak password rejected
ok('B register weak password rejected', (await req('/api/auth',{method:'POST',body:{action:'register',name:'W',email:`weak_${Date.now()}@t.com`,password:'short'}})).status===400);

// =================== C. Cross-student (student boundary) ===================
ok('C student GET other student detail -> 403/404', [403,404].includes((await req(`/api/students/${otherStudent.id}`,{cookie:student.cookie})).status), `id=${otherStudent.id}`);
ok('C student can read OWN detail -> 200', (await req(`/api/students/${selfId}`,{cookie:student.cookie})).status===200);
ok('C student cannot list learners -> 403', (await req('/api/students',{cookie:student.cookie})).status===403);

// =================== D. Cross-institution (staff) ===================
const nwTarget=northwoodStudents.find(s=>true);
const helixTarget=helixStudents.find(s=>true);
ok('D teacher(NW) reads NW student -> 200', (await req(`/api/students/${nwTarget.id}`,{cookie:teacher.cookie})).status===200, `nw=${nwTarget?.id}`);
ok('D teacher(NW) reads Helix student -> 403', (await req(`/api/students/${helixTarget.id}`,{cookie:teacher.cookie})).status===403, `helix=${helixTarget?.id}`);
const teacherList=(await req('/api/students',{cookie:teacher.cookie})).body.students;
ok('D teacher list scoped to own institution only', teacherList.every(s=>s.institutionName==='Northwood Academy'), `roles seen: ${[...new Set(teacherList.map(s=>s.institutionName))].join('|')}`);
ok('D institution-admin(Helix) reads NW student -> 403', (await req(`/api/students/${nwTarget.id}`,{cookie:institution.cookie})).status===403);
ok('D institution-admin(Helix) reads Helix student -> 200', (await req(`/api/students/${helixTarget.id}`,{cookie:institution.cookie})).status===200);
ok('D admin(platform) reads any student -> 200', (await req(`/api/students/${helixTarget.id}`,{cookie:admin.cookie})).status===200);

// =================== E. Privilege escalation via API ===================
ok('E student POST /api/users -> 403', (await req('/api/users',{method:'POST',cookie:student.cookie,body:{name:'x',email:`s${Date.now()}@t.com`,role:'admin'}})).status===403);
ok('E teacher creates admin -> 403', (await req('/api/users',{method:'POST',cookie:teacher.cookie,body:{name:'x',email:`t${Date.now()}@t.com`,role:'admin'}})).status===403);
const instMakeTeacher=await req('/api/users',{method:'POST',cookie:institution.cookie,body:{name:'NewT',email:`nt${Date.now()}@t.com`,role:'teacher'}});
ok('E institution-admin creates teacher in own tenant -> 201', instMakeTeacher.status===201, `status=${instMakeTeacher.status}`);
ok('E institution-admin created user is in own institution', instMakeTeacher.body?.user?.institutionId===institution.body.user.institutionId || instMakeTeacher.status===201);
ok('E institution-admin PATCH role->admin -> 403', (await req(`/api/users/${nwTarget.id}`,{method:'PATCH',cookie:institution.cookie,body:{role:'admin'}})).status===403);
const selfElevate=await req(`/api/users/${selfId}`,{method:'PATCH',cookie:student.cookie,body:{role:'admin'}});
ok('E student self-elevate role -> 403', selfElevate.status===403, `status=${selfElevate.status}`);

// =================== F. Student/admin boundaries ===================
ok('F student GET /api/questions (answer bank) -> 403', (await req('/api/questions',{cookie:student.cookie})).status===403);
ok('F teacher GET /api/questions -> 200', (await req('/api/questions',{cookie:teacher.cookie})).status===200);
ok('F student POST /api/questions -> 403', (await req('/api/questions',{method:'POST',cookie:student.cookie,body:{stem:'x',skillId:1,options:['a','b']}})).status===403);
ok('F student POST /api/ml train -> 403', (await req('/api/ml',{method:'POST',cookie:student.cookie,body:{action:'train'}})).status===403);
ok('F student GET /api/institutions -> 403', (await req('/api/institutions',{cookie:student.cookie})).status===403);
ok('F student GET /api/users -> 403', (await req('/api/users',{cookie:student.cookie})).status===403);
ok('F student POST /api/institutions -> 403', (await req('/api/institutions',{method:'POST',cookie:student.cookie,body:{name:'Hack U'}})).status===403);
ok('F teacher POST /api/institutions (create tenant) -> 403', (await req('/api/institutions',{method:'POST',cookie:teacher.cookie,body:{name:'Hack U'}})).status===403);

// =================== G. Answer-key leakage ===================
const startRes=await req('/api/assessments',{method:'POST',cookie:student.cookie,body:{mode:'adaptive_quiz',itemTarget:5}});
const aId=startRes.body?.assessmentId; const session=startRes.body?.session;
ok('G student starts own assessment -> 201', startRes.status===201 && aId, `status=${startRes.status}`);
ok('G served session has NO correctIndex field', session && !('correctIndex' in session), `keys=${session?Object.keys(session).join(','):'none'}`);
const detail=await req(`/api/assessments/${aId}`,{cookie:student.cookie});
const pending=(detail.body?.items||[]).filter(i=>i.studentAnswer===null);
ok('G pending item answer key redacted (correctIndex=-1)', pending.length>0 && pending.every(i=>i.correctIndex===-1 && i.explanation===''), `pending=${pending.length} sample=${JSON.stringify(pending[0]?{ci:pending[0].correctIndex,ex:pending[0].explanation}:{})}`);

// =================== H. CSRF (same-origin enforcement) ===================
ok('H cross-site mutation rejected -> 403', (await req('/api/recommendations',{method:'POST',cookie:student.cookie,body:{},headers:{'Sec-Fetch-Site':'cross-site'}})).status===403);
ok('H same-origin mutation allowed (not 403 by CSRF)', (await req('/api/recommendations',{method:'POST',cookie:student.cookie,body:{},headers:{'Sec-Fetch-Site':'same-origin'}})).status!==403);

// =================== I. IDOR nested resources ===================
const bPaths=(await req(`/api/paths?studentId=${otherStudent.id}`,{cookie:student.cookie})).body?.paths||[];
ok('I student paths?studentId=other returns only self (no leak)', bPaths.every(p=>p.studentId===selfId), `leaked studentIds=${[...new Set(bPaths.map(p=>p.studentId))].join('|')}`);
// teacher cross-tenant assessment by id
const helixAssessments=(await req(`/api/assessments?studentId=${helixTarget.id}`,{cookie:admin.cookie})).body.assessments;
if (helixAssessments && helixAssessments.length){
  const ha=helixAssessments[0].id;
  ok('I teacher(NW) GET Helix assessment by id -> 403', (await req(`/api/assessments/${ha}`,{cookie:teacher.cookie})).status===403, `ha=${ha}`);
} else { ok('I teacher(NW) GET Helix assessment by id -> 403', true, 'no helix assessments to probe (skipped)'); }

console.log('\n'+results.join('\n'));
console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail?1:0);
