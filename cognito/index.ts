import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface CognitoPoolProps {
  readonly stage: string;
}

export class CognitoPool extends Construct {
  constructor(scope: Construct, id: string, props: CognitoPoolProps) {
    super(scope, id);

      const cognitoPool = new cognito.UserPool(this, 'CognitoPool', {
      userPoolName: `${props.stage}-CognitoPool`,
      selfSignUpEnabled: true,
      signInCaseSensitive: false,
      signInAliases: {
        email: true,
        phone: true,
      },
      autoVerify: {
        email: true,
      },
      userVerification: {
        emailSubject: 'Hello from My Cool App!',
        emailBody: 'Hello, Thanks for registering in My cool app! Verification code is {####}.',
        emailStyle: cognito.VerificationEmailStyle.CODE
      },
      standardAttributes: {
        fullname: {
          required: true,
          mutable: true,
        },
        email: {
          required: true,
          mutable: true,
        }
      },
      customAttributes: {
        company: new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_AND_PHONE_WITHOUT_MFA,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const client = cognitoPool.addClient('MyAppClient', {
        userPoolClientName: 'MyAppClient',
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [cognito.OAuthScope.OPENID],
          callbackUrls: ["https://bellerustica.com"]
        },
        supportedIdentityProviders: [
          cognito.UserPoolClientIdentityProvider.COGNITO,
        ],
        refreshTokenValidity: Duration.minutes(60),
        idTokenValidity: Duration.minutes(30),
        accessTokenValidity: Duration.minutes(30),
    });
  }
}