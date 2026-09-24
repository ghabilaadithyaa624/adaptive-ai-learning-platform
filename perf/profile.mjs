/**
 * Performance profiling harness for the Adaptive AI Learning Platform.
 *
 * Boots an ephemeral PostgreSQL, pushes the Drizzle schema, seeds a realistic
 * mid-size tenant dataset, then measures the representative query workloads the
 * app actually issues — capturing EXPLAIN plans and wall-clock timings.
 *
 * It measures BEFORE and AFTER on the SAME database / SAME data, differing only
 * by the candidate optimization, so every number is a like-for-like comparison:
 *   - candidate indexes (created mid-run, then re-measured)
 *   - getCohortSnapshot: full-table-load + JS  vs  single SQL aggregate
 *   - loadClassifier: per-call round trip  vs  cached value
 *
 * Usage:  node perf/profile.mjs
 * Requires embedded-postgres installed transiently (npm i --no-save).
 */
import EmbeddedPostgres from "embedded-postgres";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

const PORT = 5470;
const SCALE = {
  institutions: 3,
  students: 600,
  staffPerInstitution: 5,
  subjects: 6,
  skillsPerSubject: 10, // 60 skills
  questionsPerSkill: 15, // 900 questions
  masteryPerStudent: 8, // ~4800 mastery states
  assessmentsPerStudent: 3, // ~1800 assessments
  itemsPerAssessment: 8, // ~14400 assessment items
  recsPerStudent: 6, // ~3600 recommendations
  activityPerStudent: 50, // ~30000 activity events
  pathsPerStudent: 1,
  milestonesPerPath: 4,
};

const fmt = (ms) => `${ms.toFixed(2)}ms`;

async function time(fn, iterations = 20) {
  // warm up
  await fn();
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    mean: sum / samples.length,
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.floor(samples.length * 0.95)],
    min: samples[0],
    max: samples[samples.length - 1],
  };
}

async function planSummary(client, sql, params = []) {
  const res = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const plan = res.rows[0]["QUERY PLAN"][0];
  const nodes = [];
  const walk = (n) => {
    nodes.push(n["Node Type"] + (n["Relation Name"] ? `(${n["Relation Name"]})` : ""));
    (n.Plans ?? []).forEach(walk);
  };
  walk(plan.Plan);
  return {
    execMs: plan["Execution Time"],
    planMs: plan["Planning Time"],
    scans: nodes.filter((n) => n.startsWith("Seq Scan") || n.startsWith("Index")),
    sharedRead: plan.Plan["Shared Read Blocks"],
  };
}

async function seed(client) {
  console.log("[perf] seeding scale dataset…");
  const S = SCALE;
  // Institutions
  await client.query(`insert into institutions (name, slug) select 'Inst '||g, 'inst-'||g from generate_series(1,${S.institutions}) g`);
  // Users: students + staff
  await client.query(`
    insert into users (name, email, password_hash, role, institution_id)
    select 'Student '||g, 'student'||g||'@ex.test', 'x', 'student', ((g % ${S.institutions})+1)
    from generate_series(1,${S.students}) g`);
  await client.query(`
    insert into users (name, email, password_hash, role, institution_id)
    select 'Staff '||g, 'staff'||g||'@ex.test', 'x', 'teacher', ((g % ${S.institutions})+1)
    from generate_series(1,${S.institutions * S.staffPerInstitution}) g`);
  // Subjects & skills
  await client.query(`insert into subjects (name, code, color) select 'Subject '||g, 'SUB'||g, '#6366f1' from generate_series(1,${S.subjects}) g`);
  await client.query(`
    insert into skills (subject_id, name, code, difficulty_base)
    select ((g % ${S.subjects})+1), 'Skill '||g, 'SK'||g, 0.4 + (g % 5)*0.1
    from generate_series(1,${S.subjects * S.skillsPerSubject}) g`);
  // Questions
  await client.query(`
    insert into questions (skill_id, stem, options, correct_index, difficulty_label, bloom_level, status, is_active)
    select ((g % ${S.subjects * S.skillsPerSubject})+1), 'Q'||g||' stem', '["a","b","c","d"]'::jsonb, (g%4),
           (array['easy','medium','hard','expert'])[(g%4)+1], 'apply', 'published', true
    from generate_series(1,${S.subjects * S.skillsPerSubject * S.questionsPerSkill}) g`);
  // Mastery states (student has masteryPerStudent distinct skills)
  await client.query(`
    insert into mastery_states (student_id, skill_id, mastery, attempts, correct, last_practiced_at, history)
    select s, ((s + k) % ${S.subjects * S.skillsPerSubject})+1, 0.3+((s+k)%6)*0.1, 10, 6,
           now() - ((s+k)%40) * interval '1 day',
           '[{"t":"2026-01-01T00:00:00Z","m":0.4},{"t":"2026-02-01T00:00:00Z","m":0.6}]'::jsonb
    from generate_series(1,${S.students}) s cross join generate_series(0,${S.masteryPerStudent - 1}) k`);
  // Assessments
  await client.query(`
    insert into assessments (student_id, title, mode, status, score, started_at, completed_at)
    select s, 'Assessment '||s||'-'||a, 'adaptive_quiz',
           case when a=0 then 'in_progress' else 'completed' end,
           case when a=0 then null else 0.4+((s+a)%6)*0.1 end,
           now() - (a * interval '3 day'),
           case when a=0 then null else now() - (a * interval '3 day') + interval '20 min' end
    from generate_series(1,${S.students}) s cross join generate_series(0,${S.assessmentsPerStudent - 1}) a`);
  // Assessment items
  await client.query(`
    insert into assessment_items (assessment_id, question_id, skill_id, sequence, student_answer, is_correct, response_time_ms, created_at)
    select ai.id, ((ai.id + seq) % ${S.subjects * S.skillsPerSubject * S.questionsPerSkill})+1,
           ((ai.id + seq) % ${S.subjects * S.skillsPerSubject})+1, seq,
           (seq%4), (seq%3<>0), 5000+(seq*137%20000), ai.started_at + seq*interval '1 min'
    from assessments ai cross join generate_series(1,${S.itemsPerAssessment}) seq`);
  // Recommendations
  await client.query(`
    insert into recommendations (student_id, kind, skill_id, title, priority, status)
    select s, 'skill', ((s+r)%${S.subjects * S.skillsPerSubject})+1, 'Rec '||s||'-'||r, random(),
           (array['new','new','accepted','dismissed'])[(r%4)+1]
    from generate_series(1,${S.students}) s cross join generate_series(1,${S.recsPerStudent}) r`);
  // Activity events
  await client.query(`
    insert into activity_events (student_id, type, skill_id, summary, value, created_at)
    select s, 'practice', ((s+e)%${S.subjects * S.skillsPerSubject})+1, 'Event '||s||'-'||e, random(),
           now() - (e * interval '2 hour')
    from generate_series(1,${S.students}) s cross join generate_series(1,${S.activityPerStudent}) e`);
  // Learning paths + milestones
  await client.query(`
    insert into learning_paths (student_id, title, status)
    select s, 'Path '||s, 'active' from generate_series(1,${S.students}) s`);
  await client.query(`
    insert into path_milestones (path_id, skill_id, position, status)
    select p.id, ((p.id+m)%${S.subjects * S.skillsPerSubject})+1, m, 'available'
    from learning_paths p cross join generate_series(1,${S.milestonesPerPath}) m`);
  // ML model registry row (classifier)
  await client.query(`
    insert into ml_models (name, kind, version, params, metrics, samples)
    values ('difficulty-classifier','classifier','1.0.0',
      '{"featureNames":["a"],"weights":[0.1,0.2],"means":[0],"stds":[1]}'::jsonb,
      '{"accuracy":0.8}'::jsonb, 1000)`);

  await client.query("ANALYZE");
  const counts = await client.query(`
    select
      (select count(*) from assessments) assessments,
      (select count(*) from assessment_items) items,
      (select count(*) from mastery_states) mastery,
      (select count(*) from activity_events) activity,
      (select count(*) from recommendations) recs,
      (select count(*) from learning_paths) paths`);
  console.log("[perf] row counts:", counts.rows[0]);
}

// ---- The representative query workloads (mirroring src/lib/queries.ts) ----
function workloads(client) {
  const sid = 123; // a mid dataset student id
  return {
    "listAssessments(student)": {
      sql: `select a.*, u.name from assessments a join users u on u.id=a.student_id
            where a.student_id=$1 order by a.started_at desc limit 12`,
      params: [sid],
    },
    "getStudentPerformance(completed)": {
      sql: `select * from assessments where student_id=$1 and status='completed' order by completed_at`,
      params: [sid],
    },
    "getActivity(student)": {
      sql: `select e.*, u.name, s.name from activity_events e
            left join users u on u.id=e.student_id left join skills s on s.id=e.skill_id
            where e.student_id=$1 order by e.created_at desc limit 12`,
      params: [sid],
    },
    "getPaths(student)": {
      sql: `select p.*, u.name from learning_paths p join users u on u.id=p.student_id
            where p.student_id=$1 order by p.created_at desc`,
      params: [sid],
    },
    "getRecommendations(student,status)": {
      sql: `select r.* from recommendations r join users u on u.id=r.student_id
            where r.student_id=$1 and r.status='new' order by r.priority desc limit 120`,
      params: [sid],
    },
  };
}

// Indexes under test (names match src/db/schema.ts). We DROP them before the
// baseline and CREATE them for the "after" phase, so the comparison is valid
// regardless of whether the schema already ships them.
const CANDIDATE_INDEXES = {
  assessments_student_idx: `create index assessments_student_idx on assessments (student_id)`,
  assessments_student_status_idx: `create index assessments_student_status_idx on assessments (student_id, status)`,
  activity_student_created_idx: `create index activity_student_created_idx on activity_events (student_id, created_at desc)`,
  activity_created_idx: `create index activity_created_idx on activity_events (created_at desc)`,
  learning_paths_student_idx: `create index learning_paths_student_idx on learning_paths (student_id)`,
  recommendations_student_status_idx: `create index recommendations_student_status_idx on recommendations (student_id, status)`,
  assessment_items_question_idx: `create index assessment_items_question_idx on assessment_items (question_id)`,
};

async function measurePhase(client, label) {
  const wls = workloads(client);
  const out = {};
  for (const [name, { sql, params }] of Object.entries(wls)) {
    const plan = await planSummary(client, sql, params);
    const t = await time(() => client.query(sql, params), 30);
    out[name] = { execMs: +plan.execMs.toFixed(3), scans: plan.scans, timing: { p50: +t.p50.toFixed(3), p95: +t.p95.toFixed(3), mean: +t.mean.toFixed(3) } };
  }
  console.log(`\n========== ${label} ==========`);
  for (const [name, r] of Object.entries(out)) {
    console.log(`${name}\n  scans: ${r.scans.join(", ")}\n  EXPLAIN exec=${fmt(r.execMs)}  p50=${fmt(r.timing.p50)} p95=${fmt(r.timing.p95)}`);
  }
  return out;
}

// getCohortSnapshot: old (load full tables to JS) vs new (single SQL aggregate)
async function measureCohort(client) {
  const oldWay = async () => {
    const [m, a, r, p] = await Promise.all([
      client.query("select * from mastery_states"),
      client.query("select * from assessments"),
      client.query("select * from recommendations"),
      client.query("select * from learning_paths"),
    ]);
    // mimic the JS aggregation the app does
    const inProgress = a.rows.filter((x) => x.status === "in_progress").length;
    const completed = a.rows.filter((x) => x.status === "completed");
    void m.rows.length; void r.rows.length; void p.rows.length; void inProgress; void completed;
  };
  const newWay = async () => {
    await client.query(`
      select
        (select count(*) from mastery_states) mastery_states,
        (select count(*) filter (where status='in_progress') from assessments) active,
        (select count(*) filter (where status='completed') from assessments) completed,
        (select coalesce(avg(score),0) from assessments where status='completed') avg_score,
        (select count(*) filter (where status='new') from recommendations) open_recs,
        (select count(*) filter (where status='active') from learning_paths) active_paths`);
  };
  const oldT = await time(oldWay, 20);
  const newT = await time(newWay, 20);
  console.log(`\n========== getCohortSnapshot ==========`);
  console.log(`  OLD (load tables → JS): p50=${fmt(oldT.p50)} p95=${fmt(oldT.p95)} mean=${fmt(oldT.mean)}`);
  console.log(`  NEW (single SQL agg):   p50=${fmt(newT.p50)} p95=${fmt(newT.p95)} mean=${fmt(newT.mean)}`);
  console.log(`  speedup: ${(oldT.mean / newT.mean).toFixed(1)}x`);
  return { old: oldT, new: newT };
}

// loadClassifier: per-call DB round trip vs cached value
async function measureClassifier(client) {
  const roundTrip = async () => { await client.query("select * from ml_models where name=$1 limit 1", ["difficulty-classifier"]); };
  let cache = null;
  const cached = async () => { if (!cache) cache = (await client.query("select * from ml_models where name=$1 limit 1", ["difficulty-classifier"])).rows[0]; return cache; };
  const rtT = await time(roundTrip, 200);
  const cT = await time(cached, 200);
  console.log(`\n========== loadClassifier (per answer, called ~2x) ==========`);
  console.log(`  DB round trip: p50=${fmt(rtT.p50)} mean=${fmt(rtT.mean)}`);
  console.log(`  cached:        p50=${fmt(cT.p50)} mean=${fmt(cT.mean)}`);
  console.log(`  saved per call ≈ ${fmt(rtT.mean - cT.mean)}`);
  return { roundTrip: rtT, cached: cT };
}

// getQuestionBankAnalytics: old (materialize whole bank + throwaway item group-by) vs new (SQL aggregates)
async function measureQuestionAnalytics(client) {
  const oldWay = async () => {
    // mirrors getQuestionBank(): big join over all questions + full assessment_items group-by
    await client.query(`
      select q.*, s.name skill_name, sub.name subject_name
      from questions q join skills s on s.id=q.skill_id join subjects sub on sub.id=s.subject_id
      order by q.created_at desc`);
    await client.query(`select question_id, count(*) from assessment_items group by question_id`);
    // (the analytics route ALSO calls getQuestionBank a SECOND time on the same request)
  };
  const newWay = async () => {
    await client.query(`
      select count(*) total,
             count(*) filter (where last_analyzed_at is not null) analyzed,
             coalesce(avg(quality_score) filter (where last_analyzed_at is not null),0) mean_quality
      from questions`);
    await client.query(`select status, count(*) from questions group by status`);
    await client.query(`select source, count(*) from questions group by source`);
  };
  const oldT = await time(oldWay, 20);
  const newT = await time(newWay, 20);
  console.log(`\n========== getQuestionBankAnalytics ==========`);
  console.log(`  OLD (materialize bank + item group-by): p50=${fmt(oldT.p50)} mean=${fmt(oldT.mean)}`);
  console.log(`  NEW (SQL aggregates):                   p50=${fmt(newT.p50)} mean=${fmt(newT.mean)}`);
  console.log(`  speedup: ${(oldT.mean / newT.mean).toFixed(1)}x`);
  return { old: oldT, new: newT };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "pg-perf-"));
  const epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("perf");
  const url = `postgres://postgres:postgres@127.0.0.1:${PORT}/perf`;

  console.log("[perf] pushing schema…");
  execSync(`npx drizzle-kit push --dialect=postgresql --schema=./src/db/schema.ts --url="${url}" --force`, { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await seed(client);
    // Ensure a clean baseline: drop the candidate indexes if the schema created them.
    for (const name of Object.keys(CANDIDATE_INDEXES)) await client.query(`drop index if exists ${name}`);
    await client.query("ANALYZE");
    const before = await measurePhase(client, "BEFORE (no candidate indexes)");
    const cohort = await measureCohort(client);
    const analytics = await measureQuestionAnalytics(client);
    const classifier = await measureClassifier(client);

    console.log("\n[perf] creating candidate indexes…");
    for (const stmt of Object.values(CANDIDATE_INDEXES)) await client.query(stmt);
    await client.query("ANALYZE");

    const after = await measurePhase(client, "AFTER (candidate indexes)");

    console.log("\n\n########## SUMMARY (query timings) ##########");
    for (const name of Object.keys(before)) {
      const b = before[name].timing, a = after[name].timing;
      console.log(`${name}: p50 ${fmt(b.p50)} → ${fmt(a.p50)}  (${(b.p50 / a.p50).toFixed(1)}x)  | p95 ${fmt(b.p95)} → ${fmt(a.p95)}`);
    }
    void cohort; void analytics; void classifier;
  } finally {
    await client.end();
    await epg.stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
