import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GalvitronStack } from '../lib/galvitron-stack';

const app = new cdk.App();
new GalvitronStack(app, 'GalvitronStack', {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  /* env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
  }, */

  // GitHub configuration
  githubOwner: 'mzienert',
  githubRepo: 'sentinel',
  githubBranch: 'master',  // or 'main' depending on your default branch
  githubTokenSecretName: 'github-token-secret-name',

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  env: { account: '619326977873', region: 'us-west-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});