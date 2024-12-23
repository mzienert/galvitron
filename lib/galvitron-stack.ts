// lib/galvitron-stack.ts
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as path from 'path';

import { S3Construct } from './constructs/storage/s3-construct';
import { DynamoDBConstruct } from './constructs/database/dynamodb-construct';
import { EC2Construct } from './constructs/compute/ec2-construct';
import { VPCConstruct } from './constructs/network/vpc-construct';
import { CodePipelineConstruct } from './constructs/pipeline/codepipeline-construct';
import { NextJSPipelineConstruct } from './constructs/pipeline/nextjs-pipeline-construct';
import { IAMRolesConstruct } from './constructs/roles/iam-roles-construct';
import { CognitoPool } from '../cognito';

export interface GalvitronStackProps extends cdk.StackProps {
  readonly githubOwner: string;
  readonly githubRepo: string;
  readonly githubBranch: string;
  readonly githubTokenSecretName: string;
}

export class GalvitronStack extends cdk.Stack {
  private readonly dynamoConstruct: DynamoDBConstruct;

  constructor(scope: Construct, id: string, props: GalvitronStackProps) {
    super(scope, id, props);


    // Define tags as constants
    const TAGS = {
      Environment: 'Development',
      Name: 'WebSocket-Client'
    };

    // Create VPC
    const vpcConstruct = new VPCConstruct(this, 'VPCConstruct');

    // Create S3 Bucket
    const s3Construct = new S3Construct(this, 'S3Construct');

    // Create DynamoDB Table
    this.dynamoConstruct = new DynamoDBConstruct(this, 'KlineTable', {
      tableName: 'GalvitronTable'
    });

    // Create IAM Roles
    const iamRoles = new IAMRolesConstruct(this, 'IAMRoles', {
      sentinelBucket: s3Construct.bucket,
      region: this.region,
      account: this.account,
      dynamoTableArn: this.dynamoConstruct.table.tableArn
    });

    // Grant table permissions to instance role
    this.dynamoConstruct.table.grantReadWriteData(iamRoles.instanceRole);

    // Create wait condition handle for EC2 instance
    const handle = new cdk.CfnWaitConditionHandle(this, 'WaitHandle');

    // Create user data script
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      // Function to signal success or failure
      'function signal_cf() {',
      '  local status=$1',
      '  local message=$2',
      '  echo "Signaling with status: $status, message: $message"',
      `  curl -X PUT -H 'Content-Type:' --data-binary '{"Status":"'$status'","Reason":"'$message'","UniqueId":"'$status'","Data":"'$message'"}' "${handle.ref}"`,
      '}',
      
      // Error handling function
      'function handle_error() {',
      '  local error_message=$1',
      '  echo "Error: $error_message"',
      '  signal_cf FAILURE "$error_message"',
      '  exit 1',
      '}',
      
      'trap \'handle_error "Script interrupted"\' INT TERM',
      '#!/bin/bash',
      'set -e',
      'set -o pipefail',
      
      // Redirect output to log file
      'exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1',
      
      'echo "Starting user data script execution..."',
      'set -x',
      
      // Define error handling
      'function error_exit() {',
      '    echo "${1:-\\"Unknown Error\\"}" 1>&2',
      '    exit 1',
      '}',
      
      // System Updates and Base Packages
      'yum update -y || error_exit "Failed to update system packages"',
      'yum install -y ruby wget || error_exit "Failed to install base packages"',
      
      // Node.js Setup
      'sudo mkdir -p /home/ec2-user/.nvm',
      'sudo mkdir -p /home/ec2-user/.pm2',
      'sudo mkdir -p /home/ec2-user/app',
      'sudo chown -R ec2-user:ec2-user /home/ec2-user/.nvm',
      'sudo chown -R ec2-user:ec2-user /home/ec2-user/.pm2',
      'sudo chown -R ec2-user:ec2-user /home/ec2-user/app',
      
      // Install NVM and Node.js
      'sudo -u ec2-user bash << \'EOF\'',
      'export NVM_DIR="/home/ec2-user/.nvm"',
      'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash',
      'source $NVM_DIR/nvm.sh',
      'nvm install 20',
      'nvm use 20',
      'nvm alias default 20',
      '',
      'npm install -g pm2 yarn',
      '',
      'export PM2_HOME="/home/ec2-user/.pm2"',
      'pm2 install pm2-logrotate',
      'pm2 set pm2-logrotate:max_size 10M',
      'pm2 set pm2-logrotate:retain 5',
      'pm2 set pm2-logrotate:compress true',
      'EOF',
      
      // CodeDeploy Agent Installation
      'echo "Installing CodeDeploy agent..."',
      'sudo systemctl stop codedeploy-agent || true',
      'sudo rm -rf /opt/codedeploy-agent',
      'sudo rm -f /etc/init.d/codedeploy-agent',
      'sudo rm -f /etc/systemd/system/codedeploy-agent.service',
      
      'sudo mkdir -p /opt/codedeploy-agent/deployment-root',
      'sudo mkdir -p /etc/codedeploy-agent/conf',
      'sudo mkdir -p /var/log/aws/codedeploy-agent',
      
      'sudo chmod 755 /opt/codedeploy-agent/deployment-root',
      'sudo chmod 755 /var/log/aws/codedeploy-agent',
      
      'cd /home/ec2-user',
      'region=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)',
      'sudo wget "https://aws-codedeploy-${region}.s3.${region}.amazonaws.com/latest/install"',
      'sudo chmod +x ./install',
      'sudo ./install auto || error_exit "Failed to install CodeDeploy agent"',
      
      // Create systemd service file
      'cat << \'EOF\' | sudo tee /etc/systemd/system/codedeploy-agent.service',
      '[Unit]',
      'Description=AWS CodeDeploy Host Agent',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'ExecStart=/opt/codedeploy-agent/bin/codedeploy-agent start',
      'ExecStop=/opt/codedeploy-agent/bin/codedeploy-agent stop',
      'User=root',
      'Restart=always',
      'RestartSec=10',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOF',
      
      'sudo systemctl daemon-reload',
      'sudo systemctl enable codedeploy-agent',
      'sudo systemctl start codedeploy-agent',
      
      // Verify installation
      'echo "Verifying complete environment setup..."',
      
      // Verify Node.js installation
      'if ! sudo -u ec2-user bash -c \'source $HOME/.nvm/nvm.sh && node --version\'; then',
      '  handle_error "Node.js not properly installed"',
      'fi',
      
      // Verify NPM installation
      'if ! sudo -u ec2-user bash -c \'source $HOME/.nvm/nvm.sh && npm --version\'; then',
      '  handle_error "NPM not properly installed"',
      'fi',
      
      // Verify PM2 installation
      'if ! sudo -u ec2-user bash -c \'source $HOME/.nvm/nvm.sh && pm2 --version\'; then',
      '  handle_error "PM2 not properly installed"',
      'fi',
      
      // Verify CodeDeploy agent
      'echo "Verifying CodeDeploy agent..."',
      'if ! systemctl is-active --quiet codedeploy-agent; then',
      '  handle_error "CodeDeploy agent is not running"',
      'fi',
      
      'echo "Verifying CodeDeploy agent logs..."',
      'if ! test -f /var/log/aws/codedeploy-agent/codedeploy-agent.log; then',
      '  handle_error "CodeDeploy agent log file not found"',
      'fi',
      
      // Final verification and signal success
      'echo "All verifications passed, signaling success..."',
      `curl -X PUT -H 'Content-Type:' --data-binary '{"Status":"SUCCESS","Reason":"Configuration Complete","UniqueId":"ConfigComplete","Data":"Instance setup completed successfully"}' "${handle.ref}"`
    );

    // Create EC2 Instance
    const ec2Construct = new EC2Construct(this, 'EC2Construct', {
      vpc: vpcConstruct.vpc,
      keyName: 'galvitron-key-2',
      userData: userData,
      role: iamRoles.instanceRole,
      tags: TAGS
    });

    // Create CodeDeploy application
    const application = new codedeploy.ServerApplication(this, 'CodeDeployApplication', {
      applicationName: 'GalvitronApplication',
    });

    // Create deployment group
    const deploymentGroup = new codedeploy.ServerDeploymentGroup(this, 'CodeDeployDeploymentGroup', {
      application,
      deploymentGroupName: 'GalvitronDeploymentGroup',
      deploymentConfig: codedeploy.ServerDeploymentConfig.ALL_AT_ONCE,
      role: iamRoles.codeDeployServiceRole,
      installAgent: true,
      ec2InstanceTags: new codedeploy.InstanceTagSet({
        Environment: ['Development'],
        Name: ['WebSocket-Client']
      })
    });

    // Create build project
    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      role: iamRoles.buildRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
        environmentVariables: {
          SENTINEL_BUCKET: {
            value: s3Construct.bucket.bucketName,
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT
          }
        }
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'mkdir -p /tmp/workspace',
              'cp -r . /tmp/workspace/galvitron',
              'cd /tmp/workspace',
              'git clone https://github.com/mzienert/sentinel.git || echo "Repository already exists"'
            ]
          },
          pre_build: {
            commands: [
              // Build Lambda
              'cd /tmp/workspace/sentinel/lambdas/hello-world',
              'npm install',
              'npm run build',
              'cp -r node_modules dist/',
              'cp package*.json dist/',
              'cd /tmp/workspace/sentinel'  // Navigate back to sentinel root
            ]
          },
          build: {
            commands: [
              // Build main Sentinel app
              'rm -rf dist',
              'npm install',
              'npm run build',
              'mkdir -p dist/node_modules',
              'cp -r node_modules/* dist/node_modules/',
              'cp package*.json dist/'
            ]
          },
          post_build: {
            commands: [
              'mkdir -p dist/logs',
              'ls -la dist',
              'ls -la dist/node_modules || echo "no node_modules found"'
            ]
          }
        },
        artifacts: {
          'base-directory': '/tmp/workspace/sentinel',
          files: [
            'appspec.yml',
            'scripts/**/*',
            'ecosystem.config.js',
            'package*.json',
            'dist/**/*',
            'lambdas/hello-world/dist/**/*'
          ]
        }
      })
    });

    // Create CodePipeline
    const pipelineConstruct = new CodePipelineConstruct(this, 'CodePipelineConstruct', {
      githubOwner: props.githubOwner,
      githubRepo: props.githubRepo,
      githubBranch: props.githubBranch,
      githubTokenSecretName: props.githubTokenSecretName,
      artifactBucket: s3Construct.bucket,
      buildProject: buildProject,
      deploymentGroup: deploymentGroup
    });

    const nextjsPipelineConstruct = new NextJSPipelineConstruct(this, 'NextJSPipelineConstruct', {
      githubOwner: 'mzienert',
      githubRepo: 'blubrd',
      githubBranch: 'main',
      githubTokenSecretName: props.githubTokenSecretName,
    });

    // Create Lambda and API Gateway
    const helloWorldFunction = new lambda.Function(this, 'HelloWorldFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(this.getLambdaPath('hello-world'), {
        exclude: ['node_modules', 'node_modules/**', '.git', 'README.md']
      }),
      handler: 'dist/index.handler',
      environment: {
        NODE_ENV: 'production',
        DYNAMODB_TABLE: this.dynamoConstruct.table.tableName
      },
      memorySize: 256, // Increased for better performance
      timeout: cdk.Duration.seconds(30),
      role: iamRoles.lambdaRole, // Use role from IAMRolesConstruct
    });

    this.dynamoConstruct.table.grantReadData(helloWorldFunction);   

    const api = new apigateway.LambdaRestApi(this, 'HelloWorldApi', {
      handler: helloWorldFunction,
      proxy: false,
    });

    const helloResource = api.root.addResource('hello');
    helloResource.addMethod('GET');

    // Create Cognito Pool
    new CognitoPool(this, 'MyCognitoPool', {
      stage: 'Beta',
    });

    // Create wait condition
    const wait = new cdk.CfnWaitCondition(this, 'WaitCondition', {
      count: 1,
      handle: handle.ref,
      timeout: '300'  // 5 minutes, as in the original working version
    });

    // Add dependency
    pipelineConstruct.pipeline.node.addDependency(wait);

    // Stack Outputs
    new cdk.CfnOutput(this, 'InstancePublicIP', {
      value: ec2Construct.instance.instancePublicIp,
      description: 'Public IP address of the EC2 instance',
    });

    new cdk.CfnOutput(this, 'SSHCommand', {
      value: `ssh -i ~/.ssh/galvitron-key-2 ec2-user@${ec2Construct.instance.instancePublicIp}`,
      description: 'Command to SSH into the instance',
    });

    new cdk.CfnOutput(this, 'DynamoDBTableName', {
      value: this.dynamoConstruct.table.tableName,
      description: 'Name of the DynamoDB table',
      exportName: 'GalvitronTableName'
    });
    

    new cdk.CfnOutput(this, 'SentinelBucketName', {
      value: s3Construct.bucket.bucketName,
      description: 'Name of the S3 bucket for deployments',
    });

    new cdk.CfnOutput(this, 'DeploymentGroupTags', {
      value: JSON.stringify(TAGS),
      description: 'EC2 tags that deployment group looks for'
    });

    new cdk.CfnOutput(this, 'DeploymentGroupArn', {
      value: deploymentGroup.deploymentGroupArn,
      description: 'Deployment Group ARN',
    });

    new cdk.CfnOutput(this, 'PipelineArn', {
      value: pipelineConstruct.pipeline.pipelineArn,
      description: 'Pipeline ARN',
    });

    // Lambda Function Outputs
    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      value: helloWorldFunction.functionArn,
      description: 'ARN of the Hello World Lambda function',
      exportName: 'HelloWorldLambdaArn'
    });

    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: api.url,
      description: 'URL of the API Gateway endpoint',
      exportName: 'HelloWorldApiUrl'
    });

    new cdk.CfnOutput(this, 'NextJSWebsiteURL', {
      value: `https://${nextjsPipelineConstruct.distribution.distributionDomainName}`,
      description: 'Next.js Website URL',
    });
    
    new cdk.CfnOutput(this, 'NextJSPipelineArn', {
      value: nextjsPipelineConstruct.pipeline.pipelineArn,
      description: 'Next.js Pipeline ARN',
    });
  }

  private getLambdaPath(lambdaName: string): string {
    // If we're in CodeBuild environment
    if (process.env.CODEBUILD_BUILD_ID) {
      return `/tmp/workspace/sentinel/lambdas/${lambdaName}`;
    }
    // For local development
    return path.join(__dirname, '..', '..', 'sentinel', 'lambdas', lambdaName);
  }
}