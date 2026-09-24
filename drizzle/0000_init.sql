CREATE TABLE "activity_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer,
	"type" text DEFAULT 'practice' NOT NULL,
	"skill_id" integer,
	"summary" text NOT NULL,
	"value" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assessment_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"assessment_id" integer NOT NULL,
	"question_id" integer NOT NULL,
	"skill_id" integer NOT NULL,
	"sequence" integer DEFAULT 1 NOT NULL,
	"student_answer" integer,
	"is_correct" boolean,
	"response_time_ms" integer DEFAULT 0 NOT NULL,
	"predicted_correct_prob" real DEFAULT 0.5 NOT NULL,
	"assigned_difficulty" real DEFAULT 0.5 NOT NULL,
	"mastery_before" real DEFAULT 0.5 NOT NULL,
	"mastery_after" real DEFAULT 0.5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assessments" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"title" text NOT NULL,
	"mode" text DEFAULT 'adaptive_quiz' NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"target_skill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"item_target" integer DEFAULT 8 NOT NULL,
	"ability" real DEFAULT 0.5 NOT NULL,
	"score" real,
	"predicted_score" real,
	"forecast_label" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_id" integer,
	"actor_role" text,
	"actor_email" text,
	"action" text NOT NULL,
	"resource" text,
	"resource_id" text,
	"target_student_id" integer,
	"institution_id" integer,
	"outcome" text DEFAULT 'success' NOT NULL,
	"ip" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"type" text DEFAULT 'school' NOT NULL,
	"plan" text DEFAULT 'growth' NOT NULL,
	"region" text DEFAULT 'Global' NOT NULL,
	"seats" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_statistics" (
	"id" serial PRIMARY KEY NOT NULL,
	"question_id" integer NOT NULL,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"facility" real DEFAULT 0 NOT NULL,
	"discrimination" real DEFAULT 0 NOT NULL,
	"discrimination_index" real,
	"mean_response_time_ms" integer,
	"quality_score" real DEFAULT 0 NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"distractor_analysis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calibration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_paths" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"title" text NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"strategy" text DEFAULT 'gap-ordered' NOT NULL,
	"target_mastery" real DEFAULT 0.85 NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"projected_completion" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mastery_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"skill_id" integer NOT NULL,
	"mastery" real DEFAULT 0.4 NOT NULL,
	"prior_mastery" real DEFAULT 0.4 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"correct" integer DEFAULT 0 NOT NULL,
	"streak" integer DEFAULT 0 NOT NULL,
	"slip" real DEFAULT 0.1 NOT NULL,
	"guess" real DEFAULT 0.2 NOT NULL,
	"learn_rate" real DEFAULT 0.22 NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_practiced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'classifier' NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"dataset_version" text,
	"feature_version" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hyperparams" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evaluated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_evaluations" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_name" text NOT NULL,
	"kind" text DEFAULT 'classifier' NOT NULL,
	"version" text NOT NULL,
	"dataset_version" text,
	"feature_version" text,
	"split" text DEFAULT 'test' NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hyperparams" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "path_milestones" (
	"id" serial PRIMARY KEY NOT NULL,
	"path_id" integer NOT NULL,
	"skill_id" integer NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"target_mastery" real DEFAULT 0.85 NOT NULL,
	"current_mastery" real DEFAULT 0 NOT NULL,
	"due_date" text,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"skill_id" integer NOT NULL,
	"subskill" text,
	"prerequisite_skill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stem" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"correct_index" integer DEFAULT 0 NOT NULL,
	"difficulty_label" text DEFAULT 'medium' NOT NULL,
	"difficulty_value" real DEFAULT 0.55 NOT NULL,
	"bloom_level" text DEFAULT 'apply' NOT NULL,
	"cognitive_complexity" text DEFAULT 'skill_concept' NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"distractor_meta" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimated_seconds" integer DEFAULT 60 NOT NULL,
	"author_id" integer,
	"source" text DEFAULT 'human' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"reviewed_by_id" integer,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"quality_score" real DEFAULT 0 NOT NULL,
	"exposure_count" integer DEFAULT 0 NOT NULL,
	"success_rate" real DEFAULT 0 NOT NULL,
	"discrimination" real DEFAULT 0 NOT NULL,
	"calibration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quality_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_analyzed_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"kind" text DEFAULT 'skill' NOT NULL,
	"skill_id" integer,
	"title" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"priority" real DEFAULT 0.5 NOT NULL,
	"confidence" real DEFAULT 0.6 NOT NULL,
	"factors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model" text DEFAULT 'hybrid-v2' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_id" integer NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"difficulty_base" real DEFAULT 0.5 NOT NULL,
	"grade_band" text DEFAULT 'Core' NOT NULL,
	"prereq_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"color" text DEFAULT '#6366f1' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_interactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"skill_id" integer,
	"assessment_id" integer,
	"item_id" integer,
	"intent" text NOT NULL,
	"requested_intent" text,
	"difficulty" text DEFAULT 'core' NOT NULL,
	"mastery_at_time" real,
	"withheld_answer" boolean DEFAULT false NOT NULL,
	"provider" text DEFAULT 'deterministic' NOT NULL,
	"model" text,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"response_chars" integer DEFAULT 0 NOT NULL,
	"safety_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"helpful" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'student' NOT NULL,
	"institution_id" integer,
	"grade_level" text,
	"cohort" text,
	"avatar_color" text DEFAULT '#4f46e5' NOT NULL,
	"goal" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_statistics" ADD CONSTRAINT "item_statistics_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_paths" ADD CONSTRAINT "learning_paths_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_states" ADD CONSTRAINT "mastery_states_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_states" ADD CONSTRAINT "mastery_states_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_milestones" ADD CONSTRAINT "path_milestones_path_id_learning_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."learning_paths"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_milestones" ADD CONSTRAINT "path_milestones_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_interactions" ADD CONSTRAINT "tutor_interactions_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_interactions" ADD CONSTRAINT "tutor_interactions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_interactions" ADD CONSTRAINT "tutor_interactions_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_interactions" ADD CONSTRAINT "tutor_interactions_item_id_assessment_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."assessment_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_student_created_idx" ON "activity_events" USING btree ("student_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "activity_events" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "assessment_items_assessment_idx" ON "assessment_items" USING btree ("assessment_id");--> statement-breakpoint
CREATE INDEX "assessment_items_question_idx" ON "assessment_items" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "assessments_student_idx" ON "assessments" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "assessments_student_status_idx" ON "assessments" USING btree ("student_id","status");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "institutions_slug_idx" ON "institutions" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "item_stats_question_idx" ON "item_statistics" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "item_stats_computed_idx" ON "item_statistics" USING btree ("computed_at");--> statement-breakpoint
CREATE INDEX "learning_paths_student_idx" ON "learning_paths" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mastery_student_skill_idx" ON "mastery_states" USING btree ("student_id","skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ml_models_name_idx" ON "ml_models" USING btree ("name");--> statement-breakpoint
CREATE INDEX "model_eval_name_idx" ON "model_evaluations" USING btree ("model_name");--> statement-breakpoint
CREATE INDEX "model_eval_evaluated_idx" ON "model_evaluations" USING btree ("evaluated_at");--> statement-breakpoint
CREATE INDEX "path_milestones_path_idx" ON "path_milestones" USING btree ("path_id");--> statement-breakpoint
CREATE INDEX "questions_skill_idx" ON "questions" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "questions_status_idx" ON "questions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "recommendations_student_status_idx" ON "recommendations" USING btree ("student_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_idx" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_code_idx" ON "skills" USING btree ("code");--> statement-breakpoint
CREATE INDEX "tutor_interactions_student_created_idx" ON "tutor_interactions" USING btree ("student_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tutor_interactions_skill_idx" ON "tutor_interactions" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "tutor_interactions_assessment_idx" ON "tutor_interactions" USING btree ("assessment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_institution_idx" ON "users" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");