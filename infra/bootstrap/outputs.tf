output "bucket_name" {
  description = "Paste this into ../backend.tf's backend \"s3\" block (bucket)."
  value       = aws_s3_bucket.tf_state.bucket
}

output "dynamodb_table_name" {
  description = "Paste this into ../backend.tf's backend \"s3\" block (dynamodb_table)."
  value       = aws_dynamodb_table.tf_lock.name
}
