# The running app: one server with Docker, a Postgres database, and the address that points at it.
# Kept in the default network AWS gives every project, which is enough for a demo.

variable "domain" {
  description = "The address the app is served from. Its DNS zone must already exist in Route 53."
  type        = string
  default     = "dibsapp.co"
}

variable "repo_url" {
  description = "Where the server gets the code. It's public, so no credentials are needed."
  type        = string
  default     = "https://github.com/bhenry245/dibs.git"
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# The latest Amazon Linux for ARM. AWS publishes its ID here, so it's never hard-coded.
data "aws_ssm_parameter" "amazon_linux" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# Created by AWS when the domain was registered, so Terraform only looks it up.
data "aws_route53_zone" "main" {
  name = var.domain
}

# --- Firewalls ---

# The server only takes web traffic. There's no SSH port: Session Manager is used instead, which
# needs no open port or key.
resource "aws_security_group" "web" {
  name        = "dibs-web"
  description = "HTTP and HTTPS from anywhere"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description      = "HTTP, which Caddy redirects to HTTPS"
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    description      = "HTTPS"
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  egress {
    description      = "Out to AWS, Claude, GitHub and package downloads"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

# The database only accepts connections from the server, never from the internet.
resource "aws_security_group" "db" {
  name        = "dibs-db"
  description = "Postgres from the app server only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "Postgres from the app server"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.web.id]
  }
}

# --- Database ---

# Letters and numbers only, so it can go in a connection URL without escaping. Terraform keeps it in
# its state file, which is one reason that file stays out of git.
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_instance" "main" {
  identifier     = "dibs"
  engine         = "postgres"
  engine_version = "17"
  instance_class = "db.t4g.micro"

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "dibs"
  username = "dibs"
  password = random_password.db.result

  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false

  # A demo, so no final copy when it's deleted, and one day of automatic backups.
  backup_retention_period = 1
  skip_final_snapshot     = true
  apply_immediately       = true
}

# --- Settings the server reads at deploy time ---

# SecureString is encrypted by AWS, and only roles allowed to read it can decrypt it.
resource "aws_ssm_parameter" "database_url" {
  name  = "/dibs/database-url"
  type  = "SecureString"
  value = "postgresql+asyncpg://dibs:${random_password.db.result}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/dibs?ssl=require"
}

resource "aws_ssm_parameter" "receipts_bucket" {
  name  = "/dibs/receipts-bucket"
  type  = "String"
  value = aws_s3_bucket.receipts.bucket
}

resource "aws_ssm_parameter" "site_address" {
  name  = "/dibs/site-address"
  type  = "String"
  value = var.domain
}

# The Claude API key isn't here on purpose: anything Terraform manages ends up in its state file.
# You add it yourself as /dibs/anthropic-api-key.

# --- What the server is allowed to do ---

resource "aws_iam_role" "app" {
  name = "dibs-app-server"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Lets you open a terminal on the server through AWS, and run deploys, without SSH.
resource "aws_iam_role_policy_attachment" "session_manager" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Least privilege: receipt photos in one bucket, and this app's own settings. Nothing else.
resource "aws_iam_role_policy" "app" {
  name = "dibs-app"
  role = aws_iam_role.app.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReceiptPhotos"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.receipts.arn}/receipts/*"
      },
      {
        Sid      = "AppSettings"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = "arn:aws:ssm:${var.region}:*:parameter/dibs/*"
      },
    ]
  })
}

resource "aws_iam_instance_profile" "app" {
  name = "dibs-app-server"
  role = aws_iam_role.app.name
}

# --- The server ---

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.amazon_linux.value
  instance_type          = "t4g.small"
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.web.id]
  iam_instance_profile   = aws_iam_instance_profile.app.name

  metadata_options {
    # Requires the safer version of the metadata service.
    http_tokens = "required"
    # 2, not 1, so the API inside its Docker container can still reach the server's AWS role.
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  # Runs once, the first time the server starts.
  user_data = templatefile("${path.module}/bootstrap.sh.tftpl", { repo_url = var.repo_url })

  # Without these, a new Amazon Linux release or an edit to the startup script would rebuild the
  # whole server.
  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = {
    Name = "dibs-app"
  }

  # The deploy needs the database address and settings to exist first.
  depends_on = [aws_ssm_parameter.database_url, aws_ssm_parameter.site_address]
}

# A fixed public address, so the domain keeps working if the server is stopped and started.
resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"
}

resource "aws_route53_record" "app" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.app.public_ip]
}

output "site_url" {
  value = "https://${var.domain}"
}

output "server_instance_id" {
  value = aws_instance.app.id
}

output "server_ip" {
  value = aws_eip.app.public_ip
}
