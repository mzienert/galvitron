// lib/constructs/pipeline/nextjs-pipeline-construct.ts
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { Construct } from 'constructs';

export interface NextJSPipelineConstructProps {
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  githubTokenSecretName: string;
}

export class NextJSPipelineConstruct extends Construct {
  public readonly pipeline: codepipeline.Pipeline;
  public readonly websiteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: NextJSPipelineConstructProps) {
    super(scope, id);

    // Create S3 bucket for the website
    this.websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: '404.html',
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    });

    // Create CloudFront distribution first so we can use its ID in the build project
    this.distribution = new cloudfront.Distribution(this, 'WebsiteDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(this.websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        cachePolicy: new cloudfront.CachePolicy(this, 'WebsiteCachePolicy', {
          minTtl: cdk.Duration.seconds(0),
          maxTtl: cdk.Duration.days(365),
          defaultTtl: cdk.Duration.hours(24),
          enableAcceptEncodingBrotli: true,
          enableAcceptEncodingGzip: true,
        }),
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
        },
      ],
    });

    // Create build project with invalidation step
    const buildProject = new codebuild.PipelineProject(this, 'NextJSBuild', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
        environmentVariables: {
          CLOUDFRONT_DISTRIBUTION_ID: {
            value: this.distribution.distributionId,
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          },
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'n 20',
              'npm ci --force'
            ]
          },
          build: {
            commands: [
              'echo "Building Next.js application..."',
              'npm run build',
              'ls -la',
              'ls -la .next/'
            ]
          },
          post_build: {
            commands: [
              'echo "Setting cache control headers..."',
              'cd .next',
              'aws s3 sync . s3://${WEBSITE_BUCKET} --delete --cache-control "public, max-age=31536000, immutable"',
              'cd ../public',
              'aws s3 sync . s3://${WEBSITE_BUCKET} --cache-control "public, max-age=31536000, immutable"',
              // Create CloudFront invalidation
              'echo "Creating CloudFront invalidation..."',
              'aws cloudfront create-invalidation --distribution-id ${CLOUDFRONT_DISTRIBUTION_ID} --paths "/*"',
            ]
          }
        },
        artifacts: {
          'base-directory': 'out',
          files: [
            '**/*'
          ]
        },
        cache: {
          paths: [
            'node_modules/**/*'
          ]
        }
      })
    });

    // Grant necessary permissions to the build project
    buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation'],
      resources: [`arn:aws:cloudfront::${cdk.Stack.of(this).account}:distribution/${this.distribution.distributionId}`],
    }));

    // Create artifacts
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const buildOutput = new codepipeline.Artifact('BuildOutput');

    // Grant build project permissions to write to S3
    this.websiteBucket.grantReadWrite(buildProject);

    // Create the pipeline
    this.pipeline = new codepipeline.Pipeline(this, 'NextJSPipeline', {
      pipelineName: 'NextJSWebsitePipeline',
      crossAccountKeys: false,
      restartExecutionOnUpdate: true,
    });

    // Add source stage
    this.pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.GitHubSourceAction({
          actionName: 'GitHub_Source',
          owner: props.githubOwner,
          repo: props.githubRepo,
          branch: props.githubBranch,
          oauthToken: cdk.SecretValue.secretsManager(props.githubTokenSecretName),
          output: sourceOutput,
          trigger: codepipeline_actions.GitHubTrigger.POLL
        }),
      ],
    });

    // Add build stage
    this.pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Build',
          project: buildProject,
          input: sourceOutput,
          outputs: [buildOutput],
          environmentVariables: {
            WEBSITE_BUCKET: {
              value: this.websiteBucket.bucketName,
            },
          },
        }),
      ],
    });

    // Add deploy stage with invalidation
    this.pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new codepipeline_actions.S3DeployAction({
          actionName: 'Deploy',
          input: buildOutput,
          bucket: this.websiteBucket,
          extract: true,
        }),
      ],
    });

    // Add outputs
    new cdk.CfnOutput(this, 'WebsiteURL', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Website URL',
    });

    new cdk.CfnOutput(this, 'WebsiteBucketName', {
      value: this.websiteBucket.bucketName,
      description: 'Website bucket name',
    });
  }
}