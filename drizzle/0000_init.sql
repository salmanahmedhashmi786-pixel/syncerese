CREATE TABLE "module_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"region" text DEFAULT 'eu-central' NOT NULL,
	"base_currency" char(3) NOT NULL,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"country_code" char(2),
	"tax_id" text,
	"fiscal_year_start_month" smallint DEFAULT 1 NOT NULL,
	"accent" text DEFAULT 'syncrese' NOT NULL,
	"logo_url" text,
	"custom_domain" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "auth_accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_email_lowercase" CHECK ("invitations"."email" = lower("invitations"."email"))
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	CONSTRAINT "memberships_org_user_uq" UNIQUE("organization_id","user_id"),
	CONSTRAINT "memberships_status" CHECK ("memberships"."status" in ('active','invited','deactivated'))
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_key_pk" PRIMARY KEY("role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_org_key_uq" UNIQUE("organization_id","key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"theme" text DEFAULT 'light' NOT NULL,
	"accent" text DEFAULT 'syncrese' NOT NULL,
	"density" text DEFAULT 'compact' NOT NULL,
	"font_scale" real DEFAULT 1 NOT NULL,
	"sidebar_collapsed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_theme" CHECK ("user_preferences"."theme" in ('light','dark')),
	CONSTRAINT "user_preferences_density" CHECK ("user_preferences"."density" in ('compact','comfortable','relaxed')),
	CONSTRAINT "user_preferences_font_scale" CHECK ("user_preferences"."font_scale" between 0.85 and 1.30)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"name" text,
	"avatar_url" text,
	"mfa_secret_encrypted" text,
	"mfa_enabled_at" timestamp with time zone,
	"mfa_recovery_codes_hashed" jsonb,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_status" CHECK ("users"."status" in ('active','deactivated'))
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "workspace_preferences" (
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"column_visibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dashboard_layout" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_preferences_user_id_organization_id_pk" PRIMARY KEY("user_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "device_activations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"license_id" uuid,
	"user_id" uuid,
	"device_fingerprint_hash" text NOT NULL,
	"platform" text,
	"app_version" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "license_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"license_id" uuid,
	"organization_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" uuid,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"license_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"key_last4" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "license_keys_status" CHECK ("license_keys"."status" in ('active','revoked','superseded'))
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan" text DEFAULT 'starter' NOT NULL,
	"seat_count" integer NOT NULL,
	"status" text DEFAULT 'trial' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"grace_until" timestamp with time zone,
	"billing_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "licenses_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "licenses_seat_count_positive" CHECK ("licenses"."seat_count" > 0),
	CONSTRAINT "licenses_status" CHECK ("licenses"."status" in ('trial','active','past_due','suspended','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "access_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"resource" text NOT NULL,
	"resource_id" text,
	"action" text NOT NULL,
	"row_count" integer,
	"ip" text,
	"request_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_log_action" CHECK ("access_log"."action" in ('read','list','export','download'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"actor_pseudonym" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"request_id" text,
	"ip" text,
	"user_agent" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_type" CHECK ("audit_log"."actor_type" in ('user','system','api_key','integration'))
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"purpose" text NOT NULL,
	"granted" boolean NOT NULL,
	"source" text,
	"ip" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erasure_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text,
	"completed_at" timestamp with time zone,
	"report" jsonb,
	CONSTRAINT "erasure_requests_method" CHECK ("erasure_requests"."method" is null or "erasure_requests"."method" in ('deleted','pseudonymized'))
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"requested_by" uuid,
	"scope" text DEFAULT 'organization' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"file_url" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"subtype" text,
	"parent_id" uuid,
	"is_postable" boolean DEFAULT true NOT NULL,
	"currency_code" char(3),
	"is_system" boolean DEFAULT false NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "accounts_org_code_uq" UNIQUE("organization_id","code"),
	CONSTRAINT "accounts_type" CHECK ("accounts"."type" in ('asset','liability','equity','income','expense'))
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" char(3) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"minor_unit" smallint DEFAULT 2 NOT NULL,
	"symbol" text
);
--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"organization_id" uuid NOT NULL,
	"sequence_key" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	"padding" smallint DEFAULT 5 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"base_code" char(3) NOT NULL,
	"quote_code" char(3) NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"as_of" date NOT NULL,
	"source" text,
	CONSTRAINT "exchange_rates_uq" UNIQUE("organization_id","base_code","quote_code","as_of")
);
--> statement-breakpoint
CREATE TABLE "fiscal_periods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"fiscal_year" integer NOT NULL,
	"period_no" smallint NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	CONSTRAINT "fiscal_periods_uq" UNIQUE("organization_id","fiscal_year","period_no"),
	CONSTRAINT "fiscal_periods_status" CHECK ("fiscal_periods"."status" in ('open','closed','locked')),
	CONSTRAINT "fiscal_periods_range" CHECK ("fiscal_periods"."ends_on" >= "fiscal_periods"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"entry_no" integer NOT NULL,
	"entry_date" date NOT NULL,
	"fiscal_period_id" uuid,
	"description" text,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"reverses_entry_id" uuid,
	"reversed_by_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone,
	CONSTRAINT "journal_entries_org_no_uq" UNIQUE("organization_id","entry_no"),
	CONSTRAINT "journal_entries_status" CHECK ("journal_entries"."status" in ('draft','posted','reversed')),
	CONSTRAINT "journal_entries_source_type" CHECK ("journal_entries"."source_type" in ('manual','invoice','payment','stock_movement','fx_revaluation','opening_balance','period_close'))
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"debit_minor" bigint DEFAULT 0 NOT NULL,
	"credit_minor" bigint DEFAULT 0 NOT NULL,
	"currency_code" char(3) NOT NULL,
	"fx_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"base_debit_minor" bigint DEFAULT 0 NOT NULL,
	"base_credit_minor" bigint DEFAULT 0 NOT NULL,
	"business_partner_id" uuid,
	"tax_rate_id" uuid,
	"memo" text,
	CONSTRAINT "journal_lines_entry_line_uq" UNIQUE("journal_entry_id","line_no"),
	CONSTRAINT "journal_lines_one_sided" CHECK (("journal_lines"."debit_minor" = 0) <> ("journal_lines"."credit_minor" = 0)),
	CONSTRAINT "journal_lines_non_negative" CHECK ("journal_lines"."debit_minor" >= 0 and "journal_lines"."credit_minor" >= 0
          and "journal_lines"."base_debit_minor" >= 0 and "journal_lines"."base_credit_minor" >= 0),
	CONSTRAINT "journal_lines_sides_agree" CHECK (("journal_lines"."debit_minor" = 0) = ("journal_lines"."base_debit_minor" = 0)
          and ("journal_lines"."credit_minor" = 0) = ("journal_lines"."base_credit_minor" = 0)),
	CONSTRAINT "journal_lines_fx_positive" CHECK ("journal_lines"."fx_rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rate" numeric(6, 4) NOT NULL,
	"country_code" char(2),
	"category" text DEFAULT 'standard' NOT NULL,
	"en16931_category" text DEFAULT 'S' NOT NULL,
	"sales_account_id" uuid,
	"purchase_account_id" uuid,
	"valid_from" date,
	"valid_to" date,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "tax_rates_org_code_uq" UNIQUE("organization_id","code"),
	CONSTRAINT "tax_rates_en16931_category" CHECK ("tax_rates"."en16931_category" in ('S','Z','E','AE','K','G','O','L','M')),
	CONSTRAINT "tax_rates_rate_range" CHECK ("tax_rates"."rate" >= 0 and "tax_rates"."rate" <= 1)
);
--> statement-breakpoint
CREATE TABLE "business_partners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"partner_no" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"is_prospect" boolean DEFAULT false NOT NULL,
	"country_code" char(2),
	"tax_id" text,
	"tax_scheme" text,
	"registration_no" text,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"credit_limit_minor" bigint,
	"currency_code" char(3),
	"einvoice_routing_id" text,
	"einvoice_format" text DEFAULT 'none' NOT NULL,
	"owner_user_id" uuid,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone,
	CONSTRAINT "business_partners_org_no_uq" UNIQUE("organization_id","partner_no"),
	CONSTRAINT "business_partners_einvoice_format" CHECK ("business_partners"."einvoice_format" in ('none','peppol_bis3','fatturapa','facturx','xrechnung'))
);
--> statement-breakpoint
CREATE TABLE "partner_addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"type" text DEFAULT 'billing' NOT NULL,
	"street" text,
	"street2" text,
	"city" text,
	"region" text,
	"postcode" text,
	"country_code" char(2),
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "partner_addresses_type" CHECK ("partner_addresses"."type" in ('billing','shipping','legal'))
);
--> statement-breakpoint
CREATE TABLE "partner_contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"role" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"consent_recorded_at" timestamp with time zone,
	"consent_source" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "partner_contacts_consent_evidenced" CHECK ("partner_contacts"."marketing_consent" = false or "partner_contacts"."consent_recorded_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"iban" text,
	"bic" text,
	"account_number" text,
	"currency_code" char(3) NOT NULL,
	"gl_account_id" uuid NOT NULL,
	"opening_balance_minor" bigint DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bank_import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"source" text DEFAULT 'csv' NOT NULL,
	"filename" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"imported_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"imported_by" uuid,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"value_date" date NOT NULL,
	"booking_date" date,
	"amount_minor" bigint NOT NULL,
	"currency_code" char(3) NOT NULL,
	"description" text,
	"counterparty_name" text,
	"counterparty_iban" text,
	"external_id" text,
	"import_batch_id" uuid,
	"reconciliation_status" text DEFAULT 'unreconciled' NOT NULL,
	"matched_payment_id" uuid,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transactions_external_uq" UNIQUE("bank_account_id","external_id"),
	CONSTRAINT "bank_transactions_recon_status" CHECK ("bank_transactions"."reconciliation_status" in ('unreconciled','matched','reconciled','ignored')),
	CONSTRAINT "bank_transactions_amount_nonzero" CHECK ("bank_transactions"."amount_minor" <> 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(18, 4) DEFAULT '1' NOT NULL,
	"unit_code" text DEFAULT 'C62' NOT NULL,
	"unit_price_minor" bigint DEFAULT 0 NOT NULL,
	"discount_pct" numeric(6, 4),
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"net_minor" bigint DEFAULT 0 NOT NULL,
	"tax_rate_id" uuid,
	"tax_amount_minor" bigint DEFAULT 0 NOT NULL,
	"account_id" uuid,
	"purchase_order_line_id" uuid,
	"goods_receipt_line_id" uuid,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "invoice_lines_invoice_line_uq" UNIQUE("invoice_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_no" text NOT NULL,
	"direction" text NOT NULL,
	"business_partner_id" uuid NOT NULL,
	"partner_snapshot" jsonb,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"delivery_date" date,
	"payment_terms" text,
	"currency_code" char(3) NOT NULL,
	"fx_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"subtotal_minor" bigint DEFAULT 0 NOT NULL,
	"tax_total_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"base_total_minor" bigint DEFAULT 0 NOT NULL,
	"amount_paid_minor" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"journal_entry_id" uuid,
	"source_order_id" uuid,
	"document_type_code" text DEFAULT '380' NOT NULL,
	"buyer_reference" text,
	"order_reference" text,
	"payment_means_code" text,
	"einvoice_status" text DEFAULT 'not_required' NOT NULL,
	"einvoice_payload_id" uuid,
	"match_status" text,
	"match_tolerance_applied" jsonb,
	"notes" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "invoices_org_no_uq" UNIQUE("organization_id","invoice_no"),
	CONSTRAINT "invoices_direction" CHECK ("invoices"."direction" in ('ar','ap')),
	CONSTRAINT "invoices_status" CHECK ("invoices"."status" in ('draft','issued','partially_paid','paid','cancelled','credited')),
	CONSTRAINT "invoices_einvoice_status" CHECK ("invoices"."einvoice_status" in ('not_required','pending','sent','accepted','rejected')),
	CONSTRAINT "invoices_match_status" CHECK ("invoices"."match_status" is null or "invoices"."match_status" in
          ('not_applicable','matched','price_variance','quantity_variance','unmatched')),
	CONSTRAINT "invoices_due_after_issue" CHECK ("invoices"."due_date" >= "invoices"."issue_date"),
	CONSTRAINT "invoices_totals_non_negative" CHECK ("invoices"."amount_paid_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"base_amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_uq" UNIQUE("payment_id","invoice_id"),
	CONSTRAINT "payment_allocations_positive" CHECK ("payment_allocations"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_no" text NOT NULL,
	"direction" text NOT NULL,
	"payment_date" date NOT NULL,
	"business_partner_id" uuid,
	"bank_account_id" uuid NOT NULL,
	"currency_code" char(3) NOT NULL,
	"fx_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"base_amount_minor" bigint NOT NULL,
	"unallocated_minor" bigint DEFAULT 0 NOT NULL,
	"method" text DEFAULT 'bank_transfer' NOT NULL,
	"reference" text,
	"status" text DEFAULT 'posted' NOT NULL,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone,
	CONSTRAINT "payments_org_no_uq" UNIQUE("organization_id","payment_no"),
	CONSTRAINT "payments_direction" CHECK ("payments"."direction" in ('in','out')),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_minor" > 0),
	CONSTRAINT "payments_method" CHECK ("payments"."method" in ('bank_transfer','card','cash','sepa_dd','cheque','other'))
);
--> statement-breakpoint
ALTER TABLE "module_settings" ADD CONSTRAINT "module_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_preferences" ADD CONSTRAINT "workspace_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_preferences" ADD CONSTRAINT "workspace_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_activations" ADD CONSTRAINT "device_activations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_activations" ADD CONSTRAINT "device_activations_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_activations" ADD CONSTRAINT "device_activations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_events" ADD CONSTRAINT "license_events_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_events" ADD CONSTRAINT "license_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_events" ADD CONSTRAINT "license_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_keys" ADD CONSTRAINT "license_keys_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_keys" ADD CONSTRAINT "license_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_log" ADD CONSTRAINT "access_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_log" ADD CONSTRAINT "access_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_fiscal_period_id_fiscal_periods_id_fk" FOREIGN KEY ("fiscal_period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tax_rate_id_tax_rates_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_sales_account_id_accounts_id_fk" FOREIGN KEY ("sales_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_purchase_account_id_accounts_id_fk" FOREIGN KEY ("purchase_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_addresses" ADD CONSTRAINT "partner_addresses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_addresses" ADD CONSTRAINT "partner_addresses_partner_id_business_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."business_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_contacts" ADD CONSTRAINT "partner_contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_contacts" ADD CONSTRAINT "partner_contacts_partner_id_business_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."business_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_gl_account_id_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_import_batch_id_bank_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."bank_import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_matched_payment_id_payments_id_fk" FOREIGN KEY ("matched_payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tax_rate_id_tax_rates_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_business_partner_id_business_partners_id_fk" FOREIGN KEY ("business_partner_id") REFERENCES "public"."business_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_partner_id_business_partners_id_fk" FOREIGN KEY ("business_partner_id") REFERENCES "public"."business_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "module_settings_org_idx" ON "module_settings" USING btree ("organization_id","module_key");--> statement-breakpoint
CREATE INDEX "organizations_region_idx" ON "organizations" USING btree ("region");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "memberships_seat_idx" ON "memberships" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "device_activations_org_idx" ON "device_activations" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "license_events_org_idx" ON "license_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "license_keys_one_active_uq" ON "license_keys" USING btree ("license_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "license_keys_org_idx" ON "license_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "access_log_org_time_idx" ON "access_log" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "access_log_user_idx" ON "access_log" USING btree ("organization_id","user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_org_time_idx" ON "audit_log" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "consent_records_subject_idx" ON "consent_records" USING btree ("organization_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "erasure_requests_org_idx" ON "erasure_requests" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "export_jobs_org_idx" ON "export_jobs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "accounts_org_type_idx" ON "accounts" USING btree ("organization_id","type");--> statement-breakpoint
CREATE INDEX "accounts_org_subtype_idx" ON "accounts" USING btree ("organization_id","subtype");--> statement-breakpoint
CREATE UNIQUE INDEX "document_sequences_pk" ON "document_sequences" USING btree ("organization_id","sequence_key");--> statement-breakpoint
CREATE INDEX "exchange_rates_lookup_idx" ON "exchange_rates" USING btree ("base_code","quote_code","as_of");--> statement-breakpoint
CREATE INDEX "fiscal_periods_range_idx" ON "fiscal_periods" USING btree ("organization_id","starts_on","ends_on");--> statement-breakpoint
CREATE INDEX "journal_entries_org_date_idx" ON "journal_entries" USING btree ("organization_id","entry_date");--> statement-breakpoint
CREATE INDEX "journal_entries_source_idx" ON "journal_entries" USING btree ("organization_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_idx" ON "journal_lines" USING btree ("journal_entry_id","line_no");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("organization_id","account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_partner_idx" ON "journal_lines" USING btree ("organization_id","business_partner_id");--> statement-breakpoint
CREATE INDEX "business_partners_org_name_idx" ON "business_partners" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "business_partners_roles_idx" ON "business_partners" USING btree ("organization_id","is_customer","is_supplier");--> statement-breakpoint
CREATE INDEX "partner_addresses_partner_idx" ON "partner_addresses" USING btree ("organization_id","partner_id");--> statement-breakpoint
CREATE INDEX "partner_contacts_partner_idx" ON "partner_contacts" USING btree ("organization_id","partner_id");--> statement-breakpoint
CREATE INDEX "bank_accounts_org_idx" ON "bank_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bank_import_batches_org_idx" ON "bank_import_batches" USING btree ("organization_id","bank_account_id");--> statement-breakpoint
CREATE INDEX "bank_transactions_org_date_idx" ON "bank_transactions" USING btree ("organization_id","bank_account_id","value_date");--> statement-breakpoint
CREATE INDEX "bank_transactions_recon_idx" ON "bank_transactions" USING btree ("organization_id","reconciliation_status");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_org_partner_idx" ON "invoices" USING btree ("organization_id","business_partner_id");--> statement-breakpoint
CREATE INDEX "invoices_org_status_due_idx" ON "invoices" USING btree ("organization_id","status","due_date");--> statement-breakpoint
CREATE INDEX "invoices_org_direction_idx" ON "invoices" USING btree ("organization_id","direction","issue_date");--> statement-breakpoint
CREATE INDEX "payment_allocations_invoice_idx" ON "payment_allocations" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX "payments_org_partner_idx" ON "payments" USING btree ("organization_id","business_partner_id");--> statement-breakpoint
CREATE INDEX "payments_org_date_idx" ON "payments" USING btree ("organization_id","payment_date");