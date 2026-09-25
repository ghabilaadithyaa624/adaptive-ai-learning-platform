CREATE TABLE "misconception_episodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"skill_id" integer NOT NULL,
	"hypothesis_id" text NOT NULL,
	"subskill" text,
	"misconception" text NOT NULL,
	"confidence_at_detection" text NOT NULL,
	"error_pattern" text NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"detection_evidence_count" integer DEFAULT 0 NOT NULL,
	"first_remediation_at" timestamp with time zone,
	"status" text DEFAULT 'insufficient_evidence' NOT NULL,
	"status_reason" text DEFAULT '' NOT NULL,
	"resolved_at" timestamp with time zone,
	"post_remediation_opportunities" integer DEFAULT 0 NOT NULL,
	"clean_opportunities" integer DEFAULT 0 NOT NULL,
	"recurrences" integer DEFAULT 0 NOT NULL,
	"mastery_at_detection" real,
	"mastery_latest" real,
	"retention" real,
	"ground_truth_label" text DEFAULT 'unknown' NOT NULL,
	"ground_truth_by" integer,
	"ground_truth_at" timestamp with time zone,
	"ground_truth_note" text,
	"opportunities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evaluation_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "misconception_remediations" (
	"id" serial PRIMARY KEY NOT NULL,
	"episode_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	"source" text NOT NULL,
	"tutor_interaction_id" integer,
	"recommendation_id" integer,
	"targeted" boolean DEFAULT false NOT NULL,
	"helpful" boolean,
	"counts_as_evidence" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "misconception_remediation_not_evidence" CHECK ("misconception_remediations"."counts_as_evidence" = false)
);
--> statement-breakpoint
ALTER TABLE "misconception_episodes" ADD CONSTRAINT "misconception_episodes_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "misconception_episodes" ADD CONSTRAINT "misconception_episodes_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "misconception_episodes" ADD CONSTRAINT "misconception_episodes_ground_truth_by_users_id_fk" FOREIGN KEY ("ground_truth_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "misconception_remediations" ADD CONSTRAINT "misconception_remediations_episode_id_misconception_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."misconception_episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "misconception_remediations" ADD CONSTRAINT "misconception_remediations_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "misconception_remediations" ADD CONSTRAINT "misconception_remediations_tutor_interaction_id_tutor_interactions_id_fk" FOREIGN KEY ("tutor_interaction_id") REFERENCES "public"."tutor_interactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "misconception_remediations" ADD CONSTRAINT "misconception_remediations_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "misconception_episode_student_hypothesis_idx" ON "misconception_episodes" USING btree ("student_id","hypothesis_id");--> statement-breakpoint
CREATE INDEX "misconception_episode_status_idx" ON "misconception_episodes" USING btree ("status","detected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "misconception_episode_skill_idx" ON "misconception_episodes" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "misconception_remediation_episode_idx" ON "misconception_remediations" USING btree ("episode_id","occurred_at");