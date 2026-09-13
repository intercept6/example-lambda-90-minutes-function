#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ExampleLambda90MinutesFunctionStack } from '../lib/example-lambda-90-minutes-function-stack';

const app = new cdk.App();
new ExampleLambda90MinutesFunctionStack(app, 'ExampleLambda90MinutesFunctionStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' },
});
