CREATE TABLE "adaptive_decisions" (
  "id" serial PRIMARY KEY NOT NULL,
  "assessment_id" integer NOT NULL,
  "assessment_item_id" integer NOT NULL,
  "student_id" integer NOT NULL,
  "institution_id" integer,
  "session_key" text NOT NULL,
  "skill_id" integer,
  "subskill" text,
  "mastery_before" real NOT NULL,
  "uncertainty_before" real NOT NULL,
  "retention_before" real NOT NULL,
  "raw_probability" real NOT NULL,
  "calibrated_probability" real NOT NULL,
  "question_difficulty" real NOT NULL,
  "question_discrimination" real NOT NULL,
  "bloom_level" text NOT NULL,
  "policy_version" text NOT NULL,
  "calibration_version" text,
  "bkt_version" text NOT NULL,
  "experiment_id" integer,
  "experiment_variant" text,
  "cold_start" boolean DEFAULT false NOT NULL,
  "selection_reason" text NOT NULL,
  "candidate_set_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "decision_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "adaptive_decisions_assessment_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade,
  CONSTRAINT "adaptive_decisions_assessment_item_id_fk" FOREIGN KEY ("assessment_item_id") REFERENCES "public"."assessment_items"("id") ON DELETE cascade,
  CONSTRAINT "adaptive_decisions_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade,
  CONSTRAINT "adaptive_decisions_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE set null,
  CONSTRAINT "adaptive_decisions_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX "adaptive_decisions_item_idx" ON "adaptive_decisions" USING btree ("assessment_item_id");
--> statement-breakpoint
CREATE INDEX "adaptive_decisions_student_time_idx" ON "adaptive_decisions" USING btree ("student_id", "decided_at");
--> statement-breakpoint
CREATE INDEX "adaptive_decisions_policy_idx" ON "adaptive_decisions" USING btree ("policy_version", "decided_at");
