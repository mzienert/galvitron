import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface EC2ConstructProps {
  vpc: ec2.IVpc;
  instanceType?: ec2.InstanceType;
  keyName: string;
  userData: ec2.UserData;
  role: iam.IRole;
  tags?: { [key: string]: string };
}

export class EC2Construct extends Construct {
  public readonly instance: ec2.Instance;
  public readonly securityGroup: ec2.SecurityGroup;
  private readonly launchTemplate: ec2.CfnLaunchTemplate;

  constructor(scope: Construct, id: string, props: EC2ConstructProps) {
    super(scope, id);

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: 'Security group with WebSocket support',
      allowAllOutbound: true,
    });

    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow SSH access'
    );

    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP/WebSocket access'
    );

    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS/Secure WebSocket access'
    );

    // Create Launch Template
    this.launchTemplate = new ec2.CfnLaunchTemplate(this, 'EC2LaunchTemplate', {
      launchTemplateData: {
        instanceType: (props.instanceType || ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO)).toString(),
        imageId: ec2.MachineImage.latestAmazonLinux2023().getImage(scope).imageId,
        userData: cdk.Fn.base64(props.userData.render()),
        metadataOptions: {
          httpEndpoint: 'enabled',
          httpTokens: 'optional',
          httpPutResponseHopLimit: 2,
          instanceMetadataTags: 'enabled'
        },
        tagSpecifications: [
          {
            resourceType: 'instance',
            tags: Object.entries(props.tags || {}).map(([key, value]) => ({
              key,
              value
            }))
          }
        ]
      }
    });

    // Create EC2 Instance
    this.instance = new ec2.Instance(this, 'Instance', {
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      },
      securityGroup: this.securityGroup,
      instanceType: props.instanceType || ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      keyName: props.keyName,
      role: props.role,
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
      userData: props.userData,
    });

    // Override instance properties to use launch template
    const cfnInstance = this.instance.node.defaultChild as ec2.CfnInstance;
    cfnInstance.addPropertyOverride('LaunchTemplate', {
      LaunchTemplateId: this.launchTemplate.ref,
      Version: this.launchTemplate.attrLatestVersionNumber
    });
    cfnInstance.addPropertyOverride('InstanceInitiatedShutdownBehavior', 'stop');

    if (props.tags) {
      Object.entries(props.tags).forEach(([key, value]) => {
        cdk.Tags.of(this.instance).add(key, value);
      });
    }
  }
}