import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface DynamoDBConstructProps {
  tableName?: string;
  partitionKey?: string;
  timeToLiveAttribute?: string;
}

export class DynamoDBConstruct extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DynamoDBConstructProps = {}) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'Table', {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { 
        name: props.partitionKey || 'id', 
        type: dynamodb.AttributeType.STRING 
      },
      pointInTimeRecovery: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      timeToLiveAttribute: props.timeToLiveAttribute || 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      tableName: props.tableName
    });
  }
}