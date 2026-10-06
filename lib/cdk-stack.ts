import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------
    // S3 destination
    // ------------------------------------------------------------
    const deliveryBucket = new s3.Bucket(this, 'DeliveryBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ------------------------------------------------------------
    // CloudWatch Logs DELIVERY log group
    // ------------------------------------------------------------
    const deliveryLogGroup = new logs.LogGroup(this, 'DeliveryLogGroup', {
      logGroupName: '/aws/lambda/delivery-class-poc',
      logGroupClass: logs.LogGroupClass.DELIVERY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ------------------------------------------------------------
    // Lambda
    // ------------------------------------------------------------
    const deliveryFunction = new lambda.Function(this, 'DeliveryClassPocFunction', {
      functionName: 'delivery-class-poc',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
exports.handler = async (event, context) => {
  const message = typeof event?.message === 'string' ? event.message : 'manual test invocation';
  console.info({
    recordType: 'delivery-class-poc',
    message,
    requestId: context.awsRequestId,
    timestamp: new Date().toISOString()
  });
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, message, requestId: context.awsRequestId })
  };
};
      `),
      logGroup: deliveryLogGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
    });

    // ------------------------------------------------------------
    // IAM role assumed by CloudWatch Logs
    // ------------------------------------------------------------
    const logDeliveryRole = new iam.Role(this, 'LogDeliveryRole', {
      assumedBy: new iam.ServicePrincipal('logs.amazonaws.com'),
    });
    logDeliveryRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:PutObject',
        ],
        resources: [
          deliveryBucket.arnForObjects('*'),
        ],
      }),
    );

    // ------------------------------------------------------------
    // CloudWatch Logs subscription filter -> S3
    // ------------------------------------------------------------
    const subscriptionFilter = new logs.CfnSubscriptionFilter(
      this,
      'S3SubscriptionFilter',
      {
        logGroupName: deliveryLogGroup.logGroupName,
        // Empty pattern = deliver all log events.
        filterPattern: '',
        // S3 bucket destination.
        destinationArn: deliveryBucket.bucketArn,
        // IAM role CloudWatch Logs assumes to write to S3.
        roleArn: logDeliveryRole.roleArn,
      },
    );

    // Explicit dependencies.
    subscriptionFilter.node.addDependency(deliveryLogGroup);
    subscriptionFilter.node.addDependency(deliveryBucket);
    subscriptionFilter.node.addDependency(logDeliveryRole);

    // ------------------------------------------------------------
    // Normalize S3 object names for Athena
    // ------------------------------------------------------------
    const sourcePrefix =
      `AWSLogs/${cdk.Aws.ACCOUNT_ID}/${cdk.Aws.REGION}/` +
      '_aws_lambda_delivery-class-poc/';

    const normalizeFunction = new lambda.Function(
      this,
      'NormalizeDeliveryLogsFunction',
      {
        functionName: 'normalize-delivery-class-poc-logs',
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'index.handler',
        timeout: cdk.Duration.minutes(1),
        code: lambda.Code.fromInline(`
const {
  S3Client,
  CopyObjectCommand,
} = require('@aws-sdk/client-s3');

const s3 = new S3Client({});

exports.handler = async (event) => {
  for (const record of event.Records ?? []) {
    const bucket = record.s3.bucket.name;

    const sourceKey = decodeURIComponent(
      record.s3.object.key.replace(/\\\\+/g, ' ')
    );

    // Only copy files from the original CloudWatch delivery prefix.
    if (
      !sourceKey.startsWith(${JSON.stringify(sourcePrefix)}) ||
      !sourceKey.endsWith('.log.zst')
    ) {
      continue;
    }

    // Remove the leading underscore from the filename only.
    const relativeKey = sourceKey.slice(
      ${JSON.stringify(sourcePrefix.length)}
    );

    const lastSlash = relativeKey.lastIndexOf('/');
    const directory = lastSlash >= 0
      ? relativeKey.slice(0, lastSlash + 1)
      : '';
    const filename = lastSlash >= 0
      ? relativeKey.slice(lastSlash + 1)
      : relativeKey;

    const normalizedFilename = filename.startsWith('_')
      ? filename.slice(1)
      : filename;

    const normalizedRelativeKey = directory + normalizedFilename;

    // Keep normalized objects separate from raw objects.
    const destinationKey =
      'athena/' +
      ${JSON.stringify(sourcePrefix)} +
      normalizedRelativeKey;

    const copySource =
      bucket + '/' +
      sourceKey.split('/').map(encodeURIComponent).join('/');

    await s3.send(new CopyObjectCommand({
      Bucket: bucket,
      Key: destinationKey,
      CopySource: copySource,
      MetadataDirective: 'COPY',
    }));

    console.log(JSON.stringify({
      sourceKey,
      destinationKey,
    }));
  }
};
    `),
      },
    );

    // DENY the auto-generated log group creation to avoid duplicate CloudWatch log streams.
    normalizeFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: ['*'],
      }),
    );

    // Allow the normalizer to read the original and write the copy.
    deliveryBucket.grantReadWrite(normalizeFunction);

    // Trigger only for original CloudWatch delivery objects.
    // The destination starts with "athena/", so it won't retrigger.
    deliveryBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(normalizeFunction),
      {
        prefix: sourcePrefix,
        suffix: '.log.zst',
      },
    );

    new cdk.CfnOutput(this, 'NormalizedLogsPrefix', {
      value: `s3://${deliveryBucket.bucketName}/athena/${sourcePrefix}`,
    });

    // ------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------
    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: deliveryFunction.functionName,
    });

    new cdk.CfnOutput(this, 'DeliveryLogGroupName', {
      value: deliveryLogGroup.logGroupName,
    });

    new cdk.CfnOutput(this, 'DeliveryBucketName', {
      value: deliveryBucket.bucketName,
    });
  }
}
