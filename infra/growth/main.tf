terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}
variable "project_id" { type = string }
variable "region" { type = string }
variable "backend_url" { type = string }
variable "scheduler_service_account" { type = string }
variable "enable_jobs" {
  type    = bool
  default = false
}
locals {
  jobs = {
    label-events        = { schedule = "*/5 * * * *", path = "/api/internal/growth/label-events" }
    template-regression = { schedule = "*/5 * * * *", path = "/api/internal/growth/template-regression" }
    panel               = { schedule = "10 7 * * *", path = "/api/cron/growth/panel" }
    feedback            = { schedule = "30 7 * * *", path = "/api/cron/growth/feedback" }
    drive-scan          = { schedule = "*/5 * * * *", path = "/api/internal/growth/drive-scan" }
    drive-runs          = { schedule = "*/5 * * * *", path = "/api/internal/growth/drive-runs" }
    drive-revoke        = { schedule = "*/5 * * * *", path = "/api/internal/growth/drive-revoke" }
    print-jobs          = { schedule = "*/5 * * * *", path = "/api/internal/growth/print-jobs" }
    api-jobs            = { schedule = "*/5 * * * *", path = "/api/internal/growth/api-jobs" }
    callbacks           = { schedule = "*/5 * * * *", path = "/api/internal/growth/callbacks" }
    outbox              = { schedule = "*/5 * * * *", path = "/api/cron/growth/outbox" }
    quality             = { schedule = "*/15 * * * *", path = "/api/cron/growth/quality" }
    aggregate           = { schedule = "10 6 * * *", path = "/api/cron/growth/aggregate" }
    billing-reconcile   = { schedule = "40 6 * * *", path = "/api/cron/growth/billing-reconcile" }
    retention           = { schedule = "0 3 * * *", path = "/api/cron/growth/retention" }
    recover-zpl         = { schedule = "*/5 * * * *", path = "/api/zpl/internal/recover-durable" }
    recover-pdf         = { schedule = "*/5 * * * *", path = "/api/pdf-preparation/internal/recover" }
  }
}
resource "google_cloud_scheduler_job" "growth" {
  for_each         = local.jobs
  project          = var.project_id
  region           = var.region
  name             = "zplpdf-growth-${each.key}"
  schedule         = each.value.schedule
  time_zone        = "America/Merida"
  paused           = !var.enable_jobs
  attempt_deadline = "600s"
  retry_config {
    retry_count          = 3
    min_backoff_duration = "30s"
    max_backoff_duration = "300s"
    max_doublings        = 3
  }
  http_target {
    uri         = "${trimsuffix(var.backend_url, "/")}${each.value.path}"
    http_method = "POST"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")
    oidc_token {
      service_account_email = var.scheduler_service_account
      audience              = var.backend_url
    }
  }
}
