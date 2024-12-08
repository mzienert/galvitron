import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface VPCConstructProps {
  maxAzs?: number;
  natGateways?: number;
}

export class VPCConstruct extends Construct {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: VPCConstructProps = {}) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: props.maxAzs || 1,
      natGateways: props.natGateways || 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        }
      ],
      flowLogs: {},
    });
  }
}