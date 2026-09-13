import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';

/**
 * Verification stack for the Lambda 90-minute function timeout
 * (asynchronous / ESM invocations on Lambda Managed Instances).
 *
 * 1. A function that sleeps 20 minutes with a 30-minute timeout,
 *    invoked asynchronously. Execution is verified via CloudWatch Logs.
 * 2. S3 PUT events trigger the same function (S3 notifications are
 *    asynchronous invocations, so the extended timeout applies).
 * 3. A durable function with 5 steps x 20-minute sleeps (100 minutes
 *    of total work). Each invocation runs longer than 15 minutes, and
 *    the execution spans multiple invocations by suspending with
 *    context.wait() between steps (checkpoint & replay).
 */
export class ExampleLambda90MinutesFunctionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------
    // Shared infrastructure: VPC + Capacity Provider (Lambda Managed Instances)
    // ------------------------------------------------------------------

    // LMI runs functions on EC2 instances inside this VPC. The instances
    // need outbound internet access (NAT) to communicate with the Lambda
    // service and pull runtime images. 3 AZs are required for the fleet.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    const capacityProviderSecurityGroup = new ec2.SecurityGroup(this, 'CapacityProviderSecurityGroup', {
      vpc,
      description: 'Security group for Lambda Managed Instances capacity provider',
      allowAllOutbound: true,
    });

    // Role that the Lambda service assumes to manage EC2 instances
    // (launch, tag, attach ENIs) on our behalf.
    const operatorRole = new iam.Role(this, 'CapacityProviderOperatorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSLambdaManagedEC2ResourceOperator'),
      ],
    });

    const capacityProvider = new lambda.CfnCapacityProvider(this, 'CapacityProvider', {
      vpcConfig: {
        subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
        securityGroupIds: [capacityProviderSecurityGroup.securityGroupId],
      },
      permissionsConfig: {
        capacityProviderOperatorRoleArn: operatorRole.roleArn,
      },
      instanceRequirements: {
        architectures: ['arm64'],
      },
      capacityProviderScalingConfig: {
        // Cost ceiling for the verification. The fleet keeps a minimum of
        // 3 execution environments regardless of this value.
        maxVCpuCount: 16,
      },
    });

    // Attaches a function to the capacity provider. The L2 construct does
    // not support CapacityProviderConfig yet, so we override the L1 property.
    const attachToCapacityProvider = (fn: lambda.Function): void => {
      const cfnFunction = fn.node.defaultChild as lambda.CfnFunction;
      cfnFunction.addPropertyOverride('CapacityProviderConfig', {
        LambdaManagedInstancesCapacityProviderConfig: {
          CapacityProviderArn: capacityProvider.attrArn,
        },
      });
    };

    // ------------------------------------------------------------------
    // Verification 1: 20-minute sleep, 30-minute timeout, async invocation
    // ------------------------------------------------------------------

    const sleepFunction = new nodejs.NodejsFunction(this, 'SleepFunction', {
      entry: 'lambda/sleep-handler.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      // LMI requires at least 2048 MB
      memorySize: 2048,
      // Exceeds the previous 15-minute limit. Applies to async/ESM
      // invocations on LMI only; sync invocations remain capped at 15 min.
      timeout: cdk.Duration.minutes(30),
      logGroup: new logs.LogGroup(this, 'SleepFunctionLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    attachToCapacityProvider(sleepFunction);

    // LMI requires a published version; invocations must use a qualified ARN.
    const sleepAlias = new lambda.Alias(this, 'SleepFunctionAlias', {
      aliasName: 'live',
      version: sleepFunction.currentVersion,
    });

    sleepAlias.configureAsyncInvoke({
      // Avoid re-running a 20-minute sleep on failure during verification.
      retryAttempts: 0,
    });

    // ------------------------------------------------------------------
    // Verification 2: S3 PUT triggers the sleep function (async invocation)
    // ------------------------------------------------------------------

    const triggerBucket = new s3.Bucket(this, 'TriggerBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    triggerBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(sleepAlias),
    );

    // ------------------------------------------------------------------
    // Verification 3: durable function, 5 steps x 20-minute sleeps
    // ------------------------------------------------------------------

    const durableFunction = new nodejs.NodejsFunction(this, 'DurableFunction', {
      entry: 'lambda/durable-handler.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 2048,
      // Per-invocation timeout. Each invocation runs one 20-minute step and
      // then suspends via context.wait(), so it ends well within this limit.
      timeout: cdk.Duration.minutes(30),
      durableConfig: {
        // Upper bound for the whole execution (up to 366 days is allowed).
        // 6 hours is plenty for 100 minutes of work plus retries.
        executionTimeout: cdk.Duration.hours(6),
        retentionPeriod: cdk.Duration.days(7),
      },
      logGroup: new logs.LogGroup(this, 'DurableFunctionLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    attachToCapacityProvider(durableFunction);

    const durableAlias = new lambda.Alias(this, 'DurableFunctionAlias', {
      aliasName: 'live',
      version: durableFunction.currentVersion,
    });

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------

    new cdk.CfnOutput(this, 'SleepFunctionQualifiedName', {
      value: `${sleepFunction.functionName}:${sleepAlias.aliasName}`,
      description: 'Use with: aws lambda invoke --invocation-type Event',
    });

    new cdk.CfnOutput(this, 'DurableFunctionQualifiedName', {
      value: `${durableFunction.functionName}:${durableAlias.aliasName}`,
      description: 'Use with: aws lambda invoke --invocation-type Event --durable-execution-name <name>',
    });

    new cdk.CfnOutput(this, 'TriggerBucketName', {
      value: triggerBucket.bucketName,
      description: 'Put an object here to trigger the sleep function',
    });
  }
}
