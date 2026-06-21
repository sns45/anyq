#!/bin/bash

# Create the orders queue used by the SQS tester.
awslocal sqs create-queue --queue-name orders

echo "SQS queue 'orders' created successfully!"
