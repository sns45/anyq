package sqs

import (
	"context"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// NewClient constructs an SQS client from the connection config. It is exported
// for callers (e.g. test apps) that need a raw client for administrative
// operations such as CreateQueue. Region defaults to us-east-1 when empty.
func NewClient(ctx context.Context, conn ConnectionConfig) (*sqs.Client, error) {
	region := conn.Region
	if region == "" {
		region = "us-east-1"
	}
	return buildClient(ctx, conn, region)
}

// buildClient constructs an SQS client from the connection config, applying a
// custom endpoint and static credentials when supplied (mirrors the TS client
// construction). When credentials are omitted, the default AWS credential chain
// is used.
func buildClient(ctx context.Context, conn ConnectionConfig, region string) (*sqs.Client, error) {
	loadOpts := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion(region),
	}
	if conn.AccessKeyID != "" && conn.SecretAccessKey != "" {
		loadOpts = append(loadOpts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(conn.AccessKeyID, conn.SecretAccessKey, ""),
		))
	}

	cfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, err
	}

	var sqsOpts []func(*sqs.Options)
	if conn.Endpoint != "" {
		endpoint := conn.Endpoint
		sqsOpts = append(sqsOpts, func(o *sqs.Options) {
			o.BaseEndpoint = &endpoint
		})
	}

	return sqs.NewFromConfig(cfg, sqsOpts...), nil
}
