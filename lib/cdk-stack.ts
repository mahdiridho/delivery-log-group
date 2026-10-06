import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

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
