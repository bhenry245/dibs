# The AWS resources for Dibs. Run Terraform from this folder, with your AWS profile set:
#
#   export AWS_PROFILE=dibs
#   terraform init     # once, and after adding a provider (run it again for random)
#   terraform plan     # preview the changes
#   terraform apply    # make them, after you type yes

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  description = "The AWS Region for all resources. New experience projects only allow one."
  type        = string
  default     = "us-east-2"
}

variable "allowed_origins" {
  description = "The websites whose browser pages may upload receipt photos."
  type        = list(string)
  default     = ["http://localhost:5173", "https://dibsapp.co"]
}

# Receipt photos. Bucket names are shared across all of AWS, so AWS adds a unique ending to this.
resource "aws_s3_bucket" "receipts" {
  bucket_prefix = "dibs-receipts-"
}

# Receipts can show locations, card digits and names, so nothing here can ever be made public.
resource "aws_s3_bucket_public_access_block" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Turns off per-file permissions (ACLs), so access is only controlled by policies.
resource "aws_s3_bucket_ownership_controls" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Deletes photos 30 days after upload (design doc §15).
resource "aws_s3_bucket_lifecycle_configuration" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  rule {
    id     = "expire-photos"
    status = "Enabled"

    filter {}

    expiration {
      days = 30
    }
  }
}

# Lets browser pages on our sites upload directly. This grants no access by itself: an upload still
# needs a presigned permission from the API.
resource "aws_s3_bucket_cors_configuration" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  cors_rule {
    allowed_origins = var.allowed_origins
    allowed_methods = ["POST"]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

# The generated name, which the API will need.
output "receipts_bucket_name" {
  value = aws_s3_bucket.receipts.bucket
}
