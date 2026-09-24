CREATE TABLE "experiment_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"experiment_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	"variant_key" text NOT NULL,
	"config_fingerprint" text NOT NULL,
	"bucket" real NOT NULL,
	"eligibility_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_exposures" (
	"id" serial PRIMARY KEY NOT NULL,
	"experiment_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	"variant_key" text NOT NULL,
	"config_fingerprint" text NOT NULL,
	"surface" text DEFAULT 'assessment.next-item' NOT NULL,
	"entity_id" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"hypothesis" text DEFAULT '' NOT NULL,
	"institution_id" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"eligibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"primary_metric" text NOT NULL,
	"secondary_metrics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assignment_strategy" text DEFAULT 'sticky' NOT NULL,
	"salt" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone,
	"exclusion_group" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_exposures" ADD CONSTRAINT "experiment_exposures_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_exposures" ADD CONSTRAINT "experiment_exposures_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_assignment_unique_idx" ON "experiment_assignments" USING btree ("experiment_id","student_id");--> statement-breakpoint
CREATE INDEX "experiment_assignment_variant_idx" ON "experiment_assignments" USING btree ("experiment_id","variant_key");--> statement-breakpoint
CREATE INDEX "experiment_assignment_student_idx" ON "experiment_assignments" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "experiment_exposure_lookup_idx" ON "experiment_exposures" USING btree ("experiment_id","student_id","occurred_at");--> statement-breakpoint
CREATE INDEX "experiment_exposure_variant_idx" ON "experiment_exposures" USING btree ("experiment_id","variant_key");--> statement-breakpoint
CREATE INDEX "experiment_exposure_entity_idx" ON "experiment_exposures" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "experiments_tenant_key_idx" ON "experiments" USING btree ("institution_id","key") WHERE "experiments"."institution_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "experiments_global_key_idx" ON "experiments" USING btree ("key") WHERE "experiments"."institution_id" is null;--> statement-breakpoint
CREATE INDEX "experiments_status_idx" ON "experiments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "experiments_institution_idx" ON "experiments" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "experiments_window_idx" ON "experiments" USING btree ("start_at","end_at");