import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';

import { CognitoPool } from '../cognito';
import { Tags } from 'aws-cdk-lib';

export interface GalvitronStackProps extends cdk.StackProps {
  readonly githubOwner: string;
  readonly githubRepo: string;
  readonly githubBranch: string;
  readonly githubTokenSecretName: string;
}

export class GalvitronStack extends cdk.Stack {
  private sentinelBucket: s3.Bucket;
  private instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: GalvitronStackProps) {
    super(scope, id, props);

     // Define tags as constants to ensure consistency
     const ENVIRONMENT_TAG = {
      key: 'Environment',
      value: 'Development'
    };
    
    const NAME_TAG = {
      key: 'Name',
      value: 'WebSocket-Client'
    };

    const instanceRole = new iam.Role(this, 'EC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeDeployFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    // Add CodeDeploy permissions to instance role
    instanceRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'codedeploy:*',
        'ec2:DescribeInstances',
        'ec2:DescribeTags',
        'ec2:DescribeInstanceStatus',
        'tag:GetResources',
        'tag:GetTagKeys',
        'tag:GetTagValues',
        's3:Get*',
        's3:List*',
        's3:PutObject',
        's3:PutObjectAcl',
        's3:DeleteObject'
      ],
      resources: ['*']
    }));

    instanceRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeInstanceAttribute',
        'ec2:DescribeInstanceStatus',
        'ec2:DescribeInstances',
        'ec2:DescribeTags'
      ],
      resources: ['*']
    }));

    // Add permissions for CodeDeploy agent to register itself
    instanceRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:GetRole',
        'iam:PassRole',
        'iam:ListRoles',
      ],
      resources: ['*'],  // You might want to restrict this to specific roles
    }));

    // CodeDeploy Service Role
    const codeDeployServiceRole = new iam.Role(this, 'CodeDeployServiceRole', {
      assumedBy: new iam.ServicePrincipal('codedeploy.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSCodeDeployRole'),
      ],
    });

    codeDeployServiceRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:Describe*',
        'tag:GetTags',
        'tag:GetResources',
        'tag:GetTagValues',
        'tag:GetTagKeys',
        'autoscaling:*',
        'ec2:RunInstances',
        'ec2:CreateTags',
        'iam:PassRole'
      ],
      resources: ['*']
    }));

    // Create S3 bucket
    this.sentinelBucket = new s3.Bucket(this, 'SentinelBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      accessControl: s3.BucketAccessControl.PRIVATE,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    // Build Role
    const buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeBuildAdminAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
      ],
    });

    this.sentinelBucket.grantReadWrite(buildRole);

    buildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:PutObject',
        's3:GetObject',
        's3:ListBucket',
        'codedeploy:CreateDeployment',
        'codedeploy:GetDeployment',
        'codedeploy:GetDeploymentConfig',
        'codedeploy:RegisterApplicationRevision'
      ],
      resources: [
        `${this.sentinelBucket.bucketArn}/*`,
        this.sentinelBucket.bucketArn,
        `arn:aws:codedeploy:${this.region}:${this.account}:deploymentgroup:GalvitronApplication/GalvitronDeploymentGroup`,
        `arn:aws:codedeploy:${this.region}:${this.account}:application:GalvitronApplication`
      ]
    }));

    instanceRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:ListBucket',
        's3:PutObject',
        's3:GetObjectVersion'
      ],
      resources: [
        this.sentinelBucket.bucketArn,
        `${this.sentinelBucket.bucketArn}/*`
      ]
    }));


    // DynamoDB Table
    const table = new dynamodb.Table(this, 'GalvitronTable', {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { 
        name: 'id', 
        type: dynamodb.AttributeType.STRING 
      },
      pointInTimeRecovery: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // VPC Configuration
    const vpc = new ec2.Vpc(this, 'MyVPC', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        }
      ],
      flowLogs: {},
    });

    // Security Group Configuration
    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
      description: 'Security group with WebSocket support',
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow SSH access'
    );

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP/WebSocket access'
    );

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS/Secure WebSocket access'
    );

    // Lambda Function
    const helloWorldFunction = new lambda.Function(this, 'HelloWorldFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'hello.handler',
    });

    // Cognito Pool
    new CognitoPool(this, 'MyCognitoPool', {
      stage: 'Beta',
    });

    // API Gateway
    const api = new apigateway.LambdaRestApi(this, 'HelloWorldApi', {
      handler: helloWorldFunction,
      proxy: false,
    });

    const helloResource = api.root.addResource('hello');
    helloResource.addMethod('GET');

    // CodeDeploy Configuration
    const application = new codedeploy.ServerApplication(this, 'CodeDeployApplication', {
      applicationName: 'GalvitronApplication',
    });

    const deploymentGroup = new codedeploy.ServerDeploymentGroup(this, 'CodeDeployDeploymentGroup', {
      application,
      deploymentGroupName: 'GalvitronDeploymentGroup',
      deploymentConfig: codedeploy.ServerDeploymentConfig.ALL_AT_ONCE,
      role: codeDeployServiceRole,
      installAgent: true,
      ec2InstanceTags: new codedeploy.InstanceTagSet({
        Environment: ['Development'],
        Name: ['WebSocket-Client']
      })
    });

/*     const cfnDeploymentGroup = deploymentGroup.node.defaultChild as codedeploy.CfnDeploymentGroup;
    cfnDeploymentGroup.addPropertyOverride('Ec2TagFilters', [
      {
        Key: 'Environment',
        Value: 'Development',
        Type: 'KEY_AND_VALUE'
      },
      {
        Key: 'Name',
        Value: 'WebSocket-Client',
        Type: 'KEY_AND_VALUE'
      }
    ]); */
    
    // Update the outputs to use the same tag constants
    new cdk.CfnOutput(this, 'DeploymentGroupTags', {
      value: JSON.stringify({
        [ENVIRONMENT_TAG.key.toLowerCase()]: ENVIRONMENT_TAG.value,
        [NAME_TAG.key.toLowerCase()]: NAME_TAG.value
      }),
      description: 'EC2 tags that deployment group looks for'
    });

    new cdk.CfnOutput(this, 'DeploymentGroupArn', {
      value: deploymentGroup.deploymentGroupArn,
      description: 'Deployment Group ARN',
    });
    
    new cdk.CfnOutput(this, 'DeploymentGroupName', {
      value: deploymentGroup.deploymentGroupName,
      description: 'Deployment Group Name',
    });

    new cdk.CfnOutput(this, 'SentinelBucketName', {
      value: this.sentinelBucket.bucketName,
      description: 'Name of the S3 bucket for deployments',
    });

    // CodeBuild Project
    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      role: buildRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
        environmentVariables: {
          SENTINEL_BUCKET: {
            value: this.sentinelBucket.bucketName,
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT
          }
        }
      },
      buildSpec: codebuild.BuildSpec.fromObjectToYaml({
        version: '0.2',
        phases: {
          pre_build: {
            commands: ['npm ci']
          },
          build: {
            commands: [
              'npm run build',
              'cp appspec.yml .',
              'cp -r scripts .',
              'cp ecosystem.config.js .',
              'cp package*.json .',
              'npm ci --production'
            ]
          },
          post_build: {
            commands: [
              'zip -qr deployment.zip appspec.yml scripts ecosystem.config.js node_modules package*.json app.js',
              'unzip -l deployment.zip'
            ]
          }
        },
        artifacts: {
          files: ['deployment.zip']
        }
      })
    });
    
    // Add the additional permissions to the build role
    buildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:PutObject',
        's3:GetObject',
        's3:ListBucket',
        'codedeploy:CreateDeployment',
        'codedeploy:GetDeployment',
        'codedeploy:GetDeploymentConfig',
        'codedeploy:RegisterApplicationRevision',
        'codedeploy:GetApplicationRevision',
        'codedeploy:GetDeploymentTarget',
        'codedeploy:ListDeployments'
      ],
      resources: [
        `${this.sentinelBucket.bucketArn}/*`,
        this.sentinelBucket.bucketArn,
        `arn:aws:codedeploy:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:deploymentgroup:GalvitronApplication/GalvitronDeploymentGroup`,
        `arn:aws:codedeploy:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:application:GalvitronApplication`,
        `arn:aws:codedeploy:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:deploymentconfig:*`
      ]
    }));

    // Pipeline Configuration
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const buildOutput = new codepipeline.Artifact('BuildOutput');

    const sourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: 'GitHub_Source',
      owner: props.githubOwner,
      repo: props.githubRepo,
      branch: props.githubBranch,
      oauthToken: cdk.SecretValue.secretsManager(props.githubTokenSecretName),
      output: sourceOutput,
      trigger: codepipeline_actions.GitHubTrigger.WEBHOOK
    });

    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'Build',
      project: buildProject,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    const deployAction = new codepipeline_actions.CodeDeployServerDeployAction({
      actionName: 'Deploy',
      input: buildOutput,
      deploymentGroup,
      // Add these configurations
      runOrder: 1,
      variablesNamespace: 'DeployVariables'
    });

    const pipeline = new codepipeline.Pipeline(this, 'DeploymentPipeline', {
      pipelineName: 'GalvitronPipeline',
      crossAccountKeys: false,
      artifactBucket: this.sentinelBucket,
      restartExecutionOnUpdate: true,
    });

    pipeline.addStage({
      stageName: 'Source',
      actions: [sourceAction]
    });

    pipeline.addStage({
      stageName: 'Build',
      actions: [buildAction]
    });

    pipeline.addStage({
      stageName: 'Deploy',
      actions: [deployAction]
    });

    const handle = new cdk.CfnWaitConditionHandle(this, 'WaitHandle');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -e',
      'set -o pipefail',
      
      // Redirect all output to log file
      'exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1',
      
      'echo "Starting user data script execution..."',
      'set -x',  // Enable verbose logging
      
      // Define error handling function
      'function error_exit() {',
      '    echo "${1:-\\"Unknown Error\\"}" 1>&2',
      '    exit 1',
      '}',
      
      // 1. System Updates and Base Packages
      'echo "Updating system packages..."',
      'yum update -y || error_exit "Failed to update system packages"',
      'yum install -y ruby wget || error_exit "Failed to install base packages"',
      
      // 2. Node.js Environment Setup
      'echo "Setting up Node.js environment..."',
      'sudo mkdir -p /home/ec2-user/.nvm',
      'sudo mkdir -p /home/ec2-user/.pm2',
      'sudo mkdir -p /home/ec2-user/app',
      'sudo chown -R ec2-user:ec2-user /home/ec2-user/.nvm',
      'sudo chown -R ec2-user:ec2-user /home/ec2-user/.pm2',
      'sudo chown -R ec2-user:ec2-user /home/ec2-user/app',
      
      // Install NVM and Node.js as ec2-user
      'sudo -u ec2-user bash << \'EOF\'',
      'export NVM_DIR="/home/ec2-user/.nvm"',
      'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash',
      'source $NVM_DIR/nvm.sh',
      'nvm install 20',
      'nvm use 20',
      'nvm alias default 20',
      '',
      '# Install global packages',
      'npm install -g pm2 yarn',
      '',
      '# Configure PM2',
      'export PM2_HOME="/home/ec2-user/.pm2"',
      'pm2 install pm2-logrotate',
      'pm2 set pm2-logrotate:max_size 10M',
      'pm2 set pm2-logrotate:retain 5',
      'pm2 set pm2-logrotate:compress true',
      'EOF',
      
      // 3. CodeDeploy Agent Installation
      'echo "Installing CodeDeploy agent..."',
      
      // Clean up any previous installation
      'echo "Installing CodeDeploy agent..."',
      'sudo systemctl stop codedeploy-agent || true',
      'sudo rm -rf /opt/codedeploy-agent',
      'sudo rm -f /etc/init.d/codedeploy-agent',
      'sudo rm -f /etc/systemd/system/codedeploy-agent.service',
      
      // Create necessary directories with proper permissions
      'sudo mkdir -p /opt/codedeploy-agent/deployment-root',
      'sudo mkdir -p /etc/codedeploy-agent/conf',
      'sudo mkdir -p /var/log/aws/codedeploy-agent',
      
      'sudo chmod 755 /opt/codedeploy-agent/deployment-root',
      'sudo chmod 755 /var/log/aws/codedeploy-agent',
      
      // Download and install agent
      'cd /home/ec2-user',
      'region=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)',
      'sudo wget "https://aws-codedeploy-${region}.s3.${region}.amazonaws.com/latest/install"',
      'sudo chmod +x ./install',
      'sudo ./install auto || error_exit "Failed to install CodeDeploy agent"',
      'sudo systemctl start codedeploy-agent',    
      
      // Run installer with verbose output
      'sudo ./install auto || error_exit "Failed to install CodeDeploy agent"',
      'sudo rm -f ./install',
      
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
      
      // Start and enable service
      'sudo systemctl daemon-reload',
      'sudo systemctl enable codedeploy-agent',
      'sudo systemctl start codedeploy-agent',
      
      // Verify service is running
      'echo "Verifying CodeDeploy agent service..."',
      'sleep 10',
      'if ! systemctl is-active --quiet codedeploy-agent; then',
      '    error_exit "CodeDeploy agent failed to start"',
      'fi',
      
      // 4. Environment Verification
      'echo "Verifying complete environment setup..."',
      
      // Verify Node.js installation
      'sudo -u ec2-user bash -c \'source $HOME/.nvm/nvm.sh && node --version\' || error_exit "Node.js not properly installed"',
      'sudo -u ec2-user bash -c \'source $HOME/.nvm/nvm.sh && npm --version\' || error_exit "NPM not properly installed"',
      'sudo -u ec2-user bash -c \'source $HOME/.nvm/nvm.sh && pm2 --version\' || error_exit "PM2 not properly installed"',
      
      // Verify CodeDeploy agent installation
      'if ! test -f /opt/codedeploy-agent/bin/codedeploy-agent; then',
      '    error_exit "CodeDeploy agent binary not found"',
      'fi',
      
      'if ! test -f /var/log/aws/codedeploy-agent/codedeploy-agent.log; then',
      '    error_exit "CodeDeploy agent log file not created"',
      'fi',
      
      // Print instance metadata for debugging
      'echo "Instance metadata:"',
      'TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
      'echo "Instance ID: $(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/instance-id)"',
      'echo "Region: $(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/placement/region)"',
      'echo "Tags:"',
      'curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/tags/instance',
      
      'echo "Setup completed successfully!"',

      'echo "Waiting for CodeDeploy agent to be fully registered..."',
      'sleep 30', // Give CodeDeploy agent time to register
      'if systemctl is-active --quiet codedeploy-agent; then',
      `  curl -X PUT -H 'Content-Type:' --data-binary '{"Status": "SUCCESS", "Reason": "CodeDeploy Agent Ready", "UniqueId": "CodeDeployAgent", "Data": "Agent Registered"}' "${handle.ref}"`,
      'else',
      `  curl -X PUT -H 'Content-Type:' --data-binary '{"Status": "FAILURE", "Reason": "CodeDeploy Agent Failed", "UniqueId": "CodeDeployAgent", "Data": "Agent Failed"}' "${handle.ref}"`,
      'fi'
    );

    
    // Create EC2 Instance
    this.instance = new ec2.Instance(this, 'EC2Instance', {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      },
      securityGroup: securityGroup,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      keyName: 'galvitron-key-2',
      role: instanceRole,
      detailedMonitoring: false,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP2,
            deleteOnTermination: true,
          }),
        },
      ],
      userData: userData,
    });

    Tags.of(this.instance).add(ENVIRONMENT_TAG.key, ENVIRONMENT_TAG.value);
    Tags.of(this.instance).add(NAME_TAG.key, NAME_TAG.value);

    const wait = new cdk.CfnWaitCondition(this, 'WaitCondition', {
      count: 1,
      handle: handle.ref,
      timeout: '300' // 5 minutes
    });

    pipeline.node.addDependency(wait);

    // Create Launch Template with metadata options and tags
    const launchTemplate = new ec2.CfnLaunchTemplate(this, 'EC2LaunchTemplate', {
      launchTemplateData: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO).toString(),
        imageId: ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId,
        userData: cdk.Fn.base64(userData.render()),
        metadataOptions: {
          httpEndpoint: 'enabled',
          httpTokens: 'optional',
          httpPutResponseHopLimit: 2,
          instanceMetadataTags: 'enabled'
        },
        tagSpecifications: [
          {
            resourceType: 'instance',
            tags: [
              { 
                key: ENVIRONMENT_TAG.key,
                value: ENVIRONMENT_TAG.value
              },
              { 
                key: NAME_TAG.key,
                value: NAME_TAG.value
              }
            ]
          }
        ]
      }
    })
    const cfnInstance = this.instance.node.defaultChild as ec2.CfnInstance;
    cfnInstance.addPropertyOverride('LaunchTemplate', {
      LaunchTemplateId: launchTemplate.ref,
      Version: launchTemplate.attrLatestVersionNumber
    });

    // Instance Configuration
    this.instance.instance.addPropertyOverride('InstanceInitiatedShutdownBehavior', 'stop');

    // Outputs
    new cdk.CfnOutput(this, 'InstancePublicIP', {
      value: this.instance.instancePublicIp,
      description: 'Public IP address of the EC2 instance',
    });

    new cdk.CfnOutput(this, 'SSHCommand', {
      value: `ssh -i ~/.ssh/galvitron-key-2 ec2-user@${this.instance.instancePublicIp}`,
      description: 'Command to SSH into the instance',
    });

    new cdk.CfnOutput(this, 'PipelineArn', {
      value: pipeline.pipelineArn,
      description: 'Pipeline ARN',
    });
  }
}