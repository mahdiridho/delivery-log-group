# Lambda DELIVERY log group POC

This stack creates a manually invokable Node.js Lambda, a CloudWatch Logs group with class `DELIVERY`, and an S3 delivery destination. Lambda JSON application logs are routed through the CloudWatch Logs delivery source and delivery connection into a dedicated private bucket.

## Try it

Deploy to an account and Region that support the `DELIVERY` log class:

```sh
npm test
npx cdk deploy
```

In the Lambda console, open `delivery-class-poc`, choose **Test**, and use this event:

```json
{"message":"hello from the Lambda console"}
```

The test response contains `ok: true` and the request ID. The invocation log is routed through `/aws/lambda/delivery-class-poc` and delivered asynchronously to S3; allow several minutes for an object to appear. The deployed stack's `DeliveryBucketName` output identifies the bucket. Objects use an `AWSLogs/<account-id>/...` prefix with Hive-compatible partitioning.

Both the log group and dedicated bucket are configured for POC cleanup. The bucket has automatic object deletion enabled, so deleting this stack also deletes its delivered test logs. Do not reuse this cleanup policy for production data.

## Trade-offs

- `DELIVERY` is intended for delivering Lambda logs to Amazon S3 or Amazon Data Firehose. This POC configures S3 as the destination, including the CloudWatch Logs delivery resources and the bucket resource policy.
- CloudWatch retains `DELIVERY` log events for a fixed two days. This retention cannot be configured.
- `DELIVERY` does not support CloudWatch Logs Insights or the full set of interactive log-analysis features available with `STANDARD`.
- The log class cannot be changed after group creation. Moving to another class requires creating a new log group and updating the Lambda configuration.
- S3 delivery is asynchronous and incurs CloudWatch Logs delivery and S3 storage charges. The bucket uses S3-managed encryption; using a customer-managed KMS key requires additional key-policy permissions for the CloudWatch Logs delivery service.

Use `STANDARD` when you need full CloudWatch log analysis and longer configurable retention. Use `DELIVERY` when the goal is to route Lambda logs to S3 or Firehose and those CloudWatch limitations are acceptable.
