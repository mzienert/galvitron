import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface CodePipelineConstructProps {
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  githubTokenSecretName: string;
  artifactBucket: s3.IBucket;
  buildProject: codebuild.PipelineProject;
  deploymentGroup: codedeploy.IServerDeploymentGroup;
}

export class CodePipelineConstruct extends Construct {
  public readonly pipeline: codepipeline.Pipeline;

  constructor(scope: Construct, id: string, props: CodePipelineConstructProps) {
    super(scope, id);

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
      project: props.buildProject,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    const deployAction = new codepipeline_actions.CodeDeployServerDeployAction({
      actionName: 'Deploy',
      input: buildOutput,
      deploymentGroup: props.deploymentGroup,
      runOrder: 1,
      variablesNamespace: 'DeployVariables'
    });

    this.pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'GalvitronPipeline',
      crossAccountKeys: false,
      artifactBucket: props.artifactBucket,
      restartExecutionOnUpdate: true,
    });

    this.pipeline.addStage({
      stageName: 'Source',
      actions: [sourceAction]
    });

    this.pipeline.addStage({
      stageName: 'Build',
      actions: [buildAction]
    });

    this.pipeline.addStage({
      stageName: 'Deploy',
      actions: [deployAction]
    });
  }
}